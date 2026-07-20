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
