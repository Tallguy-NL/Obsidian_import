const path = require('path');
const { createConnection } = require('../shared/dbConnection');
const { nowUtcIso } = require('../shared/time');
const { STATUS, MAX_PROCESSING_ATTEMPTS } = require('../shared/constants');
const { resolveUserDataPath } = require('../shared/userDataPath');

let db = null;

function getDb() {
  if (!db) {
    // OI_DB_PATH_OVERRIDE lets tests point the worker at a throwaway DB file instead of the
    // real userData one; unset in normal operation, so production behavior is unaffected.
    const dbPath = process.env.OI_DB_PATH_OVERRIDE || path.join(resolveUserDataPath(), 'app.db');
    db = createConnection(dbPath);
  }
  return db;
}

// --- Settings / vaults (read-only from the worker's perspective, except worker_paused
//     which only main writes; worker just reads settings fresh every tick) -----------

function getSettings() {
  const row = getDb().prepare('SELECT * FROM settings WHERE id = 1').get();
  return {
    timezone: row.timezone,
    scheduleDaysMask: row.schedule_days_mask,
    scheduleStartMinutes: row.schedule_start_minutes,
    scheduleEndMinutes: row.schedule_end_minutes,
    imageTypesEnabled: JSON.parse(row.image_types_enabled),
    workerPaused: !!row.worker_paused,
    importPollIntervalSeconds: row.import_poll_interval_seconds,
  };
}

function listEnabledVaults() {
  return getDb().prepare('SELECT * FROM vaults WHERE enabled = 1').all();
}

function getVault(id) {
  return getDb().prepare('SELECT * FROM vaults WHERE id = ?').get(id);
}

function touchVaultAnalyzed(vaultId) {
  getDb()
    .prepare('UPDATE vaults SET last_analyzed_at_utc = ?, updated_at_utc = ? WHERE id = ?')
    .run(nowUtcIso(), nowUtcIso(), vaultId);
}

// --- Tags ---------------------------------------------------------------

function upsertTag(vaultId, tag) {
  const normalized = tag.trim().toLowerCase();
  if (!normalized) return;
  const nowIso = nowUtcIso();
  getDb()
    .prepare(
      `INSERT INTO tags (vault_id, tag, first_seen_at_utc, last_seen_at_utc, occurrence_count)
       VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(vault_id, tag) DO UPDATE SET
         last_seen_at_utc = excluded.last_seen_at_utc,
         occurrence_count = occurrence_count + 1`
    )
    .run(vaultId, normalized, nowIso, nowIso);
}

function listVaultTags(vaultId) {
  return getDb()
    .prepare('SELECT tag FROM tags WHERE vault_id = ?')
    .all(vaultId)
    .map((r) => r.tag);
}

function replaceVaultTags(vaultId, tagSet) {
  const database = getDb();
  const nowIso = nowUtcIso();
  const upsert = database.prepare(
    `INSERT INTO tags (vault_id, tag, first_seen_at_utc, last_seen_at_utc, occurrence_count)
     VALUES (?, ?, ?, ?, 1)
     ON CONFLICT(vault_id, tag) DO UPDATE SET last_seen_at_utc = excluded.last_seen_at_utc`
  );
  const txn = database.transaction((tags) => {
    for (const tag of tags) upsert.run(vaultId, tag, nowIso, nowIso);
  });
  txn([...tagSet]);
}

// --- Documents ---------------------------------------------------------------

function findDocumentByPath(vaultId, originalPath) {
  return getDb()
    .prepare('SELECT * FROM documents WHERE vault_id = ? AND original_path = ?')
    .get(vaultId, originalPath);
}

function insertPendingDocument({ guid, vaultId, sourceType, originalFilename, originalPath, groupKey, dupIndex }) {
  const nowIso = nowUtcIso();
  const database = getDb();
  try {
    const result = database
      .prepare(
        `INSERT INTO documents (guid, vault_id, source_type, original_filename, original_path,
         group_key, dup_index, status_code, discovered_at_utc, created_at_utc, updated_at_utc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ${STATUS.PENDING}, ?, ?, ?)`
      )
      .run(guid, vaultId, sourceType, originalFilename, originalPath, groupKey, dupIndex ?? null, nowIso, nowIso, nowIso);
    return database.prepare('SELECT * FROM documents WHERE id = ?').get(result.lastInsertRowid);
  } catch (err) {
    if (String(err.message).includes('UNIQUE constraint failed')) {
      // Already discovered in an earlier poll (e.g. worker restarted mid-batch) — return the existing row.
      return findDocumentByPath(vaultId, originalPath);
    }
    throw err;
  }
}

function listPendingDocuments(vaultId, groupKey) {
  return getDb()
    .prepare('SELECT * FROM documents WHERE vault_id = ? AND group_key = ? AND status_code = 0')
    .all(vaultId, groupKey);
}

function markDocumentProcessed(id, { statusCode, extractedTextChars, notePath, errorMessage, archivedPath, mimeType, fileSizeBytes }) {
  getDb()
    .prepare(
      `UPDATE documents SET status_code=?, failure_count=0, extracted_text_chars=?, note_path=?, error_message=?,
       archived_path=?, mime_type=?, file_size_bytes=?, processed_at_utc=?, updated_at_utc=? WHERE id=?`
    )
    .run(
      statusCode,
      extractedTextChars ?? null,
      notePath ?? null,
      errorMessage ?? null,
      archivedPath ?? null,
      mimeType ?? null,
      fileSizeBytes ?? null,
      nowUtcIso(),
      nowUtcIso(),
      id
    );
}

// Records a failed processing attempt. Once a document has failed MAX_PROCESSING_ATTEMPTS times
// in a row, it's marked FAILED_PERMANENTLY instead of NOT_PROCESSED so importPoller.js/
// backfillScanner.js's retry guards stop picking it up on every future tick — a file that's
// actually broken (corrupt, password-protected, ...) would otherwise be retried forever.
function markDocumentFailed(id, { errorMessage, fileSizeBytes }) {
  const database = getDb();
  const current = database.prepare('SELECT failure_count FROM documents WHERE id = ?').get(id);
  const failureCount = (current?.failure_count ?? 0) + 1;
  const statusCode = failureCount >= MAX_PROCESSING_ATTEMPTS ? STATUS.FAILED_PERMANENTLY : STATUS.NOT_PROCESSED;
  database
    .prepare(
      `UPDATE documents SET status_code=?, failure_count=?, error_message=?, file_size_bytes=?,
       processed_at_utc=?, updated_at_utc=? WHERE id=?`
    )
    .run(statusCode, failureCount, errorMessage ?? null, fileSizeBytes ?? null, nowUtcIso(), nowUtcIso(), id);
  return { statusCode, failureCount };
}

function listProcessedDocumentsWithNotePath(vaultId) {
  return getDb()
    .prepare(
      `SELECT id, note_path, orphan_flagged_at_utc FROM documents
       WHERE vault_id = ? AND note_path IS NOT NULL
       AND status_code IN (${STATUS.PROCESSED_NO_TEXT}, ${STATUS.PROCESSED_TEXT_FOUND}, ${STATUS.PROCESSED_TEXT_AND_TAGS})`
    )
    .all(vaultId);
}

function flagDocumentOrphan(id, tsIso) {
  getDb().prepare('UPDATE documents SET orphan_flagged_at_utc = ?, updated_at_utc = ? WHERE id = ?').run(tsIso, tsIso, id);
}

function clearDocumentOrphanFlag(id) {
  const nowIso = nowUtcIso();
  getDb().prepare('UPDATE documents SET orphan_flagged_at_utc = NULL, updated_at_utc = ? WHERE id = ?').run(nowIso, id);
}

function deleteOrphanedDocument(id) {
  const database = getDb();
  const txn = database.transaction((docId) => {
    database.prepare('DELETE FROM document_tags WHERE document_id = ?').run(docId);
    database.prepare('DELETE FROM documents WHERE id = ?').run(docId);
  });
  txn(id);
}

function getDocumentTagNames(documentId) {
  return getDb()
    .prepare(
      `SELECT t.tag FROM document_tags dt JOIN tags t ON t.id = dt.tag_id WHERE dt.document_id = ?`
    )
    .all(documentId)
    .map((r) => r.tag);
}

function linkDocumentTags(documentId, vaultId, tagNames) {
  const database = getDb();
  const getTagId = database.prepare('SELECT id FROM tags WHERE vault_id = ? AND tag = ?');
  const link = database.prepare(
    'INSERT OR IGNORE INTO document_tags (document_id, tag_id) VALUES (?, ?)'
  );
  const txn = database.transaction((tags) => {
    for (const tag of tags) {
      const row = getTagId.get(vaultId, tag);
      if (row) link.run(documentId, row.id);
    }
  });
  txn(tagNames);
}

// --- Backfill cursor ---------------------------------------------------------------

function getBackfillCursor(vaultId) {
  return getDb().prepare('SELECT * FROM backfill_cursor WHERE vault_id = ?').get(vaultId);
}

function upsertBackfillCursor(vaultId, fields) {
  const existing = getBackfillCursor(vaultId);
  const database = getDb();
  if (existing) {
    database
      .prepare(
        `UPDATE backfill_cursor SET last_tag_scan_at_utc=?, last_orphan_sweep_at_utc=?, backfill_last_note_path=?, backfill_in_progress=?
         WHERE vault_id=?`
      )
      .run(
        fields.lastTagScanAtUtc ?? existing.last_tag_scan_at_utc,
        fields.lastOrphanSweepAtUtc ?? existing.last_orphan_sweep_at_utc,
        fields.backfillLastNotePath ?? existing.backfill_last_note_path,
        fields.backfillInProgress ?? existing.backfill_in_progress ?? 0,
        vaultId
      );
  } else {
    database
      .prepare(
        `INSERT INTO backfill_cursor (vault_id, last_tag_scan_at_utc, last_orphan_sweep_at_utc, backfill_last_note_path, backfill_in_progress)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        vaultId,
        fields.lastTagScanAtUtc ?? null,
        fields.lastOrphanSweepAtUtc ?? null,
        fields.backfillLastNotePath ?? null,
        fields.backfillInProgress ?? 0
      );
  }
}

module.exports = {
  getDb,
  getSettings,
  listEnabledVaults,
  getVault,
  touchVaultAnalyzed,
  upsertTag,
  listVaultTags,
  replaceVaultTags,
  findDocumentByPath,
  insertPendingDocument,
  listPendingDocuments,
  markDocumentProcessed,
  markDocumentFailed,
  listProcessedDocumentsWithNotePath,
  flagDocumentOrphan,
  clearDocumentOrphanFlag,
  deleteOrphanedDocument,
  getDocumentTagNames,
  linkDocumentTags,
  getBackfillCursor,
  upsertBackfillCursor,
};
