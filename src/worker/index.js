// Persistent background worker, hosted in an Electron utilityProcess (src/main/workerBridge.js
// forks this file). Runs a tick loop that, only within the configured schedule window: polls
// import folders for new documents (Responsibility A) and advances the existing-vault backfill
// up to BACKFILL_ITEMS_PER_TICK items, strictly one after another (Responsibility B). Also
// handles on-demand messages from the main process (pause/resume + settings changes, analyze-vault).
const { WORKER_TICK_INTERVAL_MS, BACKFILL_ITEMS_PER_TICK, HEARTBEAT_INTERVAL_MS } = require('../shared/constants');
const db = require('./db');
const { isWorkerAllowedToRunNow } = require('./scheduler');
const { pollAllVaults } = require('./importPoller');
const { analyzeVaultTags } = require('./vaultAnalyzer');
const { findBacklog, processBacklogItem, runBackfillForVault } = require('./backfillScanner');
const { sweepOrphansForVault } = require('./orphanSweeper');
const { terminateOcrWorker } = require('./pipeline/ocrEngine');
const { terminatePdfWorker } = require('./pipeline/pdfExtractor');

let tickInFlight = false;
const backfillQueues = new Map(); // vaultId -> cached pending backlog items
let backfillVaultCursor = 0;

// Tracks every long-running operation currently in flight — both tick() and the on-demand
// 'analyze-vault' handler (its own unbounded runBackfillForVault() loop over up to 10,000 items
// is exactly the same "no overall deadline" shape as tick()'s backlog scan, and the two can run
// concurrently) — so the heartbeat below can report how long the *oldest* one has been running.
// A Map keyed by an opaque id rather than a single shared variable: two operations overlapping
// and naively sharing one "started at" value would let the second one finish, clear it, and make
// the main process blind to the first one still being stuck.
const activeOperations = new Map(); // opId -> startedAt
let nextOpId = 1;

function beginOperation() {
  const id = nextOpId;
  nextOpId += 1;
  activeOperations.set(id, Date.now());
  return id;
}

function endOperation(id) {
  activeOperations.delete(id);
}

// Read by the heartbeat below so the main process can tell legitimately-running work apart from
// work that's stopped making progress — see MAX_TICK_DURATION_MS's comment.
function oldestOperationStartedAt() {
  let oldest = null;
  for (const startedAt of activeOperations.values()) {
    if (oldest === null || startedAt < oldest) oldest = startedAt;
  }
  return oldest;
}

function postEvent(message) {
  process.parentPort.postMessage(message);
}

async function processOneBackfillItemAcrossVaults(vaults, settings) {
  if (vaults.length === 0) return null;
  for (let i = 0; i < vaults.length; i += 1) {
    const idx = (backfillVaultCursor + i) % vaults.length;
    const vault = vaults[idx];
    let queue = backfillQueues.get(vault.id);
    if (!queue || queue.length === 0) {
      queue = await findBacklog(vault); // cheap (markdown-only) until it actually finds work
      backfillQueues.set(vault.id, queue);
    }
    if (queue.length === 0) continue;
    const item = queue.shift();
    const result = await processBacklogItem(vault, item, settings);
    backfillVaultCursor = (idx + 1) % vaults.length;
    return { vaultId: vault.id, ...result };
  }
  return null;
}

/**
 * Processes up to BACKFILL_ITEMS_PER_TICK backlog items per tick, one fully after another
 * (never in parallel — each await completes before the next item starts, same as before this
 * was more than 1). Stops early once nothing's left across any vault. Raising the per-tick
 * count (rather than shortening the tick interval) is what actually buys throughput: a single
 * fast item previously left most of the 20s tick idle before the next one was even looked at.
 */
async function processBackfillBatchAcrossVaults(vaults, settings) {
  const results = [];
  for (let i = 0; i < BACKFILL_ITEMS_PER_TICK; i += 1) {
    const result = await processOneBackfillItemAcrossVaults(vaults, settings);
    if (!result) break;
    results.push(result);
  }
  return results;
}

async function tick() {
  if (tickInFlight) return; // an earlier tick (e.g. a slow OCR job) is still running
  tickInFlight = true;
  const opId = beginOperation();
  try {
    const settings = db.getSettings();
    if (settings.workerPaused) return;
    if (!isWorkerAllowedToRunNow(settings)) return;

    const vaults = db.listEnabledVaults();

    let orphansDeleted = false;
    for (const vault of vaults) {
      const sweepResult = await sweepOrphansForVault(vault);
      if (sweepResult.deleted > 0) orphansDeleted = true;
    }
    if (orphansDeleted) postEvent({ type: 'statsChanged', reason: 'orphan-sweep' });

    // Checked every tick (a no-op readdir per vault when the import folder is empty), rather
    // than gated behind importPollIntervalSeconds, so new documents are never left waiting
    // behind existing-vault backfill work that happened to already be running.
    const importResults = await pollAllVaults();
    const totalImported = importResults.reduce((sum, r) => sum + r.processed, 0);
    if (totalImported > 0) postEvent({ type: 'statsChanged', reason: 'import-poll' });

    // New documents always take priority over the existing-vault backlog: only spend this
    // tick on backfill once the import folders had nothing left to process.
    if (totalImported === 0) {
      const backfillResults = await processBackfillBatchAcrossVaults(vaults, settings);
      if (backfillResults.some((r) => !r.skipped)) {
        postEvent({ type: 'statsChanged', reason: 'backfill' });
      }
    }
  } catch (err) {
    console.error('[worker] tick failed:', err);
  } finally {
    tickInFlight = false;
    endOperation(opId);
  }
}

// Neither the OCR nor the PDF-extraction child is killed by this process exiting on its own —
// process.exit() (below) and an external kill() from workerBridge.js both just orphan them
// (reparented to PID 1), left running forever with no timeout left to ever catch them since the
// thing that owned that timeout is gone. Every app restart was silently leaking one OCR child,
// one PDF-extraction child, and that PDF child's own nested OCR grandchild. Registered on
// `process.on('exit')` (rather than only in the 'shutdown' handler below) so it also runs on a
// crash or an external kill(), not just a graceful shutdown message.
process.on('exit', () => {
  terminateOcrWorker();
  terminatePdfWorker();
});

process.parentPort.on('message', async ({ data }) => {
  if (data?.type === 'shutdown') {
    process.exit(0);
    return;
  }

  if (data?.type === 'settings-changed') {
    backfillQueues.clear(); // vaults/settings may have changed shape — force a fresh scan
    tick();
    return;
  }

  if (data?.type === 'analyze-vault') {
    // Its own runBackfillForVault() loop (up to 10,000 items, each re-running findBacklog())
    // has exactly the same "no overall deadline" shape as tick()'s backlog scan — tracked here
    // too so a stuck "Analyze now" is caught by the same watchdog instead of running invisibly.
    const opId = beginOperation();
    try {
      const tagResult = await analyzeVaultTags(data.vaultId);
      const vault = db.getVault(data.vaultId);
      const settings = db.getSettings();
      const backfillResult = vault ? await runBackfillForVault(vault, settings) : { processed: 0 };
      backfillQueues.delete(data.vaultId); // that vault's backlog just changed shape
      postEvent({
        type: 'analyze-vault-result',
        vaultId: data.vaultId,
        result: { ...tagResult, backfilled: backfillResult.processed },
      });
      postEvent({ type: 'statsChanged', reason: 'analyze-vault' });
    } catch (err) {
      postEvent({ type: 'analyze-vault-error', vaultId: data.vaultId, error: String(err) });
    } finally {
      endOperation(opId);
    }
    return;
  }

  console.log('[worker] received message', data);
});

console.log('[worker] started');
setInterval(tick, WORKER_TICK_INTERVAL_MS);
tick();

// Firing is independent of tick()/tickInFlight on purpose — see workerBridge.js's
// checkHeartbeat(). Stuck work must not stop this from firing (it's the thing that tells the
// main process the worker's JS event loop itself isn't wedged), which is why it's its own
// setInterval rather than something posted from inside tick()/the analyze-vault handler. It does
// carry the oldest in-flight operation's start time, though — heartbeat-alive is necessary but
// not sufficient, since work stuck on an unguarded/undeadlined await (no in-process timeout ever
// fires) would keep this timer firing forever while making zero real progress. Reporting it lets
// the main process restart the worker once something has run implausibly long, independent of
// whether heartbeats are still arriving.
setInterval(() => postEvent({
  type: 'heartbeat', at: Date.now(), tickStartedAt: oldestOperationStartedAt(),
}), HEARTBEAT_INTERVAL_MS);
