PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS vaults (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  name                  TEXT NOT NULL,
  root_path             TEXT NOT NULL UNIQUE,
  import_folder_path    TEXT,
  archive_folder_path   TEXT,
  delete_after_import   INTEGER NOT NULL DEFAULT 0,
  enabled               INTEGER NOT NULL DEFAULT 1,
  last_analyzed_at_utc  TEXT,
  created_at_utc        TEXT NOT NULL,
  updated_at_utc        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
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
CREATE INDEX IF NOT EXISTS idx_documents_vault_status ON documents(vault_id, status_code);
CREATE INDEX IF NOT EXISTS idx_documents_group_key ON documents(vault_id, group_key);

CREATE TABLE IF NOT EXISTS tags (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  vault_id           INTEGER NOT NULL REFERENCES vaults(id),
  tag                TEXT NOT NULL,
  first_seen_at_utc  TEXT NOT NULL,
  last_seen_at_utc   TEXT NOT NULL,
  occurrence_count   INTEGER NOT NULL DEFAULT 1,
  UNIQUE(vault_id, tag)
);

CREATE TABLE IF NOT EXISTS document_tags (
  document_id  INTEGER NOT NULL REFERENCES documents(id),
  tag_id       INTEGER NOT NULL REFERENCES tags(id),
  PRIMARY KEY(document_id, tag_id)
);

CREATE TABLE IF NOT EXISTS settings (
  id                            INTEGER PRIMARY KEY CHECK(id = 1),
  timezone                      TEXT NOT NULL DEFAULT 'UTC',
  schedule_days_mask            INTEGER NOT NULL DEFAULT 127,
  schedule_start_minutes        INTEGER NOT NULL DEFAULT 0,
  schedule_end_minutes          INTEGER NOT NULL DEFAULT 1440,
  image_types_enabled           TEXT NOT NULL DEFAULT '["png","jpg","jpeg","bmp","gif","webp","heic","heif"]',
  worker_paused                 INTEGER NOT NULL DEFAULT 0,
  import_poll_interval_seconds  INTEGER NOT NULL DEFAULT 300,
  created_at_utc                TEXT NOT NULL,
  updated_at_utc                TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backfill_cursor (
  vault_id                  INTEGER PRIMARY KEY REFERENCES vaults(id),
  last_tag_scan_at_utc      TEXT,
  last_orphan_sweep_at_utc  TEXT,
  backfill_last_note_path   TEXT,
  backfill_in_progress      INTEGER NOT NULL DEFAULT 0
);
