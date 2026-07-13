pub const CURRENT_SCHEMA_VERSION: u32 = 9;

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
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_current_migration() {
        assert_eq!(CURRENT_SCHEMA_VERSION, 9);
        assert_eq!(ALL_MIGRATIONS.len(), 9);
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

    #[test]
    fn migration_contains_core_tables_and_indexes() {
        for table in [
            "files",
            "folders",
            "scan_sessions",
            "duplicate_groups",
            "media_metadata",
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
        assert!(CURRENT_SCHEMA_VERSION >= 5);
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
        assert!(CURRENT_SCHEMA_VERSION >= 6);
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
        assert!(CURRENT_SCHEMA_VERSION >= 7);
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
