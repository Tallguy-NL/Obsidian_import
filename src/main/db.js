const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const Database = require('better-sqlite3');
const { createConnection } = require('../shared/dbConnection');
const { startOfLocalWeekUtcIso } = require('../shared/time');
const { findBacklog } = require('../worker/backfillScanner');

// The Import folder gets scanned as "new documents to ingest" and processed files get moved
// out of it into Archive; if either folder is the vault root (or nested inside it), the
// poller would treat the vault's own notes/attachments as importable documents and can
// overwrite or relocate them. Reject that configuration up front rather than corrupting data.
function isSameOrNestedPath(candidate, base) {
  const rel = path.relative(base, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function validateVaultFolders({ rootPath, importFolderPath, archiveFolderPath }) {
  // Both folders are optional at vault-creation time (the spec adds them as a follow-up step
  // after picking which subfolder is a vault) — only validate the ones actually set.
  if (importFolderPath && isSameOrNestedPath(importFolderPath, rootPath)) {
    throw new Error('Import folder cannot be the vault folder or a folder inside it.');
  }
  if (archiveFolderPath && isSameOrNestedPath(archiveFolderPath, rootPath)) {
    throw new Error('Archive folder cannot be the vault folder or a folder inside it.');
  }
  if (importFolderPath && archiveFolderPath && path.resolve(archiveFolderPath) === path.resolve(importFolderPath)) {
    throw new Error('Archive folder must be different from the Import folder.');
  }
}

let db = null;

function getDbPath() {
  return path.join(app.getPath('userData'), 'app.db');
}

function getDb() {
  if (!db) {
    db = createConnection(getDbPath());
  }
  return db;
}

// Closes the live connection so its underlying file can be safely overwritten (export-safe
// backup(), or an import replacing app.db outright) — callers must getDb() again afterwards,
// which transparently reopens against whatever's on disk at that point.
function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

// --- Vaults ---------------------------------------------------------------

function listVaults() {
  return getDb().prepare('SELECT * FROM vaults ORDER BY name COLLATE NOCASE').all();
}

function getVault(id) {
  return getDb().prepare('SELECT * FROM vaults WHERE id = ?').get(id);
}

function saveVault(config) {
  validateVaultFolders({
    rootPath: config.rootPath,
    importFolderPath: config.importFolderPath,
    archiveFolderPath: config.archiveFolderPath,
  });
  const nowIso = new Date().toISOString();
  const database = getDb();
  if (config.id) {
    database
      .prepare(
        `UPDATE vaults SET name=?, root_path=?, import_folder_path=?, archive_folder_path=?,
         delete_after_import=?, enabled=?, updated_at_utc=? WHERE id=?`
      )
      .run(
        config.name,
        config.rootPath,
        config.importFolderPath || null,
        config.archiveFolderPath || null,
        config.deleteAfterImport ? 1 : 0,
        config.enabled === false ? 0 : 1,
        nowIso,
        config.id
      );
    return getVault(config.id);
  }
  const result = database
    .prepare(
      `INSERT INTO vaults (name, root_path, import_folder_path, archive_folder_path,
       delete_after_import, enabled, created_at_utc, updated_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      config.name,
      config.rootPath,
      config.importFolderPath || null,
      config.archiveFolderPath || null,
      config.deleteAfterImport ? 1 : 0,
      config.enabled === false ? 0 : 1,
      nowIso,
      nowIso
    );
  return getVault(result.lastInsertRowid);
}

// documents/tags/backfill_cursor all REFERENCE vaults(id) with foreign_keys=ON (dbConnection.js)
// — deleting a vault that has ever processed anything fails the FK constraint unless its
// dependent rows are removed first. Wrapped in a transaction so a vault is never left half-gone.
function deleteVaultCascade(database, vaultId) {
  const txn = database.transaction((id) => {
    database.prepare('DELETE FROM document_tags WHERE document_id IN (SELECT id FROM documents WHERE vault_id = ?)').run(id);
    database.prepare('DELETE FROM document_tags WHERE tag_id IN (SELECT id FROM tags WHERE vault_id = ?)').run(id);
    database.prepare('DELETE FROM documents WHERE vault_id = ?').run(id);
    database.prepare('DELETE FROM tags WHERE vault_id = ?').run(id);
    database.prepare('DELETE FROM backfill_cursor WHERE vault_id = ?').run(id);
    database.prepare('DELETE FROM vaults WHERE id = ?').run(id);
  });
  txn(vaultId);
}

function removeVault(id) {
  deleteVaultCascade(getDb(), id);
}

// --- Settings ---------------------------------------------------------------

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

function updateSettings(partial) {
  const current = getSettings();
  const merged = { ...current, ...partial };
  const nowIso = new Date().toISOString();
  getDb()
    .prepare(
      `UPDATE settings SET timezone=?, schedule_days_mask=?, schedule_start_minutes=?,
       schedule_end_minutes=?, image_types_enabled=?, worker_paused=?,
       import_poll_interval_seconds=?, updated_at_utc=? WHERE id=1`
    )
    .run(
      merged.timezone,
      merged.scheduleDaysMask,
      merged.scheduleStartMinutes,
      merged.scheduleEndMinutes,
      JSON.stringify(merged.imageTypesEnabled),
      merged.workerPaused ? 1 : 0,
      merged.importPollIntervalSeconds,
      nowIso
    );
  return getSettings();
}

// --- Stats ---------------------------------------------------------------

// documents rows only exist for attachments the pipeline has actually picked up and started
// on — there's no "discovered but not yet processed" row, so COUNT(*) over that table can
// never be more than `processed` and is useless as a real vault-wide total. The Hero page's
// "Total" instead has to be processed + however many still-untouched attachments findBacklog
// (the same scan the worker itself uses to find backfill work) turns up right now. That scan
// walks every note in the vault, which is real work for large vaults — cached briefly here so
// polling this every 30s (plus on every statsChanged event) doesn't re-walk the filesystem
// each time.
const BACKLOG_COUNT_CACHE_TTL_MS = 60_000;
const backlogCountCache = new Map(); // vaultId -> { count, atMs }

async function getCachedBacklogCount(vault) {
  const cached = backlogCountCache.get(vault.id);
  if (cached && Date.now() - cached.atMs < BACKLOG_COUNT_CACHE_TTL_MS) return cached.count;
  const backlog = await findBacklog(vault);
  backlogCountCache.set(vault.id, { count: backlog.length, atMs: Date.now() });
  return backlog.length;
}

async function getStats() {
  const database = getDb();
  const settings = getSettings();
  const weekStartUtc = startOfLocalWeekUtcIso(settings.timezone);
  const vaults = await Promise.all(
    listVaults().map(async (vault) => {
      const processed = database
        .prepare('SELECT COUNT(*) AS c FROM documents WHERE vault_id = ? AND status_code != 0')
        .get(vault.id).c;
      const addedThisWeek = database
        .prepare('SELECT COUNT(*) AS c FROM documents WHERE vault_id = ? AND discovered_at_utc >= ?')
        .get(vault.id, weekStartUtc).c;
      const backlogCount = await getCachedBacklogCount(vault);
      const total = processed + backlogCount;
      return { vaultId: vault.id, name: vault.name, total, processed, addedThisWeek };
    })
  );
  return { vaults, paused: settings.workerPaused };
}

// --- Export / import (moving the database to another machine) -----------------------------

// A clean, single-file, point-in-time snapshot via SQLite's own backup API — safe regardless
// of WAL state, unlike a plain file copy of a live database.
async function exportDatabase(destPath) {
  const database = getDb();
  await database.backup(destPath);
  return destPath;
}

/**
 * Opens a picked file as a standalone connection (the live app.db is untouched) and reports,
 * per vault it contains, whether that vault's root_path exists on *this* machine's filesystem
 * — the caller (renderer) uses this to ask the user to re-point or drop any vault whose folder
 * doesn't exist here before actually importing anything.
 */
async function analyzeImportFile(filePath) {
  const importDb = new Database(filePath, { fileMustExist: true });
  try {
    const vaults = importDb.prepare('SELECT * FROM vaults ORDER BY name COLLATE NOCASE').all();
    return vaults.map((v) => ({
      id: v.id,
      name: v.name,
      rootPath: v.root_path,
      importFolderPath: v.import_folder_path,
      archiveFolderPath: v.archive_folder_path,
      pathExists: fs.existsSync(v.root_path),
    }));
  } finally {
    importDb.close();
  }
}

/**
 * Replaces the live database with the picked file, then applies the user's resolution for any
 * vault whose folder wasn't found on this machine (reroute to a newly-picked folder, or drop
 * the vault entirely — same as the existing "remove vault" action). Takes its own timestamped
 * backup of the current app.db first, purely as a safety net for a hard-to-reverse operation.
 *
 * `resolutions`: { [vaultId]: { action: 'reroute', newPath } | { action: 'remove' } } — only
 * needs entries for vaults analyzeImportFile flagged as pathExists:false; anything else is
 * imported as-is.
 */
async function applyImport(filePath, resolutions = {}) {
  const liveDbPath = getDbPath();
  const backupPath = `${liveDbPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;

  closeDb();
  await fs.promises.copyFile(liveDbPath, backupPath).catch(() => {}); // no-op on a first-ever run with no existing db yet

  await fs.promises.copyFile(filePath, liveDbPath);
  // A picked file that wasn't cleanly closed (e.g. the source app was still running when it
  // was copied) can have pending writes sitting in WAL/SHM sidecars — bring those along too,
  // rather than silently importing a stale/truncated view of the data.
  for (const ext of ['-wal', '-shm']) {
    await fs.promises.copyFile(`${filePath}${ext}`, `${liveDbPath}${ext}`).catch(() => {});
  }

  const database = getDb(); // reopens against the just-imported file; createConnection also
  // brings its schema up to this app version (new columns/tables since the export was made).

  for (const [vaultIdStr, resolution] of Object.entries(resolutions)) {
    const vaultId = Number(vaultIdStr);
    if (resolution.action === 'remove') {
      deleteVaultCascade(database, vaultId);
    } else if (resolution.action === 'reroute' && resolution.newPath) {
      database
        .prepare('UPDATE vaults SET root_path = ?, updated_at_utc = ? WHERE id = ?')
        .run(resolution.newPath, new Date().toISOString(), vaultId);
    }
  }

  backlogCountCache.clear(); // stale entries would be keyed by vault ids from the old database
  return { backupPath, vaults: listVaults() };
}

module.exports = {
  getDb,
  closeDb,
  listVaults,
  getVault,
  saveVault,
  removeVault,
  getSettings,
  updateSettings,
  getStats,
  exportDatabase,
  analyzeImportFile,
  applyImport,
};
