// Persistent background worker, hosted in an Electron utilityProcess (src/main/workerBridge.js
// forks this file). Runs a tick loop that, only within the configured schedule window: polls
// import folders for new documents (Responsibility A) and advances the existing-vault backfill
// up to BACKFILL_ITEMS_PER_TICK items, strictly one after another (Responsibility B). Also
// handles on-demand messages from the main process (pause/resume + settings changes, analyze-vault).
const { WORKER_TICK_INTERVAL_MS, BACKFILL_ITEMS_PER_TICK } = require('../shared/constants');
const db = require('./db');
const { isWorkerAllowedToRunNow } = require('./scheduler');
const { pollAllVaults } = require('./importPoller');
const { analyzeVaultTags } = require('./vaultAnalyzer');
const { findBacklog, processBacklogItem, runBackfillForVault } = require('./backfillScanner');
const { sweepOrphansForVault } = require('./orphanSweeper');

let lastImportPollAtMs = 0;
let tickInFlight = false;
const backfillQueues = new Map(); // vaultId -> cached pending backlog items
let backfillVaultCursor = 0;

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

    if (Date.now() - lastImportPollAtMs >= settings.importPollIntervalSeconds * 1000) {
      lastImportPollAtMs = Date.now();
      const results = await pollAllVaults();
      const totalProcessed = results.reduce((sum, r) => sum + r.processed, 0);
      if (totalProcessed > 0) postEvent({ type: 'statsChanged', reason: 'import-poll' });
    }

    const backfillResults = await processBackfillBatchAcrossVaults(vaults, settings);
    if (backfillResults.some((r) => !r.skipped)) {
      postEvent({ type: 'statsChanged', reason: 'backfill' });
    }
  } catch (err) {
    console.error('[worker] tick failed:', err);
  } finally {
    tickInFlight = false;
  }
}

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
    }
    return;
  }

  console.log('[worker] received message', data);
});

console.log('[worker] started');
setInterval(tick, WORKER_TICK_INTERVAL_MS);
tick();
