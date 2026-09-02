pub const CURRENT_SCHEMA_VERSION: u32 = 26;

pub const MIGRATION_001: &str = r#"
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

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (1, strftime('%s', 'now'));
"#;

pub const MIGRATION_002: &str = r#"
ALTER TABLE files ADD COLUMN sample_hash TEXT;
ALTER TABLE files ADD COLUMN hash_state INTEGER NOT NULL DEFAULT 0;
ALTER TABLE duplicate_groups ADD COLUMN sample_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_files_sample_hash ON files(size, sample_hash, full_hash);

UPDATE files
SET partial_hash = NULL,
    sample_hash = NULL,
    full_hash = NULL,
    hash_algorithm = NULL,
    hash_state = 0
WHERE hash_algorithm IS NOT NULL;

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (2, strftime('%s', 'now'));
"#;

pub const MIGRATION_003: &str = r#"
ALTER TABLE scan_sessions ADD COLUMN scan_strategy TEXT NOT NULL DEFAULT 'smart';

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (3, strftime('%s', 'now'));
"#;

pub const MIGRATION_004: &str = r#"
CREATE TABLE IF NOT EXISTS duplicate_candidates (
  scan_id INTEGER NOT NULL REFERENCES scan_sessions(id) ON DELETE CASCADE,
  size INTEGER NOT NULL,
  file_count INTEGER NOT NULL,
  total_bytes INTEGER NOT NULL,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scan_id, size)
);

CREATE TABLE IF NOT EXISTS hash_jobs (
  id INTEGER PRIMARY KEY,
  scan_id INTEGER NOT NULL REFERENCES scan_sessions(id) ON DELETE CASCADE,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  UNIQUE (scan_id, file_id, job_type)
);

CREATE INDEX IF NOT EXISTS idx_duplicate_candidates_status ON duplicate_candidates(scan_id, status);
CREATE INDEX IF NOT EXISTS idx_hash_jobs_status ON hash_jobs(scan_id, status, priority DESC);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (4, strftime('%s', 'now'));
"#;

pub const MIGRATION_005: &str = r#"
CREATE TABLE IF NOT EXISTS ontology_vocabulary_version (
  current_version INTEGER NOT NULL,
  applied_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO ontology_vocabulary_version (current_version, applied_at)
VALUES (1, strftime('%s', 'now'));

CREATE TABLE IF NOT EXISTS ontology_entities (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('File', 'Folder', 'Project', 'Work', 'Theme')),
  canonical_id TEXT NOT NULL,
  linked_file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
  linked_folder_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
  display_name TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(kind, canonical_id)
);

CREATE INDEX IF NOT EXISTS idx_ontology_entities_linked_file ON ontology_entities(linked_file_id);
CREATE INDEX IF NOT EXISTS idx_ontology_entities_linked_folder ON ontology_entities(linked_folder_id);
CREATE INDEX IF NOT EXISTS idx_ontology_entities_kind_id ON ontology_entities(kind, id);

CREATE TABLE IF NOT EXISTS ontology_attrs (
  id INTEGER PRIMARY KEY,
  entity_id INTEGER NOT NULL REFERENCES ontology_entities(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  source TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
  asserted_at INTEGER NOT NULL,
  vocabulary_version INTEGER NOT NULL,
  display_in_global_views INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_ontology_attrs_entity_key ON ontology_attrs(entity_id, key);
CREATE INDEX IF NOT EXISTS idx_ontology_attrs_key_value ON ontology_attrs(key, value);

CREATE TABLE IF NOT EXISTS ontology_relations (
  id INTEGER PRIMARY KEY,
  subject_id INTEGER NOT NULL REFERENCES ontology_entities(id) ON DELETE CASCADE,
  predicate TEXT NOT NULL,
  object_id INTEGER NOT NULL REFERENCES ontology_entities(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
  asserted_at INTEGER NOT NULL,
  vocabulary_version INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ontology_relations_subj_pred ON ontology_relations(subject_id, predicate);
CREATE INDEX IF NOT EXISTS idx_ontology_relations_pred_obj ON ontology_relations(predicate, object_id);
CREATE INDEX IF NOT EXISTS idx_ontology_relations_pred_conf ON ontology_relations(predicate, confidence DESC);

CREATE TABLE IF NOT EXISTS ontology_negative_assertions (
  id INTEGER PRIMARY KEY,
  subject_id INTEGER NOT NULL REFERENCES ontology_entities(id) ON DELETE CASCADE,
  predicate TEXT NOT NULL,
  object_id INTEGER REFERENCES ontology_entities(id) ON DELETE CASCADE,
  key TEXT,
  value TEXT,
  rejected_at INTEGER NOT NULL,
  reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_neg_assertions_subj_pred ON ontology_negative_assertions(subject_id, predicate);
CREATE INDEX IF NOT EXISTS idx_neg_assertions_subj_key ON ontology_negative_assertions(subject_id, key);

CREATE TABLE IF NOT EXISTS ontology_pinned_files (
  file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  pinned_at INTEGER NOT NULL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS ontology_enabled (
  index_singleton INTEGER PRIMARY KEY CHECK (index_singleton = 1),
  enabled INTEGER NOT NULL,
  changed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ontology_perceptual_hashes (
  file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  phash BLOB NOT NULL,
  dhash BLOB NOT NULL,
  computed_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_phash ON ontology_perceptual_hashes(phash);

CREATE TABLE IF NOT EXISTS ontology_discoveries (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'rejected', 'expired')),
  confidence REAL NOT NULL,
  potential_bytes_unlocked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_discoveries_status_roi ON ontology_discoveries(status, potential_bytes_unlocked DESC, confidence DESC);

CREATE TABLE IF NOT EXISTS ontology_cleanup_plans (
  id INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL,
  executed_at INTEGER,
  scope TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'executed', 'cancelled'))
);

CREATE TABLE IF NOT EXISTS ontology_cleanup_log (
  id INTEGER PRIMARY KEY,
  cleanup_plan_id INTEGER NOT NULL REFERENCES ontology_cleanup_plans(id) ON DELETE CASCADE,
  file_id INTEGER NOT NULL,
  original_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  cleaned_at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  gating_facts TEXT NOT NULL,
  restore_status TEXT NOT NULL CHECK (restore_status IN ('in_recycle_bin', 'restored', 'expired')) DEFAULT 'in_recycle_bin',
  expires_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_cleanup_log_status ON ontology_cleanup_log(restore_status, expires_at);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (5, strftime('%s', 'now'));
"#;

pub const MIGRATION_006: &str = r#"
CREATE TABLE IF NOT EXISTS ontology_populator_state (
  populator_name TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'paused', 'completed', 'failed')),
  cursor TEXT,
  files_visited INTEGER NOT NULL DEFAULT 0,
  assertions_emitted INTEGER NOT NULL DEFAULT 0,
  discoveries_emitted INTEGER NOT NULL DEFAULT 0,
  last_run_at INTEGER,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_populator_state_status ON ontology_populator_state(status);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (6, strftime('%s', 'now'));
"#;

pub const MIGRATION_007: &str = r#"
-- The cleanup-decision predicate, materialized as a view (spec §7).
-- Resolution rule: per (entity,key) the highest-confidence assertion wins,
-- ties broken by most-recent (asserted_at). This mirrors ontology::attrs::resolve_attr
-- closely enough for gating; source_priority is not a SQL tiebreak.
CREATE VIEW IF NOT EXISTS v_cleanup_candidates AS
SELECT file_id, entity_id, path, size, reason
FROM (
  WITH file_facts AS (
    SELECT
      f.id   AS file_id,
      f.size AS size,
      f.path AS path,
      e.id   AS entity_id,
      (SELECT a.value FROM ontology_attrs a
         WHERE a.entity_id = e.id AND a.key = 'role'
         ORDER BY a.confidence DESC, a.asserted_at DESC LIMIT 1) AS role,
      (SELECT a.confidence FROM ontology_attrs a
         WHERE a.entity_id = e.id AND a.key = 'role'
         ORDER BY a.confidence DESC, a.asserted_at DESC LIMIT 1) AS role_conf,
      (SELECT a.value FROM ontology_attrs a
         WHERE a.entity_id = e.id AND a.key = 'replaceability'
         ORDER BY a.confidence DESC, a.asserted_at DESC LIMIT 1) AS replaceability,
      (SELECT a.value FROM ontology_attrs a
         WHERE a.entity_id = e.id AND a.key = 'sensitivity'
         ORDER BY a.confidence DESC, a.asserted_at DESC LIMIT 1) AS sensitivity,
      EXISTS(SELECT 1 FROM ontology_pinned_files p WHERE p.file_id = f.id) AS is_pinned
    FROM files f
    JOIN ontology_entities e ON e.kind = 'File' AND e.linked_file_id = f.id
    WHERE f.deleted_at IS NULL
  ),
  project_lifecycles AS (
    SELECT
      r.subject_id AS file_entity_id,
      (SELECT a.value FROM ontology_attrs a
         WHERE a.entity_id = pe.id AND a.key = 'lifecycle'
         ORDER BY a.confidence DESC, a.asserted_at DESC LIMIT 1) AS lifecycle
    FROM ontology_relations r
    JOIN ontology_entities pe ON pe.id = r.object_id AND pe.kind = 'Project'
    WHERE r.predicate = 'partOf'
  ),
  hard_excluded AS (
    SELECT ff.file_id
    FROM file_facts ff
    LEFT JOIN project_lifecycles pl ON pl.file_entity_id = ff.entity_id
    WHERE ff.sensitivity IN ('private', 'restricted')
       OR ff.replaceability = 'irreplaceable'
       OR ff.role IN ('source', 'system', 'asset', 'tool')
       OR pl.lifecycle = 'active'
       OR ff.is_pinned = 1
  )
  SELECT
    ff.file_id,
    ff.entity_id,
    ff.path,
    ff.size,
    CASE
      WHEN ff.role = 'derivative'
           AND ff.replaceability = 'regenerable'
           AND EXISTS (
             SELECT 1 FROM ontology_relations r
             JOIN ontology_entities src ON src.id = r.object_id
             JOIN files srcf ON srcf.id = src.linked_file_id
             WHERE r.predicate = 'derivedFrom'
               AND r.subject_id = ff.entity_id
               AND srcf.deleted_at IS NULL
           )
        THEN 'safe-derivative'
      WHEN ff.role = 'backup'
           AND EXISTS (
             SELECT 1 FROM ontology_relations r
             JOIN ontology_entities org ON org.id = r.object_id
             JOIN files orgf ON orgf.id = org.linked_file_id
             WHERE r.predicate = 'backupOf'
               AND r.subject_id = ff.entity_id
               AND orgf.deleted_at IS NULL
           )
        THEN 'redundant-backup'
      WHEN ff.role = 'scratch' AND ff.role_conf >= 0.9
        THEN 'scratch'
      WHEN ff.role = 'derivative'
           AND EXISTS (
             SELECT 1 FROM project_lifecycles pl
             WHERE pl.file_entity_id = ff.entity_id
               AND pl.lifecycle IN ('finished', 'archived')
           )
        THEN 'finished-project-cruft'
      ELSE NULL
    END AS reason
  FROM file_facts ff
  WHERE ff.file_id NOT IN (SELECT file_id FROM hard_excluded)
)
WHERE reason IS NOT NULL;

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (7, strftime('%s', 'now'));
"#;

pub const MIGRATION_008: &str = r#"
-- Rebuild ontology_cleanup_log to admit the transient 'pending' restore_status:
-- the executor now logs BEFORE trashing so a crash mid-clean can't leave a file
-- in the recycle bin with no trace. SQLite cannot alter CHECK constraints.
CREATE TABLE ontology_cleanup_log_v8 (
  id INTEGER PRIMARY KEY,
  cleanup_plan_id INTEGER NOT NULL REFERENCES ontology_cleanup_plans(id) ON DELETE CASCADE,
  file_id INTEGER NOT NULL,
  original_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  cleaned_at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  gating_facts TEXT NOT NULL,
  restore_status TEXT NOT NULL CHECK (restore_status IN ('pending', 'in_recycle_bin', 'restored', 'expired')) DEFAULT 'in_recycle_bin',
  expires_at INTEGER
);

INSERT INTO ontology_cleanup_log_v8
SELECT id, cleanup_plan_id, file_id, original_path, size, cleaned_at, reason,
       gating_facts, restore_status, expires_at
FROM ontology_cleanup_log;

DROP TABLE ontology_cleanup_log;
ALTER TABLE ontology_cleanup_log_v8 RENAME TO ontology_cleanup_log;

CREATE INDEX IF NOT EXISTS idx_cleanup_log_status ON ontology_cleanup_log(restore_status, expires_at);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (8, strftime('%s', 'now'));
"#;

pub const MIGRATION_009: &str = r#"
-- Files and folders the scanner could NOT read (permission denied, locked,
-- cloud placeholder, vanished) — surfaced to the user instead of silently
-- shaping results. phase: 'walk' (couldn't index) | 'hash' (couldn't verify
-- content, so excluded from duplicate detection).
CREATE TABLE IF NOT EXISTS scan_issues (
  id INTEGER PRIMARY KEY,
  scan_id INTEGER NOT NULL REFERENCES scan_sessions(id) ON DELETE CASCADE,
  phase TEXT NOT NULL CHECK (phase IN ('walk', 'hash')),
  path TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scan_issues_scan ON scan_issues(scan_id, phase);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (9, strftime('%s', 'now'));
"#;

pub const MIGRATION_010: &str = r#"
-- Startup-cost materialization: media totals, per-folder media, monthly
-- activity and age bands were full-table scans on EVERY overview query
-- (~1.1s warm on a 700k-file index, much worse cold). Rebuilt once per scan
-- finalization instead, like extension_stats.
CREATE TABLE IF NOT EXISTS media_stats (
  media_kind TEXT PRIMARY KEY,
  file_count INTEGER NOT NULL,
  total_bytes INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS folder_media_stats (
  folder_path TEXT NOT NULL,
  media_kind TEXT NOT NULL,
  total_bytes INTEGER NOT NULL,
  PRIMARY KEY (folder_path, media_kind)
);

CREATE INDEX IF NOT EXISTS idx_folder_media_stats_bytes ON folder_media_stats(total_bytes DESC);

CREATE TABLE IF NOT EXISTS month_stats (
  bucket TEXT PRIMARY KEY, -- 'YYYY-MM', or 'unknown' for files with no mtime
  file_count INTEGER NOT NULL,
  total_bytes INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS age_stats (
  bucket TEXT PRIMARY KEY, -- lt1mo … gt2yr / unknown, relative to scan time
  file_count INTEGER NOT NULL,
  total_bytes INTEGER NOT NULL
);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (10, strftime('%s', 'now'));
"#;

pub const MIGRATION_011: &str = r#"
-- Cataloging: relocation suggestions and their reviewed execution.
-- `catalog_rules` holds user-taught destinations (saved after a manual move or
-- an edited suggestion) and outranks every inferred destination.
-- Relocation plans mirror ontology_cleanup_plans, except a relocation is an
-- explicit per-file (from, to) list rather than a recomputable scope predicate,
-- so the destinations live in the items table.
CREATE TABLE IF NOT EXISTS catalog_rules (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  criteria TEXT NOT NULL,
  destination TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('saved-after-move', 'saved-after-edit')),
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ontology_relocation_plans (
  id INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL,
  executed_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('draft', 'executed', 'cancelled'))
);

CREATE TABLE IF NOT EXISTS ontology_relocation_plan_items (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES ontology_relocation_plans(id) ON DELETE CASCADE,
  discovery_id INTEGER,
  file_id INTEGER NOT NULL,
  from_path TEXT NOT NULL,
  to_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('planned', 'moved', 'skipped', 'failed')) DEFAULT 'planned',
  note TEXT
);

CREATE INDEX IF NOT EXISTS idx_relocation_items_plan ON ontology_relocation_plan_items(plan_id, status);

-- Learned-home inference groups files by media_kind per folder; without this the
-- pass is a full scan of `files` for every kind on every enrichment run.
CREATE INDEX IF NOT EXISTS idx_files_kind_folder ON files(media_kind, folder_id);

-- Rejection suppression reads rejected rows of one kind; idx_discoveries_status_roi
-- leads with status and cannot serve a kind lookup.
CREATE INDEX IF NOT EXISTS idx_discoveries_kind_status ON ontology_discoveries(kind, status);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (11, strftime('%s', 'now'));
"#;

pub const MIGRATION_012: &str = r#"
-- v_cleanup_candidates gains modified_at so a cleanup recommendation can show
-- "how long since you touched it" without a second per-candidate query. A
-- view has no stored data, so redefining it is a plain drop-and-recreate --
-- not the table-rebuild dance MIGRATION_008 needed for a CHECK constraint.
DROP VIEW IF EXISTS v_cleanup_candidates;

CREATE VIEW v_cleanup_candidates AS
SELECT file_id, entity_id, path, size, modified_at, reason
FROM (
  WITH file_facts AS (
    SELECT
      f.id   AS file_id,
      f.size AS size,
      f.path AS path,
      f.modified_at AS modified_at,
      e.id   AS entity_id,
      (SELECT a.value FROM ontology_attrs a
         WHERE a.entity_id = e.id AND a.key = 'role'
         ORDER BY a.confidence DESC, a.asserted_at DESC LIMIT 1) AS role,
      (SELECT a.confidence FROM ontology_attrs a
         WHERE a.entity_id = e.id AND a.key = 'role'
         ORDER BY a.confidence DESC, a.asserted_at DESC LIMIT 1) AS role_conf,
      (SELECT a.value FROM ontology_attrs a
         WHERE a.entity_id = e.id AND a.key = 'replaceability'
         ORDER BY a.confidence DESC, a.asserted_at DESC LIMIT 1) AS replaceability,
      (SELECT a.value FROM ontology_attrs a
         WHERE a.entity_id = e.id AND a.key = 'sensitivity'
         ORDER BY a.confidence DESC, a.asserted_at DESC LIMIT 1) AS sensitivity,
      EXISTS(SELECT 1 FROM ontology_pinned_files p WHERE p.file_id = f.id) AS is_pinned
    FROM files f
    JOIN ontology_entities e ON e.kind = 'File' AND e.linked_file_id = f.id
    WHERE f.deleted_at IS NULL
  ),
  project_lifecycles AS (
    SELECT
      r.subject_id AS file_entity_id,
      (SELECT a.value FROM ontology_attrs a
         WHERE a.entity_id = pe.id AND a.key = 'lifecycle'
         ORDER BY a.confidence DESC, a.asserted_at DESC LIMIT 1) AS lifecycle
    FROM ontology_relations r
    JOIN ontology_entities pe ON pe.id = r.object_id AND pe.kind = 'Project'
    WHERE r.predicate = 'partOf'
  ),
  hard_excluded AS (
    SELECT ff.file_id
    FROM file_facts ff
    LEFT JOIN project_lifecycles pl ON pl.file_entity_id = ff.entity_id
    WHERE ff.sensitivity IN ('private', 'restricted')
       OR ff.replaceability = 'irreplaceable'
       OR ff.role IN ('source', 'system', 'asset', 'tool')
       OR pl.lifecycle = 'active'
       OR ff.is_pinned = 1
  )
  SELECT
    ff.file_id,
    ff.entity_id,
    ff.path,
    ff.size,
    ff.modified_at,
    CASE
      WHEN ff.role = 'derivative'
           AND ff.replaceability = 'regenerable'
           AND EXISTS (
             SELECT 1 FROM ontology_relations r
             JOIN ontology_entities src ON src.id = r.object_id
             JOIN files srcf ON srcf.id = src.linked_file_id
             WHERE r.predicate = 'derivedFrom'
               AND r.subject_id = ff.entity_id
               AND srcf.deleted_at IS NULL
           )
        THEN 'safe-derivative'
      WHEN ff.role = 'backup'
           AND EXISTS (
             SELECT 1 FROM ontology_relations r
             JOIN ontology_entities org ON org.id = r.object_id
             JOIN files orgf ON orgf.id = org.linked_file_id
             WHERE r.predicate = 'backupOf'
               AND r.subject_id = ff.entity_id
               AND orgf.deleted_at IS NULL
           )
        THEN 'redundant-backup'
      WHEN ff.role = 'scratch' AND ff.role_conf >= 0.9
        THEN 'scratch'
      WHEN ff.role = 'derivative'
           AND EXISTS (
             SELECT 1 FROM project_lifecycles pl
             WHERE pl.file_entity_id = ff.entity_id
               AND pl.lifecycle IN ('finished', 'archived')
           )
        THEN 'finished-project-cruft'
      ELSE NULL
    END AS reason
  FROM file_facts ff
  WHERE ff.file_id NOT IN (SELECT file_id FROM hard_excluded)
)
WHERE reason IS NOT NULL;

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (12, strftime('%s', 'now'));
"#;

pub const MIGRATION_013: &str = r#"
-- Durable undo for moves, mirroring ontology_cleanup_log. A deletion has been
-- recoverable across restarts since MIGRATION_005; a move was only ever undoable
-- from React state, so closing the app made it permanent. Same shape: one
-- append-only row per file, written the moment the bytes land, with a status
-- that only ever goes moved -> restored.
--
-- No expires_at column: a moved file sits at a real path on disk, not in the
-- recycle bin, so nothing takes it away after a retention window.
CREATE TABLE IF NOT EXISTS ontology_relocation_log (
  id INTEGER PRIMARY KEY,
  -- The index row for the source at move time. Nullable because a manual move
  -- can name a path the current scan never indexed.
  file_id INTEGER,
  from_path TEXT NOT NULL,
  to_path TEXT NOT NULL,
  -- Size and last-modified read from the destination straight after the move.
  -- Restore compares both against the file on disk, so a file that was edited
  -- or replaced since is refused rather than yanked back over newer work.
  size INTEGER NOT NULL,
  moved_at INTEGER NOT NULL,
  modified_at INTEGER,
  restore_status TEXT NOT NULL CHECK (restore_status IN ('moved', 'restored')) DEFAULT 'moved'
);

CREATE INDEX IF NOT EXISTS idx_relocation_log_moved_at ON ontology_relocation_log(moved_at DESC, id DESC);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (13, strftime('%s', 'now'));
"#;

/// Both mutation logs gain a transient in-flight state, so a crash between the
/// filesystem write and the bookkeeping write leaves a row that says so instead
/// of a row that lies.
///
/// `ontology_relocation_log` gains `move_pending` (written before the bytes
/// move) and `restore_pending` (written before a put-back). `ontology_cleanup_log`
/// gains `restore_pending` for the same reason on its own restore path, which
/// previously stranded exactly the way relocation's did: filesystem restored,
/// row still `in_recycle_bin`, every retry refusing forever.
///
/// SQLite cannot alter a CHECK constraint, so both are table rebuilds — the same
/// dance MIGRATION_008 did to admit `pending`.
pub const MIGRATION_014: &str = r#"
CREATE TABLE ontology_relocation_log_v14 (
  id INTEGER PRIMARY KEY,
  file_id INTEGER,
  from_path TEXT NOT NULL,
  to_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  moved_at INTEGER NOT NULL,
  modified_at INTEGER,
  restore_status TEXT NOT NULL
    CHECK (restore_status IN ('move_pending', 'moved', 'restore_pending', 'restored'))
    DEFAULT 'moved'
);

INSERT INTO ontology_relocation_log_v14
SELECT id, file_id, from_path, to_path, size, moved_at, modified_at, restore_status
FROM ontology_relocation_log;

DROP TABLE ontology_relocation_log;
ALTER TABLE ontology_relocation_log_v14 RENAME TO ontology_relocation_log;

CREATE INDEX IF NOT EXISTS idx_relocation_log_moved_at ON ontology_relocation_log(moved_at DESC, id DESC);

CREATE TABLE ontology_cleanup_log_v14 (
  id INTEGER PRIMARY KEY,
  cleanup_plan_id INTEGER NOT NULL REFERENCES ontology_cleanup_plans(id) ON DELETE CASCADE,
  file_id INTEGER NOT NULL,
  original_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  cleaned_at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  gating_facts TEXT NOT NULL,
  restore_status TEXT NOT NULL
    CHECK (restore_status IN ('pending', 'in_recycle_bin', 'restore_pending', 'restored', 'expired'))
    DEFAULT 'in_recycle_bin',
  expires_at INTEGER
);

INSERT INTO ontology_cleanup_log_v14
SELECT id, cleanup_plan_id, file_id, original_path, size, cleaned_at, reason,
       gating_facts, restore_status, expires_at
FROM ontology_cleanup_log;

DROP TABLE ontology_cleanup_log;
ALTER TABLE ontology_cleanup_log_v14 RENAME TO ontology_cleanup_log;

CREATE INDEX IF NOT EXISTS idx_cleanup_log_status ON ontology_cleanup_log(restore_status, expires_at);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (14, strftime('%s', 'now'));
"#;

/// Staging, made durable.
///
/// The tray that collects things from every view lived in React state, so it
/// died with the window — which is the difference between a desk you come back
/// to and a clipboard you drop on the way to the kitchen.
///
/// Keyed on `path`, not `file_id`, because **folders are staged too** and have
/// no file row: a folder selection is a path-prefix scope, which is exactly what
/// picking a folder means. `file_id` is filled in for files so a cleanup plan
/// can record the rows a person actually reviewed without a second lookup.
pub const MIGRATION_015: &str = r#"
CREATE TABLE IF NOT EXISTS ontology_staged_items (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'folder')),
  path TEXT NOT NULL UNIQUE,
  file_id INTEGER,
  name TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  verdict TEXT,
  reason TEXT,
  group_name TEXT,
  note TEXT,
  added_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_staged_group ON ontology_staged_items(group_name, added_at DESC);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (15, strftime('%s', 'now'));
"#;

/// Discard every perceptual hash computed by the old byte-bucket implementation.
///
/// Those rows are not weak hashes of the picture -- they are hashes of the
/// compressed bytes, so they carry no information about what the image looks
/// like, and the near-duplicate discoveries drawn from them are noise. Keeping
/// them would mean the new decoded-pixel hashes are compared against garbage
/// until every image happens to be revisited.
///
/// The populator cursor is dropped alongside them so the next run re-hashes from
/// the beginning rather than resuming past the files it already "did".
///
/// Pending discoveries go too. A resolved one is left alone deliberately: it
/// records a decision a person made, and rewriting someone's history to match a
/// later opinion of the evidence is worse than leaving the record honest.
pub const MIGRATION_016: &str = r#"
DELETE FROM ontology_perceptual_hashes;

DELETE FROM ontology_populator_state
WHERE populator_name = 'PerceptualHashPopulator';

DELETE FROM ontology_discoveries
WHERE kind = 'near-duplicate-cluster' AND status = 'pending';

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (16, strftime('%s', 'now'));
"#;

/// Scan coverage: what the scan actually managed to read, kept per scan.
///
/// `scan_issues` already records why an individual file went unhashed, but it is
/// capped, so past the cap the rows simply stop. Counting them would understate
/// the problem exactly when the problem is largest -- the failure mode that
/// flatters the scan. These counters are incremented as the hashing pass
/// commits, independently of whether an issue row was kept.
///
/// `kind` on `scan_issues` turns the same classification into data rather than
/// prose, so a report never has to pattern-match an error message. Rows written
/// before this migration keep 'failed', which is the honest answer for them:
/// nobody recorded why.
pub const MIGRATION_017: &str = r#"
ALTER TABLE scan_issues ADD COLUMN kind TEXT NOT NULL DEFAULT 'failed';

ALTER TABLE scan_sessions ADD COLUMN skipped_offline INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scan_sessions ADD COLUMN skipped_locked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scan_sessions ADD COLUMN skipped_denied INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scan_sessions ADD COLUMN skipped_changed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scan_sessions ADD COLUMN skipped_failed INTEGER NOT NULL DEFAULT 0;

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (17, strftime('%s', 'now'));
"#;

/// What the filesystem calls each file, alongside where it was found.
///
/// Until now a row's only identity was its path, so a file that was renamed
/// read as one file deleted and another created, and a file replaced in place
/// read as the same file. `object_id` is the volume serial plus the filesystem's
/// own file id, written as fixed-width hex because a ReFS id is 128 bits and a
/// SQLite integer is 64.
///
/// Nullable on purpose: rows written before this migration have no id, and a
/// volume that will not answer never gets one. Absent means "not known", which
/// callers must treat as "fall back to size and last-modified", never as "no
/// match".
pub const MIGRATION_018: &str = r#"
ALTER TABLE files ADD COLUMN object_id TEXT;

CREATE INDEX IF NOT EXISTS idx_files_object_id
  ON files(object_id) WHERE object_id IS NOT NULL;

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (18, strftime('%s', 'now'));
"#;

/// What a file occupies, alongside what it claims.
///
/// `files.size` is the logical length. For a sparse disk image, a compressed
/// folder, or a deduplicated volume, the bytes on disk can be a small fraction
/// of that. Bird's Eye was reporting the logical figure as space used and as
/// space that could be reclaimed, so deleting a 40 GB sparse image that
/// occupies 2 GB was advertised as freeing 40 GB.
///
/// Nullable, because rows indexed before this have no figure and a volume that
/// will not answer never gets one. Absent means "unknown", and callers fall
/// back to `size` rather than to zero.
pub const MIGRATION_019: &str = r#"
ALTER TABLE files ADD COLUMN allocated_size INTEGER;

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (19, strftime('%s', 'now'));
"#;

/// One set of bytes, several names.
///
/// A hard link is not a copy. The file exists once on disk and appears in
/// several folders, so counting its size once per name inflates every folder
/// total above it, the volume total, and every reclaim figure derived from
/// them -- and it makes two names for one file look like a duplicate pair,
/// where deleting one frees nothing at all.
///
/// `shares_bytes_with` points at the first row seen for that object. NULL means
/// this row is the one that carries the bytes, which is every ordinary file.
/// Rows that point elsewhere stay fully visible as files; they just stop
/// contributing their size a second time.
pub const MIGRATION_020: &str = r#"
ALTER TABLE files ADD COLUMN shares_bytes_with INTEGER;

CREATE INDEX IF NOT EXISTS idx_files_shares_bytes_with
  ON files(shares_bytes_with) WHERE shares_bytes_with IS NOT NULL;

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (20, strftime('%s', 'now'));
"#;

/// What the bytes say the file is, next to what its name claims.
///
/// `extension` is a claim made by whoever named the file. A PNG renamed to
/// `.jpg` was treated as a JPEG by every media feature; a real photo saved as
/// `IMG_0421` with no extension was invisible to all of them.
///
/// Three states, and the third is the point. A format name means the head of
/// the file was read and recognised. `'unknown'` means it was read and matched
/// nothing. NULL means it was never read -- most files are not worth opening
/// for this, and the index should say which ones it checked rather than imply
/// it checked everything.
pub const MIGRATION_021: &str = r#"
ALTER TABLE files ADD COLUMN detected_format TEXT;

CREATE INDEX IF NOT EXISTS idx_files_detected_format
  ON files(detected_format) WHERE detected_format IS NOT NULL;

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (21, strftime('%s', 'now'));
"#;

/// One fingerprint per file instead of two.
///
/// Every candidate was read twice: once for `sample_hash`, whose sampling plan
/// scales with file size, and once for `partial_hash`, which always took the
/// head and the tail regardless. Both were written together, so `partial_hash`
/// never separated two files that `sample_hash` did not already separate -- it
/// bought nothing and cost a second pass over every candidate on the volume.
///
/// The index on it goes too; `idx_files_sample_hash` from migration 002 already
/// covers the same lookup. Existing groups are cleared rather than migrated:
/// they were keyed partly on the dropped column, and the next scan rebuilds
/// them from what is left.
pub const MIGRATION_022: &str = r#"
DROP INDEX IF EXISTS idx_files_hash;

DELETE FROM duplicate_group_files;
DELETE FROM duplicate_groups;

ALTER TABLE files DROP COLUMN partial_hash;
ALTER TABLE duplicate_groups DROP COLUMN partial_hash;

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (22, strftime('%s', 'now'));
"#;

/// What kind of volume a scan was of.
///
/// A network share, a USB stick and an internal disk were all just paths, so a
/// report could not say which world its numbers came from. The kind changes
/// what they mean: a share can go quiet without anything being deleted, a stick
/// can be pulled between the scan and the cleanup, and only a fixed disk makes
/// "it was there a minute ago" a safe assumption.
///
/// `'unknown'` where the platform will not say, which is honest and is the
/// answer everywhere that is not Windows.
pub const MIGRATION_023: &str = r#"
ALTER TABLE scan_sessions ADD COLUMN volume_kind TEXT;

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (23, strftime('%s', 'now'));
"#;

/// What a file costs the disk, as opposed to how much data it addresses.
///
/// These are the same number for almost every file and wildly different for a
/// few: a sparse disk image can address 40 GB and occupy 2, and a compressed
/// folder of zeros occupies none at all. Every rectangle, folder total and
/// "you have used X" claim is about cost, so they all read this column.
///
/// `size` stays exactly as it is. It is what a duplicate group keys on -- two
/// identical files have identical logical length, while their allocation can
/// differ by compression -- and it is what the file detail panel calls the data
/// size. Two true numbers, each used where it is the true one.
///
/// Generated and virtual, so it costs nothing to store and cannot drift from
/// the two columns it is derived from.
pub const MIGRATION_024: &str = r#"
ALTER TABLE files ADD COLUMN disk_bytes INTEGER
    GENERATED ALWAYS AS (COALESCE(allocated_size, size)) VIRTUAL;

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (24, strftime('%s', 'now'));
"#;

/// Whether the last read of a file could be trusted, as opposed to how much of
/// it was read.
///
/// `hash_state` was carrying both. `4` was written as "we read all of it" and
/// used as "we read all of it and it held still", and the deletion guard leans
/// on the second one. NULL means no read has been attempted. Otherwise it is
/// `stable`, or the name of what went wrong -- the same words the scan issue
/// list uses, so there is one vocabulary rather than two.
///
/// See `src/index/analysis.rs` for why this is a column on `files` rather than
/// a join into `scan_issues`.
pub const MIGRATION_025: &str = r#"
ALTER TABLE files ADD COLUMN verification_status TEXT;

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (25, strftime('%s', 'now'));
"#;

/// Migration 026: which *version* of a producer said this, and one dead table gone.
///
/// Every ontology fact already records what produced it. That answers "where
/// did this come from" but not the question that matters when a parser turns
/// out to be wrong: which conclusions came from the old one? Without the
/// version there are two options and both are bad -- trust facts a known-broken
/// extractor wrote, or re-extract a whole volume. `0` means the producer is
/// identified by its name and changes by getting a new name, which is true of
/// every rule. See `src/ontology/provenance.rs`.
///
/// `media_metadata` goes at the same time. It was declared in migration 001 and
/// nothing has ever written a row to it or read one; keeping an empty table
/// shaped like the right answer invites someone to fill it, and it has no
/// source, no confidence and no version -- exactly the provenance this
/// migration is adding everywhere else.
pub const MIGRATION_026: &str = r#"
ALTER TABLE ontology_attrs ADD COLUMN source_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ontology_relations ADD COLUMN source_version INTEGER NOT NULL DEFAULT 0;

DROP TABLE IF EXISTS media_metadata;

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (26, strftime('%s', 'now'));
"#;

pub const ALL_MIGRATIONS: &[(u32, &str)] = &[
    (1, MIGRATION_001),
    (2, MIGRATION_002),
    (3, MIGRATION_003),
    (4, MIGRATION_004),
    (5, MIGRATION_005),
    (6, MIGRATION_006),
    (7, MIGRATION_007),
    (8, MIGRATION_008),
    (9, MIGRATION_009),
    (10, MIGRATION_010),
    (11, MIGRATION_011),
    (12, MIGRATION_012),
    (13, MIGRATION_013),
    (14, MIGRATION_014),
    (15, MIGRATION_015),
    (16, MIGRATION_016),
    (17, MIGRATION_017),
    (18, MIGRATION_018),
    (19, MIGRATION_019),
    (20, MIGRATION_020),
    (21, MIGRATION_021),
    (22, MIGRATION_022),
    (23, MIGRATION_023),
    (24, MIGRATION_024),
    (25, MIGRATION_025),
    (26, MIGRATION_026),
];

#[cfg(test)]
mod tests {
    use super::*;

    /// Migration 016 must actually drop the byte-bucket hashes and the pending
    /// discoveries drawn from them, and must leave a resolved discovery alone.
    #[test]
    fn migration_016_discards_the_old_perceptual_hashes_but_not_resolved_history() {
        use rusqlite::Connection;
        let conn = Connection::open_in_memory().expect("open in-memory db");
        for (version, sql) in ALL_MIGRATIONS {
            if *version == 16 {
                conn.execute(
                    "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
                     VALUES (1, NULL, '/root', 'root', 0, 0)",
                    [],
                )
                .expect("seed a folder");
                conn.execute(
                    "INSERT INTO files (id, folder_id, path, name, size, indexed_at)
                     VALUES (1, 1, '/root/a.jpg', 'a.jpg', 10, 0)",
                    [],
                )
                .expect("seed a file");
                conn.execute(
                    "INSERT INTO ontology_perceptual_hashes (file_id, phash, dhash, computed_at)
                     VALUES (1, x'0102030405060708', x'0807060504030201', 0)",
                    [],
                )
                .expect("seed a stale hash");
                conn.execute(
                    "INSERT INTO ontology_populator_state (populator_name, status, cursor)
                     VALUES ('PerceptualHashPopulator', 'completed', '9999')",
                    [],
                )
                .expect("seed populator state");
                conn.execute(
                    "INSERT INTO ontology_discoveries (kind, payload, confidence, potential_bytes_unlocked, status, created_at)
                     VALUES ('near-duplicate-cluster', '{}', 0.9, 0, 'pending', 0)",
                    [],
                )
                .expect("seed a pending discovery");
                conn.execute(
                    "INSERT INTO ontology_discoveries (kind, payload, confidence, potential_bytes_unlocked, status, created_at)
                     VALUES ('near-duplicate-cluster', '{\"kept\":true}', 0.9, 0, 'confirmed', 0)",
                    [],
                )
                .expect("seed a resolved discovery");
            }
            conn.execute_batch(sql).expect("migration applies");
        }

        let hashes: i64 = conn
            .query_row("SELECT COUNT(*) FROM ontology_perceptual_hashes", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(hashes, 0, "stale byte-bucket hashes must not survive");

        let cursor: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM ontology_populator_state WHERE populator_name = 'PerceptualHashPopulator'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(cursor, 0, "the resume cursor must be dropped so files are re-hashed");

        let pending: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM ontology_discoveries WHERE status = 'pending'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(pending, 0, "discoveries drawn from the old hashes must go");

        let resolved: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM ontology_discoveries WHERE status = 'confirmed'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(resolved, 1, "a decision a person made is not ours to erase");
    }

    #[test]
    fn exposes_current_migration() {
        assert_eq!(CURRENT_SCHEMA_VERSION, 26);
        assert_eq!(ALL_MIGRATIONS.len(), 26);
    }

    #[test]
    fn migration_010_creates_derived_stat_tables() {
        use rusqlite::Connection;
        let conn = Connection::open_in_memory().expect("open in-memory db");
        for (_, sql) in ALL_MIGRATIONS {
            conn.execute_batch(sql).expect("migration applies");
        }
        for table in ["media_stats", "folder_media_stats", "month_stats", "age_stats"] {
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |r| r.get(0),
                )
                .expect("query sqlite_master");
            assert_eq!(count, 1, "{table} must exist after migrations");
        }
    }

    #[test]
    fn migration_011_creates_catalog_tables() {
        use rusqlite::Connection;
        let conn = Connection::open_in_memory().expect("open in-memory db");
        for (_, sql) in ALL_MIGRATIONS {
            conn.execute_batch(sql).expect("migration applies");
        }
        for table in [
            "catalog_rules",
            "ontology_relocation_plans",
            "ontology_relocation_plan_items",
        ] {
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |r| r.get(0),
                )
                .expect("query sqlite_master");
            assert_eq!(count, 1, "{table} must exist after migrations");
        }
        for index in [
            "idx_files_kind_folder",
            "idx_discoveries_kind_status",
            "idx_relocation_items_plan",
        ] {
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?1",
                    [index],
                    |r| r.get(0),
                )
                .expect("query sqlite_master");
            assert_eq!(count, 1, "{index} must exist after migrations");
        }
    }

    #[test]
    fn migration_013_creates_the_move_log() {
        use rusqlite::Connection;
        let conn = Connection::open_in_memory().expect("open in-memory db");
        for (_, sql) in ALL_MIGRATIONS {
            conn.execute_batch(sql).expect("migration applies");
        }
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name IN
                   ('ontology_relocation_log', 'idx_relocation_log_moved_at')",
                [],
                |r| r.get(0),
            )
            .expect("query sqlite_master");
        assert_eq!(count, 2, "the move log and its index must exist after migrations");

        // The status column is the transition guard: nothing outside the two
        // legal values may be stored.
        conn.execute(
            "INSERT INTO ontology_relocation_log
                (from_path, to_path, size, moved_at, restore_status)
             VALUES ('a', 'b', 1, 0, 'somewhere-else')",
            [],
        )
        .expect_err("restore_status must be constrained");
    }

    #[test]
    fn migration_009_creates_scan_issues() {
        use rusqlite::Connection;
        let conn = Connection::open_in_memory().expect("open in-memory db");
        for (_, sql) in ALL_MIGRATIONS {
            conn.execute_batch(sql).expect("migration applies");
        }
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='scan_issues'",
                [],
                |r| r.get(0),
            )
            .expect("query sqlite_master");
        assert_eq!(count, 1, "scan_issues must exist after migrations");
    }

    /// A table nothing writes and nothing reads is not harmless: it is shaped
    /// like the right answer and has none of the provenance the ontology
    /// carries, so the next person to fill it loses that silently.
    #[test]
    fn the_dead_media_metadata_table_is_gone_after_migrations() {
        use rusqlite::Connection;
        let conn = Connection::open_in_memory().expect("open memory db");
        for (_, sql) in ALL_MIGRATIONS {
            conn.execute_batch(sql).expect("apply migration");
        }
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='media_metadata'",
                [],
                |r| r.get(0),
            )
            .expect("query sqlite_master");
        assert_eq!(count, 0, "media_metadata must not survive migrations");
    }

    #[test]
    fn migration_contains_core_tables_and_indexes() {
        for table in [
            "files",
            "folders",
            "scan_sessions",
            "duplicate_groups",
            "extension_stats",
            "timeline_history",
        ] {
            assert!(
                MIGRATION_001.contains(&format!("CREATE TABLE IF NOT EXISTS {table}")),
                "missing table {table}"
            );
        }

        for index in [
            "idx_files_size",
            "idx_files_hash",
            "idx_files_extension_size",
            "idx_folders_total_bytes",
        ] {
            assert!(MIGRATION_001.contains(index), "missing index {index}");
        }

        assert!(MIGRATION_002.contains("ADD COLUMN sample_hash"));
        assert!(MIGRATION_002.contains("ADD COLUMN hash_state"));
        assert!(MIGRATION_002.contains("duplicate_groups ADD COLUMN sample_hash"));
        assert!(MIGRATION_002.contains("idx_files_sample_hash"));
        assert!(MIGRATION_003.contains("ADD COLUMN scan_strategy"));
        assert!(MIGRATION_004.contains("duplicate_candidates"));
        assert!(MIGRATION_004.contains("hash_jobs"));
    }

    #[test]
    fn ontology_migration_present() {
        assert!(ALL_MIGRATIONS.iter().any(|(v, _)| *v == 5));
    }

    #[test]
    fn migration_005_contains_ontology_tables() {
        let mig = ALL_MIGRATIONS
            .iter()
            .find(|(v, _)| *v == 5)
            .expect("migration 5 missing")
            .1;

        for table in [
            "ontology_vocabulary_version",
            "ontology_entities",
            "ontology_attrs",
            "ontology_relations",
            "ontology_negative_assertions",
            "ontology_pinned_files",
            "ontology_enabled",
            "ontology_perceptual_hashes",
            "ontology_discoveries",
            "ontology_cleanup_log",
            "ontology_cleanup_plans",
        ] {
            assert!(
                mig.contains(&format!("CREATE TABLE IF NOT EXISTS {table}")),
                "migration 5 missing table {table}"
            );
        }

        for index in [
            "idx_ontology_entities_linked_file",
            "idx_ontology_entities_linked_folder",
            "idx_ontology_attrs_entity_key",
            "idx_ontology_relations_subj_pred",
            "idx_ontology_relations_pred_obj",
            "idx_phash",
            "idx_discoveries_status_roi",
        ] {
            assert!(mig.contains(index), "migration 5 missing index {index}");
        }
    }

    #[test]
    fn migration_005_applies_cleanly_in_memory() {
        use rusqlite::Connection;

        let conn = Connection::open_in_memory().expect("open in-memory db");
        for (_, sql) in ALL_MIGRATIONS {
            conn.execute_batch(sql)
                .expect("migration applies");
        }

        for table in [
            "ontology_entities",
            "ontology_attrs",
            "ontology_relations",
            "ontology_pinned_files",
            "ontology_enabled",
        ] {
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |r| r.get(0),
                )
                .expect("query sqlite_master");
            assert_eq!(count, 1, "table {table} missing after migrations");
        }

        let v: i64 = conn
            .query_row(
                "SELECT current_version FROM ontology_vocabulary_version",
                [],
                |r| r.get(0),
            )
            .expect("vocab version row");
        assert_eq!(v, 1);
    }

    #[test]
    fn migration_006_present_and_contains_populator_state() {
        let mig = ALL_MIGRATIONS
            .iter()
            .find(|(v, _)| *v == 6)
            .expect("migration 6 missing")
            .1;
        assert!(
            mig.contains("CREATE TABLE IF NOT EXISTS ontology_populator_state"),
            "migration 6 must create ontology_populator_state",
        );
        assert!(
            mig.contains("idx_populator_state_status"),
            "migration 6 must create the status index",
        );
    }

    #[test]
    fn migration_006_applies_cleanly_in_memory() {
        use rusqlite::Connection;

        let conn = Connection::open_in_memory().expect("open in-memory db");
        for (_, sql) in ALL_MIGRATIONS {
            conn.execute_batch(sql).expect("migration applies");
        }
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='ontology_populator_state'",
                [],
                |r| r.get(0),
            )
            .expect("query sqlite_master");
        assert_eq!(count, 1, "ontology_populator_state must exist after migrations");
    }

    #[test]
    fn migration_007_present_and_creates_cleanup_view() {
        let mig = ALL_MIGRATIONS
            .iter()
            .find(|(v, _)| *v == 7)
            .expect("migration 7 missing")
            .1;
        assert!(
            mig.contains("CREATE VIEW IF NOT EXISTS v_cleanup_candidates"),
            "migration 7 must create the v_cleanup_candidates view",
        );
    }

    #[test]
    fn migration_007_view_queryable_after_all_migrations() {
        use rusqlite::Connection;
        let conn = Connection::open_in_memory().expect("open in-memory db");
        for (_, sql) in ALL_MIGRATIONS {
            conn.execute_batch(sql).expect("migration applies");
        }
        // Empty index → view returns zero rows but must be a valid, queryable view.
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM v_cleanup_candidates", [], |r| r.get(0))
            .expect("view is queryable");
        assert_eq!(n, 0);
    }
}
