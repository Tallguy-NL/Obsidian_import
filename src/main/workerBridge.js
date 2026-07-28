const path = require('path');
const fs = require('fs');
const { utilityProcess } = require('electron');
const { resolveUserDataPath } = require('../shared/userDataPath');
const { HEARTBEAT_INTERVAL_MS, MAX_TICK_DURATION_MS } = require('../shared/constants');

const WORKER_ENTRY = path.join(__dirname, '..', 'worker', 'index.js');
const MAX_RESPAWN_ATTEMPTS = 5;
const RESPAWN_BACKOFF_MS = 3000;
// The worker posts a heartbeat this often (see worker/index.js); checked independently of any
// tick actually completing, since a stuck backfill item can legitimately take minutes. This
// interval firing at all is itself the signal — a real hang blocks the worker's whole JS event
// loop, which starves every timer in that process, this one included.
const HEARTBEAT_CHECK_INTERVAL_MS = HEARTBEAT_INTERVAL_MS;
// Generous multiple of the worker's own heartbeat interval to absorb scheduling jitter/GC
// pauses without false-positiving on a worker that's merely busy, not wedged.
const HEARTBEAT_STALE_THRESHOLD_MS = HEARTBEAT_INTERVAL_MS * 6;
const MAX_WATCHDOG_RESTARTS = 3;
const WORKER_LOG_PATH = path.join(resolveUserDataPath(), 'worker.log');
// How long shutdown() waits for the worker's own graceful exit (triggered by the 'shutdown'
// message below) before force-killing it. Without this, kill() races the message: sent first,
// but kill() runs synchronously right after with nothing to make it wait its turn, so it usually
// wins before the worker's event loop gets a chance to act on the message. That matters because
// only a graceful process.exit(0) runs worker/index.js's process.on('exit') handler — the one
// that kills the OCR/PDF child processes it forked. A signal with no handler for it (what kill()
// sends) skips 'exit' entirely, silently leaking those children on every watchdog restart. Short
// enough not to meaningfully delay app quit/restart; long enough for a healthy event loop (which
// this is, for every case except the one it's truly wedged) to process one message.
const SHUTDOWN_GRACE_MS = 2000;

/**
 * Owns the lifecycle of the persistent background worker, hosted in an Electron
 * utilityProcess (a long-lived Node-only helper process — no Chromium/renderer
 * overhead, and it can't accidentally be shown/closed like a hidden BrowserWindow).
 * Respawns the worker with a capped backoff if it exits unexpectedly (i.e. not via
 * an explicit shutdown() call from us), and separately restarts it if it's still alive but
 * either stopped heartbeating, or is heartbeating fine while stuck on a single tick that's
 * been running far longer than any legitimate one would (see checkHeartbeat()).
 */
class WorkerBridge {
  constructor() {
    this.child = null;
    this.shuttingDown = false;
    this.respawnAttempts = 0;
    this.watchdogRestartAttempts = 0;
    this.watchdogInterval = null;
    this.lastHeartbeatAt = null;
    this.tickStartedAt = null;
    this.logStream = null;
    this.eventListeners = [];
    // Last known "now processing" snapshot, kept here (not just forwarded) so a renderer that
    // loads/reloads mid-flight can ask for the current state instead of waiting for the next
    // start/finish event, which might not fire for a while if nothing changes.
    this.lastProcessingStatus = { items: [] };
  }

  start() {
    // A hang like the one this watchdog exists to catch leaves nothing running to have logged
    // it anywhere useful — stdout otherwise only goes to the terminal (or /dev/null when
    // launched from Finder/Dock). Appended, not truncated, so a restart doesn't erase the very
    // evidence of why it restarted. mkdir first — userData may not exist yet on a fresh install,
    // and createWriteStream's async 'error' would otherwise crash the main process.
    fs.mkdirSync(path.dirname(WORKER_LOG_PATH), { recursive: true });
    this.logStream = fs.createWriteStream(WORKER_LOG_PATH, { flags: 'a' });

    const proc = utilityProcess.fork(WORKER_ENTRY, [], {
      serviceName: 'obsidian-importer-worker',
      stdio: 'pipe',
    });
    this.child = proc;

    // Grace period before the first real heartbeat arrives, so a slow startup isn't immediately
    // mistaken for a hang. tickStartedAt resets too — a previous child's in-flight tick is
    // meaningless once that process is gone.
    this.lastHeartbeatAt = Date.now();
    this.tickStartedAt = null;

    proc.on('message', (message) => {
      if (message?.type === 'heartbeat') {
        this.lastHeartbeatAt = message.at;
        this.tickStartedAt = message.tickStartedAt;
        // watchdogRestartAttempts is deliberately NOT reset here — a stuck-tick hang still
        // heartbeats normally every HEARTBEAT_INTERVAL_MS (see MAX_TICK_DURATION_MS's comment),
        // so resetting on every heartbeat would let checkHeartbeat() restart the same wedged
        // worker forever instead of ever hitting MAX_WATCHDOG_RESTARTS. It's reset instead in
        // checkHeartbeat() itself, only once both checks are actually healthy.
        return;
      }
      if (message?.type === 'processingStatusChanged') {
        this.lastProcessingStatus = { items: message.items };
      }
      for (const listener of this.eventListeners) listener(message);
    });

    proc.stdout?.on('data', (chunk) => {
      process.stdout.write(`[worker] ${chunk}`);
      this.logStream?.write(chunk);
    });
    proc.stderr?.on('data', (chunk) => {
      process.stderr.write(`[worker:err] ${chunk}`);
      this.logStream?.write(chunk);
    });

    proc.on('exit', (code) => {
      console.log(`[main] worker exited with code ${code}`);
      // `this.child` may already point at a *different*, newer child by the time this fires —
      // exit is reaped asynchronously, so a restart() (shutdown() -> kill() -> start()) racing
      // ahead of this event would otherwise have this handler null out the new child and fork a
      // second one on top of it, leaving two workers ticking the same database concurrently.
      if (this.child !== proc) return;
      this.child = null;
      this.lastProcessingStatus = { items: [] }; // a dead worker has nothing in flight
      if (this.shuttingDown) return;
      if (this.respawnAttempts >= MAX_RESPAWN_ATTEMPTS) {
        console.error('[main] worker exceeded max respawn attempts, giving up');
        return;
      }
      this.respawnAttempts += 1;
      this.closeLogStream();
      setTimeout(() => this.start(), RESPAWN_BACKOFF_MS * this.respawnAttempts);
    });

    if (this.watchdogInterval) clearInterval(this.watchdogInterval);
    this.watchdogInterval = setInterval(() => this.checkHeartbeat(), HEARTBEAT_CHECK_INTERVAL_MS);
  }

  // Catches two distinct failure modes a per-file timeout can't:
  //  1. The worker process is still alive (so `exit` never fires and the respawn-on-exit path
  //     above never triggers) but its single JS thread is wedged on something with no timeout of
  //     its own — an unguarded synchronous call, or an async one nothing raced against a
  //     deadline. The heartbeat itself goes stale, since nothing in that process can run at all.
  //  2. The event loop is fine and heartbeats keep arriving right on schedule, but the *current
  //     tick* has been running far longer than any legitimate tick would (see
  //     MAX_TICK_DURATION_MS) — e.g. a full vault rescan stuck on an await with no deadline of
  //     its own. This is the one a stale-heartbeat check alone can't see, because the very thing
  //     proving the process isn't wedged (the heartbeat) is what made this failure mode look
  //     healthy for two-plus hours in production.
  // Restarting the whole utilityProcess is a blunter recovery than the file-level timeouts
  // elsewhere, but it's the only one that still works when the hang is in code those timeouts
  // don't cover.
  checkHeartbeat() {
    if (this.shuttingDown || !this.child) return;
    const staleFor = Date.now() - this.lastHeartbeatAt;
    const heartbeatStale = staleFor >= HEARTBEAT_STALE_THRESHOLD_MS;
    const tickDuration = this.tickStartedAt ? Date.now() - this.tickStartedAt : 0;
    const tickStuck = tickDuration >= MAX_TICK_DURATION_MS;
    if (!heartbeatStale && !tickStuck) {
      this.watchdogRestartAttempts = 0; // both checks healthy — a genuine recovery, not just a lull
      return;
    }
    if (this.watchdogRestartAttempts >= MAX_WATCHDOG_RESTARTS) {
      const reason = heartbeatStale ? `heartbeat stale for ${staleFor}ms` : `tick running for ${tickDuration}ms`;
      this.logWatchdogEvent(`worker ${reason} but max watchdog restarts reached, giving up`);
      return;
    }
    this.watchdogRestartAttempts += 1;
    const reason = heartbeatStale ? `heartbeat stale for ${staleFor}ms` : `tick stuck for ${tickDuration}ms`;
    this.logWatchdogEvent(`worker ${reason} — restarting wedged worker (attempt ${this.watchdogRestartAttempts}/${MAX_WATCHDOG_RESTARTS})`);
    this.restart();
  }

  postMessage(message) {
    if (!this.child) return;
    this.child.postMessage(message);
  }

  onEvent(listener) {
    this.eventListeners.push(listener);
  }

  getProcessingStatus() {
    return this.lastProcessingStatus;
  }

  closeLogStream() {
    if (!this.logStream) return;
    this.logStream.end();
    this.logStream = null;
  }

  // The only record of a watchdog firing when the app was launched from Finder/Dock — main
  // process console output goes nowhere in that case (no terminal attached), unlike the worker's
  // own stdout/stderr, which this.logStream already captures. Written here too so the next
  // occurrence leaves proof of *why* it restarted, not just that the worker process changed.
  logWatchdogEvent(message) {
    console.error(message);
    this.logStream?.write(`[main] ${message}\n`);
  }

  shutdown() {
    this.shuttingDown = true;
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
      this.watchdogInterval = null;
    }
    if (this.child) {
      const proc = this.child;
      // Captured locally, and this.logStream nulled out immediately, rather than closing
      // through `this` when the grace timer/exit handler below eventually fires — restart()
      // calls start() right after this returns, which assigns a *new* this.logStream for the
      // new child well before this old one's grace period is up. Closing through `this` at that
      // point would close the new worker's log stream instead of this old one's.
      const logStream = this.logStream;
      this.child = null;
      this.logStream = null;
      const closeOldLogStream = () => logStream?.end();
      // Graceful path first (see SHUTDOWN_GRACE_MS) so worker/index.js's process.on('exit')
      // handler gets a chance to kill the OCR/PDF children it forked, instead of leaking them —
      // still falls back to a forceful kill() after the grace window in case the worker really
      // is wedged and never processes the message at all.
      proc.postMessage({ type: 'shutdown' });
      const forceKillTimer = setTimeout(() => {
        proc.kill();
        closeOldLogStream();
      }, SHUTDOWN_GRACE_MS);
      proc.once('exit', () => {
        clearTimeout(forceKillTimer);
        closeOldLogStream();
      });
      return;
    }
    this.closeLogStream();
  }

  // For a deliberate stop-and-relaunch (e.g. swapping out app.db during a database import, or
  // this watchdog recovering a wedged worker) rather than a permanent shutdown() — resets the
  // "shutting down" flag and retry counter so the respawned worker's own crash-recovery behaves
  // normally afterwards, and clears `shuttingDown` before start() so a mid-swap crash doesn't
  // get misread as us still stopping.
  restart() {
    this.shutdown();
    this.shuttingDown = false;
    this.respawnAttempts = 0;
    this.start();
  }
}

module.exports = { WorkerBridge };
