const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA_PATH = path.join(__dirname, '..', '..', 'db', 'schema.sql');

/**
 * Opens (creating if necessary) the shared app SQLite database in WAL mode and applies the schema.
 * Both the main process and the worker utilityProcess call this against the same file path so they
 * can operate concurrently (worker is the sole writer of documents/tags, main writes vaults/settings).
 */
function createConnection(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schema);
  ensureSettingsRow(db);
  runColumnMigrations(db);
  migrateStatusCodeCheckConstraint(db);
  return db;
}

// CREATE TABLE IF NOT EXISTS is a no-op against a table that already exists, so columns added
// to schema.sql after a database was first created need an explicit, idempotent backfill here —
// there's no separate migration framework in this app.
function ensureColumn(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function runColumnMigrations(db) {
  ensureColumn(db, 'documents', 'orphan_flagged_at_utc', 'TEXT');
  ensureColumn(db, 'backfill_cursor', 'last_orphan_sweep_at_utc', 'TEXT');
  ensureColumn(db, 'documents', 'failure_count', 'INTEGER NOT NULL DEFAULT 0');
}

// SQLite can't widen a CHECK constraint in place, so allowing the new FAILED_PERMANENTLY (410)
// status_code value on a database created before it existed means rebuilding the table: create
// a copy with the new constraint, copy the data across preserving ids (document_tags.document_id
// depends on them), drop the old table, and rename the copy into place. Guarded by inspecting
// the table's stored CREATE TABLE SQL so this only ever runs once, the first time a pre-410
// database is opened.
function migrateStatusCodeCheckConstraint(db) {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'documents'`).get();
  if (!row || row.sql.includes('410')) return; // already widened (or a brand-new DB, created straight from current schema.sql)

  db.pragma('foreign_keys = OFF'); // must be set outside any transaction
  try {
    db.exec('BEGIN');
    db.exec(`
      CREATE TABLE documents_new (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        guid                  TEXT NOT NULL UNIQUE,
        vault_id              INTEGER NOT NULL REFERENCES vaults(id),
        source_type           TEXT NOT NULL CHECK(source_type IN ('import','existing')),
        original_filename     TEXT NOT NULL,
        original_path         TEXT NOT NULL,
        group_key             TEXT NOT NULL,
        dup_index             INTEGER,
        note_path             TEXT,
        archived_path         TEXT,
        mime_type             TEXT,
        file_size_bytes       INTEGER,
        extracted_text_chars  INTEGER,
        status_code           INTEGER NOT NULL DEFAULT 0 CHECK(status_code IN (0,200,210,220,400,410)),
        error_message         TEXT,
        orphan_flagged_at_utc TEXT,
        failure_count         INTEGER NOT NULL DEFAULT 0,
        discovered_at_utc     TEXT NOT NULL,
        processed_at_utc      TEXT,
        created_at_utc        TEXT NOT NULL,
        updated_at_utc        TEXT NOT NULL,
        UNIQUE(vault_id, original_path)
      );
      INSERT INTO documents_new (
        id, guid, vault_id, source_type, original_filename, original_path, group_key, dup_index,
        note_path, archived_path, mime_type, file_size_bytes, extracted_text_chars, status_code,
        error_message, orphan_flagged_at_utc, failure_count, discovered_at_utc, processed_at_utc,
        created_at_utc, updated_at_utc
      )
      SELECT
        id, guid, vault_id, source_type, original_filename, original_path, group_key, dup_index,
        note_path, archived_path, mime_type, file_size_bytes, extracted_text_chars, status_code,
        error_message, orphan_flagged_at_utc, failure_count, discovered_at_utc, processed_at_utc,
        created_at_utc, updated_at_utc
      FROM documents;
      DROP TABLE documents;
      ALTER TABLE documents_new RENAME TO documents;
      CREATE INDEX IF NOT EXISTS idx_documents_vault_status ON documents(vault_id, status_code);
      CREATE INDEX IF NOT EXISTS idx_documents_group_key ON documents(vault_id, group_key);
    `);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function ensureSettingsRow(db) {
  const row = db.prepare('SELECT id FROM settings WHERE id = 1').get();
  if (row) return;
  const nowIso = new Date().toISOString();
  db.prepare(
    `INSERT INTO settings (id, created_at_utc, updated_at_utc) VALUES (1, ?, ?)`
  ).run(nowIso, nowIso);
}

module.exports = { createConnection };
