const path = require('path');
const { utilityProcess } = require('electron');

const WORKER_ENTRY = path.join(__dirname, '..', 'worker', 'index.js');
const MAX_RESPAWN_ATTEMPTS = 5;
const RESPAWN_BACKOFF_MS = 3000;

/**
 * Owns the lifecycle of the persistent background worker, hosted in an Electron
 * utilityProcess (a long-lived Node-only helper process — no Chromium/renderer
 * overhead, and it can't accidentally be shown/closed like a hidden BrowserWindow).
 * Respawns the worker with a capped backoff if it exits unexpectedly (i.e. not via
 * an explicit shutdown() call from us).
 */
class WorkerBridge {
  constructor() {
    this.child = null;
    this.shuttingDown = false;
    this.respawnAttempts = 0;
    this.eventListeners = [];
  }

  start() {
    this.child = utilityProcess.fork(WORKER_ENTRY, [], {
      serviceName: 'obsidian-importer-worker',
      stdio: 'pipe',
    });

    this.child.on('message', (message) => {
      for (const listener of this.eventListeners) listener(message);
    });

    this.child.stdout?.on('data', (chunk) => process.stdout.write(`[worker] ${chunk}`));
    this.child.stderr?.on('data', (chunk) => process.stderr.write(`[worker:err] ${chunk}`));

    this.child.on('exit', (code) => {
      console.log(`[main] worker exited with code ${code}`);
      this.child = null;
      if (this.shuttingDown) return;
      if (this.respawnAttempts >= MAX_RESPAWN_ATTEMPTS) {
        console.error('[main] worker exceeded max respawn attempts, giving up');
        return;
      }
      this.respawnAttempts += 1;
      setTimeout(() => this.start(), RESPAWN_BACKOFF_MS * this.respawnAttempts);
    });
  }

  postMessage(message) {
    if (!this.child) return;
    this.child.postMessage(message);
  }

  onEvent(listener) {
    this.eventListeners.push(listener);
  }

  shutdown() {
    this.shuttingDown = true;
    if (this.child) {
      this.postMessage({ type: 'shutdown' });
      this.child.kill();
      this.child = null;
    }
  }

  // For a deliberate stop-and-relaunch (e.g. swapping out app.db during a database import)
  // rather than a permanent shutdown() — resets the "shutting down" flag and retry counter so
  // the respawned worker's own crash-recovery behaves normally afterwards, and clears
  // `shuttingDown` before start() so a mid-swap crash doesn't get misread as us still stopping.
  restart() {
    this.shutdown();
    this.shuttingDown = false;
    this.respawnAttempts = 0;
    this.start();
  }
}

module.exports = { WorkerBridge };
