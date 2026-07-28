const fs = require('fs');
const db = require('./db');
const { nowUtcIso } = require('../shared/time');
const { withTimeout } = require('./pipeline/withTimeout');
const { FILE_IO_TIMEOUT_MS } = require('../shared/constants');

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day per vault

// fs.existsSync is synchronous — on a normal local disk that's fine, but on a stalled sync
// drive (iCloud Drive/OneDrive) a stat() can block the whole Node event loop indefinitely, and
// unlike every async fs call elsewhere in the pipeline, no setTimeout-based withTimeout race can
// ever preempt a synchronous call already in flight. Doing this check async + raced against a
// deadline instead means a stalled path degrades to "skip this doc, retry next sweep" rather
// than freezing the entire worker tick loop forever. A timeout is deliberately NOT treated as
// "note is gone" — that would risk flagging/deleting a document whose note is merely
// unreachable right now, defeating the two-consecutive-sweeps safety margin below.
async function noteFileState(notePath) {
  const accessPromise = fs.promises.access(notePath);
  accessPromise.catch(() => {});
  try {
    await withTimeout(accessPromise, FILE_IO_TIMEOUT_MS, `sweepOrphans access ${notePath}`);
    return 'exists';
  } catch (err) {
    return String(err.message).startsWith('Timed out') ? 'unknown' : 'missing';
  }
}

/**
 * Detects documents whose note has been deleted from the vault by the user, and removes their
 * now-meaningless bookkeeping row — otherwise a document marked "already processed" blocks the
 * same source file from ever being reprocessed if it's re-added later (importPoller short-
 * circuits on `UNIQUE(vault_id, original_path)` whenever status_code isn't PENDING).
 *
 * Runs at most once per day per vault (tracked via backfill_cursor.last_orphan_sweep_at_utc),
 * and requires a document to be seen missing on two separate daily sweeps before deleting it —
 * a single day's absence could just be a sync gap (this vault lives on iCloud Drive) rather than
 * a real deletion. A document that reappears between sweeps has its flag cleared.
 */
async function sweepOrphansForVault(vault) {
  const cursor = db.getBackfillCursor(vault.id);
  const lastSweep = cursor?.last_orphan_sweep_at_utc;
  if (lastSweep && Date.now() - new Date(lastSweep).getTime() < SWEEP_INTERVAL_MS) {
    return { swept: false, flagged: 0, deleted: 0 };
  }

  const docs = db.listProcessedDocumentsWithNotePath(vault.id);
  let flagged = 0;
  let deleted = 0;

  for (const doc of docs) {
    const state = await noteFileState(doc.note_path);
    if (state === 'unknown') continue; // couldn't tell within the deadline — try again next sweep
    if (state === 'exists') {
      if (doc.orphan_flagged_at_utc) db.clearDocumentOrphanFlag(doc.id);
      continue;
    }
    if (doc.orphan_flagged_at_utc) {
      db.deleteOrphanedDocument(doc.id); // missing on a second consecutive daily sweep — confirmed gone
      deleted += 1;
    } else {
      db.flagDocumentOrphan(doc.id, nowUtcIso());
      flagged += 1;
    }
  }

  db.upsertBackfillCursor(vault.id, { lastOrphanSweepAtUtc: nowUtcIso() });
  return { swept: true, flagged, deleted };
}

module.exports = { sweepOrphansForVault };
