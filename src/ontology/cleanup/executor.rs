//! Recycle-bin-first cleanup-plan executor.
//!
//! Constitutional Defense #1 (no hard delete), #2 (recycle-bin always; persistent
//! restore log), #7 (gating-fact snapshot stored per cleaned file), #11 (per-file
//! failure isolation). The platform recycle-bin call is the only side effect and
//! it is injected via `Trasher` so it is testable without an OS recycle bin.

use crate::ontology::attrs::resolve_attr;
use crate::ontology::cleanup::plans::{candidates_for_plan, get_plan, set_plan_status};
use crate::ontology::cleanup::{unix_now, CleanupCandidate, GatingFacts};
use crate::ontology::vocabulary::keys;
use crate::ontology::OntologyError;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Default restore-log retention window (Constitutional Defense #1).
pub const DEFAULT_RETENTION_DAYS: i64 = 90;
const SECONDS_PER_DAY: i64 = 86_400;

/// Abstraction over "send this path to the OS recycle bin". Production uses the
/// `trash` crate; tests inject a fake that records calls / moves files aside.
pub trait Trasher {
    fn send_to_trash(&self, path: &Path) -> Result<(), String>;
}

/// Production trasher — the OS recycle bin via the `trash` crate.
pub struct SystemTrasher;

impl Trasher for SystemTrasher {
    fn send_to_trash(&self, path: &Path) -> Result<(), String> {
        trash::delete(path).map_err(|e| e.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CleanupFailure {
    pub file_id: i64,
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CleanupResult {
    pub plan_id: i64,
    pub cleaned: u64,
    pub bytes_cleaned: u64,
    pub failed: Vec<CleanupFailure>,
}

/// Execute a draft plan with an injected trasher and retention window.
pub fn execute_plan_with(
    conn: &mut Connection,
    plan_id: i64,
    trasher: &dyn Trasher,
    retention_days: i64,
) -> Result<CleanupResult, OntologyError> {
    let plan = get_plan(conn, plan_id)?
        .ok_or_else(|| OntologyError::Populator(format!("cleanup plan {plan_id} not found")))?;
    if plan.status != "draft" {
        return Err(OntologyError::Populator(format!(
            "cleanup plan {plan_id} is not a draft (status={})",
            plan.status
        )));
    }

    // Re-evaluate the predicate now — facts may have changed since the plan was drafted.
    let candidates = candidates_for_plan(conn, plan_id)?;

    let now = unix_now();
    let expires_at = now + retention_days.max(0) * SECONDS_PER_DAY;

    let mut cleaned = 0_u64;
    let mut bytes_cleaned = 0_u64;
    let mut failed = Vec::new();

    for cand in &candidates {
        let gating = gating_facts_for(conn, cand)?;
        let gating_json = serde_json::to_string(&gating)?;

        match trasher.send_to_trash(Path::new(&cand.path)) {
            Ok(()) => {
                // Record the cleanup BEFORE marking the file deleted, so a crash
                // between the two leaves a recoverable log entry.
                conn.execute(
                    "INSERT INTO ontology_cleanup_log
                        (cleanup_plan_id, file_id, original_path, size, cleaned_at, reason,
                         gating_facts, restore_status, expires_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'in_recycle_bin', ?8)",
                    params![
                        plan_id,
                        cand.file_id,
                        cand.path,
                        cand.size,
                        now,
                        cand.reason,
                        gating_json,
                        expires_at,
                    ],
                )?;
                conn.execute(
                    "UPDATE files SET deleted_at = ?2 WHERE id = ?1",
                    params![cand.file_id, now],
                )?;
                cleaned += 1;
                bytes_cleaned += cand.size.max(0) as u64;
            }
            Err(reason) => {
                // Per-file isolation: one failure does not abort the plan.
                failed.push(CleanupFailure {
                    file_id: cand.file_id,
                    path: cand.path.clone(),
                    reason,
                });
            }
        }
    }

    set_plan_status(conn, plan_id, "executed", Some(now))?;

    Ok(CleanupResult {
        plan_id,
        cleaned,
        bytes_cleaned,
        failed,
    })
}

/// Public entry point: open the index, use the OS recycle bin and the default
/// retention window.
pub fn execute_cleanup_plan(
    index_path: &Path,
    plan_id: i64,
) -> Result<CleanupResult, OntologyError> {
    let mut conn = Connection::open(index_path)?;
    execute_plan_with(&mut conn, plan_id, &SystemTrasher, DEFAULT_RETENTION_DAYS)
}

/// Build the provenance snapshot for a candidate (Constitutional Defense #7).
fn gating_facts_for(
    conn: &Connection,
    cand: &CleanupCandidate,
) -> Result<GatingFacts, OntologyError> {
    let role = resolve_attr(conn, cand.entity_id, keys::ROLE)?.map(|a| a.value);
    let replaceability =
        resolve_attr(conn, cand.entity_id, keys::REPLACEABILITY)?.map(|a| a.value);
    let sensitivity = resolve_attr(conn, cand.entity_id, keys::SENSITIVITY)?.map(|a| a.value);
    Ok(GatingFacts {
        reason: cand.reason.clone(),
        role,
        replaceability,
        sensitivity,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::schema::ALL_MIGRATIONS;
    use crate::ontology::attrs::{assert_attr, NewAssertion};
    use crate::ontology::cleanup::plans::{create_plan, CleanupScope};
    use crate::ontology::entities::upsert_entity;
    use crate::ontology::vocabulary::{keys, EntityKind};
    use rusqlite::Connection;
    use std::sync::Mutex;

    fn migrated_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        for (_, sql) in ALL_MIGRATIONS {
            conn.execute_batch(sql).unwrap();
        }
        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
             VALUES (1, NULL, '/root', 'root', 0, 0)",
            [],
        )
        .unwrap();
        conn
    }

    fn add_scratch_file(conn: &Connection, id: i64, path: &str, size: i64) {
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, size, indexed_at)
             VALUES (?1, 1, ?2, ?2, ?3, 0)",
            rusqlite::params![id, path, size],
        )
        .unwrap();
        let eid = upsert_entity(conn, EntityKind::File, path, Some(id), None, None)
            .unwrap()
            .id;
        assert_attr(
            conn,
            eid,
            &NewAssertion {
                key: keys::ROLE,
                value: "scratch",
                source: "rule:test",
                confidence: 0.95,
                display_in_global_views: true,
            },
        )
        .unwrap();
    }

    /// Records each path it was asked to trash; never touches the filesystem.
    struct RecordingTrasher {
        seen: Mutex<Vec<String>>,
    }
    impl RecordingTrasher {
        fn new() -> Self {
            Self { seen: Mutex::new(Vec::new()) }
        }
    }
    impl Trasher for RecordingTrasher {
        fn send_to_trash(&self, path: &Path) -> Result<(), String> {
            self.seen.lock().unwrap().push(path.display().to_string());
            Ok(())
        }
    }

    /// Fails for one specific path; succeeds for the rest.
    struct FlakyTrasher {
        fail_path: String,
    }
    impl Trasher for FlakyTrasher {
        fn send_to_trash(&self, path: &Path) -> Result<(), String> {
            if path.display().to_string() == self.fail_path {
                Err("simulated trash failure".to_string())
            } else {
                Ok(())
            }
        }
    }

    #[test]
    fn execute_trashes_candidates_and_logs_them() {
        let mut conn = migrated_conn();
        add_scratch_file(&conn, 1, "/root/dist/a.js", 100);
        add_scratch_file(&conn, 2, "/root/dist/b.js", 200);
        let plan_id = create_plan(&conn, &CleanupScope::default()).unwrap();

        let trasher = RecordingTrasher::new();
        let result = execute_plan_with(&mut conn, plan_id, &trasher, 90).unwrap();

        assert_eq!(result.cleaned, 2);
        assert_eq!(result.bytes_cleaned, 300);
        assert!(result.failed.is_empty());
        assert_eq!(trasher.seen.lock().unwrap().len(), 2);

        // Both files marked deleted in the index.
        let deleted: i64 = conn
            .query_row("SELECT COUNT(*) FROM files WHERE deleted_at IS NOT NULL", [], |r| r.get(0))
            .unwrap();
        assert_eq!(deleted, 2);

        // Two log rows, in_recycle_bin, with non-empty gating facts and a future expiry.
        let logs: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM ontology_cleanup_log
                 WHERE restore_status='in_recycle_bin' AND gating_facts != '' AND expires_at > cleaned_at",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(logs, 2);

        // Plan marked executed.
        let status: String = conn
            .query_row("SELECT status FROM ontology_cleanup_plans WHERE id=?1", params![plan_id], |r| r.get(0))
            .unwrap();
        assert_eq!(status, "executed");
    }

    #[test]
    fn per_file_failure_is_isolated() {
        // Constitutional Defense #11.
        let mut conn = migrated_conn();
        add_scratch_file(&conn, 1, "/root/dist/a.js", 100);
        add_scratch_file(&conn, 2, "/root/dist/b.js", 200);
        let plan_id = create_plan(&conn, &CleanupScope::default()).unwrap();

        let trasher = FlakyTrasher { fail_path: "/root/dist/a.js".to_string() };
        let result = execute_plan_with(&mut conn, plan_id, &trasher, 90).unwrap();

        assert_eq!(result.cleaned, 1, "the good file still gets cleaned");
        assert_eq!(result.failed.len(), 1);
        assert_eq!(result.failed[0].file_id, 1);

        // Only the succeeding file is marked deleted / logged.
        let deleted: i64 = conn
            .query_row("SELECT id FROM files WHERE deleted_at IS NOT NULL", [], |r| r.get(0))
            .unwrap();
        assert_eq!(deleted, 2);
        let logged: i64 = conn
            .query_row("SELECT file_id FROM ontology_cleanup_log", [], |r| r.get(0))
            .unwrap();
        assert_eq!(logged, 2);
    }

    #[test]
    fn gating_facts_snapshot_captures_reason_and_role() {
        let mut conn = migrated_conn();
        add_scratch_file(&conn, 1, "/root/dist/a.js", 100);
        let plan_id = create_plan(&conn, &CleanupScope::default()).unwrap();

        let trasher = RecordingTrasher::new();
        execute_plan_with(&mut conn, plan_id, &trasher, 90).unwrap();

        let gating_json: String = conn
            .query_row("SELECT gating_facts FROM ontology_cleanup_log WHERE file_id=1", [], |r| r.get(0))
            .unwrap();
        let gating: GatingFacts = serde_json::from_str(&gating_json).unwrap();
        assert_eq!(gating.reason, "scratch");
        assert_eq!(gating.role.as_deref(), Some("scratch"));
    }

    #[test]
    fn executing_a_non_draft_plan_errors() {
        let mut conn = migrated_conn();
        let plan_id = create_plan(&conn, &CleanupScope::default()).unwrap();
        let trasher = RecordingTrasher::new();
        execute_plan_with(&mut conn, plan_id, &trasher, 90).unwrap();
        // Second execution must refuse — the plan is now 'executed'.
        let err = execute_plan_with(&mut conn, plan_id, &trasher, 90);
        assert!(err.is_err());
    }
}
