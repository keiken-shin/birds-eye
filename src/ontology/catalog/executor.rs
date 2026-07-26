//! Relocation execution, behind an injectable mover so failure paths are testable.

use crate::ontology::catalog::plans::{plan_items, set_item_status, set_plan_status};
use crate::ontology::OntologyError;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

/// The seam. `move_files` has no injection point of its own, so execution goes
/// through this trait and the real implementation delegates to the same logic.
pub trait Mover {
    fn move_one(&self, from: &str, to: &str) -> Result<(), String>;
}

pub struct SystemMover;

impl Mover for SystemMover {
    fn move_one(&self, from: &str, to: &str) -> Result<(), String> {
        let response = crate::native::api::move_files(crate::native::api::MoveFilesRequest {
            moves: vec![crate::native::api::MoveSpec {
                from: from.to_string(),
                to: to.to_string(),
            }],
            index_path: None,
        });
        match response.failed.first() {
            Some(failure) => Err(failure.reason.clone()),
            None => Ok(()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MovedPair {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RelocationFailure {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RelocationResult {
    pub plan_id: i64,
    pub moved: u64,
    pub bytes_moved: u64,
    /// Reversible (from, to) pairs — the frontend undoes by swapping them.
    pub pairs: Vec<MovedPair>,
    pub failed: Vec<RelocationFailure>,
}

/// Executes a relocation plan: moves each `"planned"` item on disk via
/// `mover` and records the outcome.
///
/// Residual window: the filesystem move can't join the DB transaction that
/// records it, so a crash between the two is possible. If the process dies
/// after `mover.move_one` succeeds but before `record_move`'s transaction
/// commits, the item stays `"planned"` while its source is already gone from
/// disk. A later re-run re-verifies the source (index row and disk path)
/// and, finding it missing, marks the item `"skipped"` — safe, nothing is
/// moved twice. A background rescan reconciles `deleted_at` either way.
pub fn execute_plan_with(
    conn: &mut Connection,
    plan_id: i64,
    mover: &dyn Mover,
) -> Result<RelocationResult, OntologyError> {
    let items = plan_items(conn, plan_id)?;
    let mut moved = 0_u64;
    let mut bytes_moved = 0_u64;
    let mut pairs = Vec::new();
    let mut failed = Vec::new();

    for item in items {
        if item.status != "planned" {
            continue;
        }

        // Re-verify at EXECUTE time, not only at plan time: an earlier move in
        // this same session marks sources deleted without inserting destinations.
        // `Option<Option<i64>>` — outer None means no row, inner Some means the
        // row is already soft-deleted. Both disqualify the item.
        let row: Option<Option<i64>> = conn
            .query_row(
                "SELECT deleted_at FROM files WHERE id = ?1",
                params![item.file_id],
                |row| row.get(0),
            )
            .optional()?;

        if !matches!(row, Some(None)) {
            set_item_status(conn, item.id, "skipped", Some("source no longer in the index"))?;
            continue;
        }
        if !std::path::Path::new(&item.from_path).exists() {
            set_item_status(conn, item.id, "skipped", Some("source no longer on disk"))?;
            continue;
        }

        match mover.move_one(&item.from_path, &item.to_path) {
            Ok(()) => {
                // The move has already happened on disk by this point, so it
                // is unconditionally reported as moved below regardless of
                // whether the index write succeeds — aborting here would
                // strand the rest of the plan and lose the pairs the UI
                // needs for undo.
                record_move(conn, item.id, item.file_id);
                moved += 1;
                bytes_moved += item.size.max(0) as u64;
                pairs.push(MovedPair {
                    from: item.from_path,
                    to: item.to_path,
                });
            }
            Err(reason) => {
                set_item_status(conn, item.id, "failed", Some(&reason))?;
                failed.push(RelocationFailure {
                    path: item.from_path,
                    reason,
                });
            }
        }
    }

    set_plan_status(conn, plan_id, "executed")?;
    Ok(RelocationResult {
        plan_id,
        moved,
        bytes_moved,
        pairs,
        failed,
    })
}

/// Marks an item `"moved"` and soft-deletes its source row in one
/// transaction, so the two writes are atomic with respect to each other. If
/// the transaction fails, falls back to a best-effort single-statement write
/// recording the failure on the item's note instead of leaving it silent —
/// the caller has already counted the move as successful either way.
fn record_move(conn: &mut Connection, item_id: i64, file_id: i64) {
    let outcome = (|| -> Result<(), OntologyError> {
        let tx = conn.transaction()?;
        set_item_status(&tx, item_id, "moved", None)?;
        tx.execute(
            "UPDATE files SET deleted_at = strftime('%s','now') WHERE id = ?1",
            params![file_id],
        )?;
        tx.commit()?;
        Ok(())
    })();

    if outcome.is_err() {
        let _ = set_item_status(
            conn,
            item_id,
            "moved",
            Some("moved; index update failed, will heal on next scan"),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::schema::ALL_MIGRATIONS;
    use crate::ontology::catalog::plans::{create_plan, plan_items, PlanItem};
    use rusqlite::Connection;
    use std::cell::RefCell;

    fn test_root(name: &str) -> std::path::PathBuf {
        let root = std::env::current_dir()
            .expect("failed to get current dir")
            .join("target")
            .join("catalog-executor-tests")
            .join(format!(
                "{}-{}",
                name,
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .expect("clock before epoch")
                    .as_nanos()
            ));
        cleanup(&root);
        std::fs::create_dir_all(&root).expect("create test root");
        root
    }

    fn cleanup(root: &std::path::Path) {
        if root.exists() {
            std::fs::remove_dir_all(root).expect("failed to remove test folder");
        }
    }

    fn migrated_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        for (_, sql) in ALL_MIGRATIONS {
            conn.execute_batch(sql).unwrap();
        }
        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
             VALUES (1, NULL, 'C:\\Inbox', 'Inbox', 0, 0)",
            [],
        )
        .unwrap();
        conn
    }

    /// Writes a REAL file and indexes it. `execute_plan_with` stats the disk at
    /// execute time, so a row pointing at a path that does not exist is skipped —
    /// these fixtures must be real.
    fn seed_file(conn: &Connection, id: i64, path: &std::path::Path) {
        std::fs::write(path, [7u8; 10]).expect("write fixture file");
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, size, media_kind, indexed_at)
             VALUES (?1, 1, ?2, 'f.exe', 10, 'installer', 0)",
            rusqlite::params![id, path.to_string_lossy()],
        )
        .expect("index fixture file");
    }

    /// Records calls and fails any move whose source is in `fail`.
    struct FakeMover {
        fail: Vec<String>,
        calls: RefCell<Vec<(String, String)>>,
    }

    impl Mover for FakeMover {
        fn move_one(&self, from: &str, to: &str) -> Result<(), String> {
            self.calls.borrow_mut().push((from.to_string(), to.to_string()));
            if self.fail.iter().any(|f| f == from) {
                return Err("locked by another process".to_string());
            }
            Ok(())
        }
    }

    #[test]
    fn moves_every_item_and_returns_reversible_pairs() {
        let root = test_root("moves-every-item");
        let from = root.join("a.exe");
        let to = root.join("dest").join("a.exe");
        let mut conn = migrated_conn();
        seed_file(&conn, 1, &from);
        let plan_id = create_plan(
            &conn,
            &[PlanItem {
                file_id: 1,
                from_path: from.to_string_lossy().to_string(),
                to_path: to.to_string_lossy().to_string(),
                size: 10,
                discovery_id: None,
            }],
        )
        .unwrap();

        let mover = FakeMover { fail: vec![], calls: RefCell::new(vec![]) };
        let result = execute_plan_with(&mut conn, plan_id, &mover).unwrap();

        assert_eq!(result.moved, 1);
        assert_eq!(result.bytes_moved, 10);
        assert_eq!(result.pairs.len(), 1);
        assert_eq!(result.pairs[0].from, from.to_string_lossy());
        assert_eq!(result.pairs[0].to, to.to_string_lossy());
        assert!(result.failed.is_empty());

        // The source row is marked deleted so views drop it before the rescan.
        let deleted: Option<i64> = conn
            .query_row("SELECT deleted_at FROM files WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert!(deleted.is_some());

        let status: String = conn
            .query_row(
                "SELECT status FROM ontology_relocation_plans WHERE id = ?1",
                [plan_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(status, "executed");
        assert_eq!(plan_items(&conn, plan_id).unwrap()[0].status, "moved");
        cleanup(&root);
    }

    #[test]
    fn a_partial_failure_keeps_the_good_moves_and_records_the_bad() {
        let root = test_root("partial-failure");
        let ok = root.join("ok.exe");
        let locked = root.join("locked.exe");
        let mut conn = migrated_conn();
        seed_file(&conn, 1, &ok);
        seed_file(&conn, 2, &locked);
        let plan_id = create_plan(
            &conn,
            &[
                PlanItem {
                    file_id: 1,
                    from_path: ok.to_string_lossy().to_string(),
                    to_path: root.join("dest").join("ok.exe").to_string_lossy().to_string(),
                    size: 10,
                    discovery_id: None,
                },
                PlanItem {
                    file_id: 2,
                    from_path: locked.to_string_lossy().to_string(),
                    to_path: root.join("dest").join("locked.exe").to_string_lossy().to_string(),
                    size: 20,
                    discovery_id: None,
                },
            ],
        )
        .unwrap();

        let mover = FakeMover {
            fail: vec![locked.to_string_lossy().to_string()],
            calls: RefCell::new(vec![]),
        };
        let result = execute_plan_with(&mut conn, plan_id, &mover).unwrap();

        assert_eq!(result.moved, 1);
        assert_eq!(result.bytes_moved, 10);
        assert_eq!(result.failed.len(), 1);
        assert_eq!(result.failed[0].path, locked.to_string_lossy());
        assert!(result.failed[0].reason.contains("locked"));

        let items = plan_items(&conn, plan_id).unwrap();
        assert_eq!(items[0].status, "moved");
        assert_eq!(items[1].status, "failed");

        // The failed file must NOT be marked deleted — it is still there.
        let deleted: Option<i64> = conn
            .query_row("SELECT deleted_at FROM files WHERE id = 2", [], |r| r.get(0))
            .unwrap();
        assert!(deleted.is_none());
        cleanup(&root);
    }

    #[test]
    fn skips_items_whose_source_row_is_already_deleted() {
        let root = test_root("skips-deleted");
        let gone = root.join("gone.exe");
        let mut conn = migrated_conn();
        seed_file(&conn, 1, &gone);
        conn.execute("UPDATE files SET deleted_at = 1 WHERE id = 1", []).unwrap();
        let plan_id = create_plan(
            &conn,
            &[PlanItem {
                file_id: 1,
                from_path: gone.to_string_lossy().to_string(),
                to_path: root.join("dest").join("gone.exe").to_string_lossy().to_string(),
                size: 10,
                discovery_id: None,
            }],
        )
        .unwrap();

        let mover = FakeMover { fail: vec![], calls: RefCell::new(vec![]) };
        let result = execute_plan_with(&mut conn, plan_id, &mover).unwrap();

        assert_eq!(result.moved, 0);
        assert!(mover.calls.borrow().is_empty(), "a deleted source is never touched on disk");
        assert_eq!(plan_items(&conn, plan_id).unwrap()[0].status, "skipped");
        cleanup(&root);
    }

    #[test]
    fn skips_an_item_whose_file_vanished_from_disk() {
        let root = test_root("skips-vanished");
        let vanished = root.join("vanished.exe");
        let mut conn = migrated_conn();
        seed_file(&conn, 1, &vanished);
        std::fs::remove_file(&vanished).expect("delete the fixture out from under the plan");
        let plan_id = create_plan(
            &conn,
            &[PlanItem {
                file_id: 1,
                from_path: vanished.to_string_lossy().to_string(),
                to_path: root.join("dest").join("vanished.exe").to_string_lossy().to_string(),
                size: 10,
                discovery_id: None,
            }],
        )
        .unwrap();

        let mover = FakeMover { fail: vec![], calls: RefCell::new(vec![]) };
        let result = execute_plan_with(&mut conn, plan_id, &mover).unwrap();

        assert_eq!(result.moved, 0);
        assert!(mover.calls.borrow().is_empty());
        assert_eq!(plan_items(&conn, plan_id).unwrap()[0].status, "skipped");
        cleanup(&root);
    }

    #[test]
    fn an_index_write_failure_is_recorded_on_the_item_not_swallowed() {
        let root = test_root("index-write-failure");
        let from = root.join("a.exe");
        let to = root.join("dest").join("a.exe");
        let mut conn = migrated_conn();
        seed_file(&conn, 1, &from);
        let plan_id = create_plan(
            &conn,
            &[PlanItem {
                file_id: 1,
                from_path: from.to_string_lossy().to_string(),
                to_path: to.to_string_lossy().to_string(),
                size: 10,
                discovery_id: None,
            }],
        )
        .unwrap();

        // Genuinely (not by calling internals) make the `deleted_at` UPDATE
        // for this row fail: a trigger that aborts that specific write. This
        // forces record_move's transaction to fail and roll back, so the
        // fallback single-statement note path is exercised for real.
        conn.execute_batch(
            "CREATE TRIGGER block_deleted_at
             BEFORE UPDATE OF deleted_at ON files
             WHEN NEW.id = 1
             BEGIN
                 SELECT RAISE(ABORT, 'blocked for test');
             END;",
        )
        .unwrap();

        let mover = FakeMover { fail: vec![], calls: RefCell::new(vec![]) };
        let result = execute_plan_with(&mut conn, plan_id, &mover).unwrap();

        // The move genuinely happened, so it is still reported as moved and
        // still present in `pairs` for the frontend's undo.
        assert_eq!(result.moved, 1);
        assert_eq!(result.pairs.len(), 1);
        assert!(result.failed.is_empty());

        let items = plan_items(&conn, plan_id).unwrap();
        assert_eq!(items[0].status, "moved");
        assert_eq!(
            items[0].note.as_deref(),
            Some("moved; index update failed, will heal on next scan"),
            "the index-write failure must be visible on the item, not silent"
        );
        cleanup(&root);
    }

    #[test]
    fn executing_an_already_executed_plan_moves_nothing_again() {
        let root = test_root("idempotent-execute");
        let from = root.join("a.exe");
        let to = root.join("dest").join("a.exe");
        let mut conn = migrated_conn();
        seed_file(&conn, 1, &from);
        let plan_id = create_plan(
            &conn,
            &[PlanItem {
                file_id: 1,
                from_path: from.to_string_lossy().to_string(),
                to_path: to.to_string_lossy().to_string(),
                size: 10,
                discovery_id: None,
            }],
        )
        .unwrap();

        let mover = FakeMover { fail: vec![], calls: RefCell::new(vec![]) };
        let first = execute_plan_with(&mut conn, plan_id, &mover).unwrap();
        assert_eq!(first.moved, 1);
        assert_eq!(mover.calls.borrow().len(), 1);

        let second = execute_plan_with(&mut conn, plan_id, &mover).unwrap();

        assert_eq!(second.moved, 0);
        assert!(second.pairs.is_empty());
        assert!(second.failed.is_empty());
        assert_eq!(
            mover.calls.borrow().len(),
            1,
            "an already-moved item must never be handed to the mover again"
        );
        assert_eq!(plan_items(&conn, plan_id).unwrap()[0].status, "moved");
        cleanup(&root);
    }

    #[test]
    fn a_plan_with_only_skipped_items_still_finishes_executed() {
        let root = test_root("only-skipped-executed");
        let gone = root.join("gone.exe");
        let mut conn = migrated_conn();
        seed_file(&conn, 1, &gone);
        conn.execute("UPDATE files SET deleted_at = 1 WHERE id = 1", []).unwrap();
        let plan_id = create_plan(
            &conn,
            &[PlanItem {
                file_id: 1,
                from_path: gone.to_string_lossy().to_string(),
                to_path: root.join("dest").join("gone.exe").to_string_lossy().to_string(),
                size: 10,
                discovery_id: None,
            }],
        )
        .unwrap();

        let mover = FakeMover { fail: vec![], calls: RefCell::new(vec![]) };
        let result = execute_plan_with(&mut conn, plan_id, &mover).unwrap();

        assert_eq!(result.moved, 0);
        assert!(result.failed.is_empty());
        assert_eq!(plan_items(&conn, plan_id).unwrap()[0].status, "skipped");

        let status: String = conn
            .query_row(
                "SELECT status FROM ontology_relocation_plans WHERE id = ?1",
                [plan_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            status, "executed",
            "a plan whose only item was skipped still finishes executed"
        );
        cleanup(&root);
    }
}
