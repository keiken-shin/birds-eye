PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scan_sessions (
  id INTEGER PRIMARY KEY,
  root_path TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL,
  files_scanned INTEGER NOT NULL DEFAULT 0,
  folders_scanned INTEGER NOT NULL DEFAULT 0,
  bytes_scanned INTEGER NOT NULL DEFAULT 0,
  inaccessible_entries INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY,
  parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
  path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  depth INTEGER NOT NULL,
  direct_bytes INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  direct_files INTEGER NOT NULL DEFAULT 0,
  total_files INTEGER NOT NULL DEFAULT 0,
  modified_at INTEGER,
  indexed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  extension TEXT,
  size INTEGER NOT NULL,
  modified_at INTEGER,
  accessed_at INTEGER,
  created_at INTEGER,
  partial_hash TEXT,
  full_hash TEXT,
  hash_algorithm TEXT,
  media_kind TEXT,
  indexed_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS duplicate_groups (
  id INTEGER PRIMARY KEY,
  size INTEGER NOT NULL,
  partial_hash TEXT,
  full_hash TEXT,
  confidence REAL NOT NULL,
  reclaimable_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS duplicate_group_files (
  group_id INTEGER NOT NULL REFERENCES duplicate_groups(id) ON DELETE CASCADE,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, file_id)
);

CREATE TABLE IF NOT EXISTS media_metadata (
  file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  width INTEGER,
  height INTEGER,
  duration_ms INTEGER,
  codec TEXT,
  bitrate INTEGER,
  camera_make TEXT,
  camera_model TEXT,
  title TEXT,
  artist TEXT,
  album TEXT
);

CREATE TABLE IF NOT EXISTS extension_stats (
  extension TEXT PRIMARY KEY,
  file_count INTEGER NOT NULL,
  total_bytes INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS timeline_history (
  id INTEGER PRIMARY KEY,
  root_path TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  total_bytes INTEGER NOT NULL,
  file_count INTEGER NOT NULL,
  folder_count INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_files_size ON files(size DESC);
CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder_id);
CREATE INDEX IF NOT EXISTS idx_files_extension_size ON files(extension, size DESC);
CREATE INDEX IF NOT EXISTS idx_files_modified ON files(modified_at);
CREATE INDEX IF NOT EXISTS idx_files_hash ON files(size, partial_hash, full_hash);
CREATE INDEX IF NOT EXISTS idx_files_deleted ON files(deleted_at);
CREATE INDEX IF NOT EXISTS idx_folders_total_bytes ON folders(total_bytes DESC);
CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);
CREATE INDEX IF NOT EXISTS idx_scan_sessions_root ON scan_sessions(root_path, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_timeline_root ON timeline_history(root_path, captured_at DESC);

