//! Relocation execution, behind an injectable mover so failure paths are testable.

use crate::ontology::catalog::plans::{plan_items, set_item_status, set_plan_status};
use crate::ontology::catalog::relocation_log::{abandon_move, complete_move, log_move_pending};
use crate::ontology::fs_identity::unchanged_at;
use crate::ontology::OntologyError;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

/// The seam. `move_files` has no injection point of its own, so execution goes
/// through this trait and the real implementation delegates to the same logic.
pub trait Mover {
    fn move_one(&self, from: &str, to: &str) -> Result<(), String>;
}

pub struct SystemMover {
    /// The index whose move log this move is appended to, and whose rows are
    /// reconciled. `None` for a put-back: the log entry being restored already
    /// records that move and its status records the undo, so a second row would
    /// double every entry in the list the user reads.
    pub index_path: Option<std::path::PathBuf>,
}

impl Mover for SystemMover {
    fn move_one(&self, from: &str, to: &str) -> Result<(), String> {
        let response = crate::native::api::move_files(crate::native::api::MoveFilesRequest {
            moves: vec![crate::native::api::MoveSpec {
                from: from.to_string(),
                to: to.to_string(),
            }],
            index_path: self.index_path.clone(),
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
    /// Reversible (from, to) pairs — kept for display; the undo itself goes
    /// through `entry_ids`, not by swapping these back through a raw move.
    pub pairs: Vec<MovedPair>,
    /// Move-log rows for the files that actually moved, in `pairs` order.
    /// Undo needs these: `restore_from_relocation_log` takes an entry id, and
    /// without them the only reachable undo was a session-scoped pair reversal
    /// that died with the window.
    pub entry_ids: Vec<i64>,
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

    // Everything the plan needs from the destination side, asked once, before
    // any bytes move. A trash is as safe to attempt as to ask about, so the
    // cleanup path can just try. A move is not: it has a real half-done state,
    // and a plan that fills a disk on its fortieth file has already scattered
    // thirty-nine.
    if let Err(reason) = preflight_destinations(&items) {
        return Err(OntologyError::Populator(reason));
    }

    let mut moved = 0_u64;
    let mut bytes_moved = 0_u64;
    let mut pairs = Vec::new();
    let mut entry_ids = Vec::new();
    let mut failed = Vec::new();

    for item in items {
        if item.status != "planned" {
            continue;
        }

        // Re-verify at EXECUTE time, not only at plan time: an earlier move in
        // this same session marks sources deleted without inserting destinations.
        // `Option<Option<i64>>` — outer None means no row, inner Some means the
        // row is already soft-deleted. Both disqualify the item.
        let row: Option<(Option<i64>, i64, Option<i64>, Option<String>)> = conn
            .query_row(
                "SELECT deleted_at, size, modified_at, object_id FROM files WHERE id = ?1",
                params![item.file_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;

        let Some((None, reviewed_size, reviewed_modified, reviewed_object)) = row else {
            set_item_status(conn, item.id, "skipped", Some("source no longer in the index"))?;
            continue;
        };

        // Existence is not identity. If the reviewed file was replaced between
        // plan and execute, moving the replacement files something the user
        // never chose to file, and writes an undo row naming the wrong object.
        // The reason is passed through rather than flattened to "no longer on
        // disk", because "it vanished" and "it changed" need different actions
        // from the person reading it.
        if let Err(reason) = unchanged_at(
            std::path::Path::new(&item.from_path),
            reviewed_size,
            reviewed_modified,
            reviewed_object.as_deref(),
        ) {
            set_item_status(conn, item.id, "skipped", Some(&reason))?;
            continue;
        }

        // Opened before the bytes move, so a crash in between leaves a row
        // saying a move was in flight instead of leaving no trace at all.
        // Best-effort, like `complete_move` and `abandon_move` beside it. `?`
        // here would abort a plan mid-flight on a transient DB error: earlier
        // files already moved, the plan never reaches "executed", and the
        // caller loses the entry ids for the moves that did happen. A missing
        // log row costs the undo button; an aborted plan costs the record of
        // everything before it.
        let entry_id = log_move_pending(conn, &item.from_path, &item.to_path, Some(item.file_id))
            .unwrap_or(-1);

        match mover.move_one(&item.from_path, &item.to_path) {
            Ok(()) => {
                if entry_id >= 0 {
                    let _ = complete_move(conn, entry_id, &item.to_path);
                    entry_ids.push(entry_id);
                }
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
                // Nothing happened on disk, so the pending row describes a move
                // that never was. Drop it rather than offering an undo for it.
                if entry_id >= 0 {
                    let _ = abandon_move(conn, entry_id);
                }
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
        entry_ids,
        failed,
    })
}

/// Ask the destination side the questions that are true of the whole plan,
/// before the first byte moves. `Err(reason)` refuses the plan, leaving it
/// untouched and retryable once the person has fixed what the reason names.
///
/// Only plan-wide facts belong here: whether the destination volume is there at
/// all, and whether it has room. Anything that can be true of one item and
/// false of the next -- a destination parent that is really a file, a name
/// already taken -- stays per-item in the loop below, where it fails that item
/// and leaves the other forty alone. Refusing forty moves because the
/// forty-first has a bad name is not caution, it is a worse outcome.
fn preflight_destinations(
    items: &[crate::ontology::catalog::plans::PlannedItem],
) -> Result<(), String> {
    use std::collections::{HashMap, HashSet};
    use std::path::Path;

    let mut roots: HashSet<String> = HashSet::new();
    // Bytes each destination volume has to find room for. A move within one
    // volume is a rename and costs nothing, so only crossings are counted.
    let mut needed: HashMap<String, u64> = HashMap::new();

    for item in items.iter().filter(|item| item.status == "planned") {
        let to = Path::new(&item.to_path);
        let from = Path::new(&item.from_path);
        let Some(root) = crate::native::drives::volume_root_of(to) else {
            // A destination this cannot reduce to a named volume is not a
            // finding about the plan. The per-item move will say what is wrong
            // with it.
            continue;
        };
        roots.insert(root.clone());
        // `Some(false)` and nothing else: an unanswered question is not a
        // reason to claim a crossing.
        if crate::native::drives::same_volume(from, to) == Some(false) {
            *needed.entry(root).or_default() += item.size.max(0) as u64;
        }
    }

    for root in &roots {
        if !Path::new(root).exists() {
            return Err(format!(
                "the destination drive {root} is not connected -- nothing has been moved"
            ));
        }
    }

    for (root, bytes) in needed {
        // `None` is "the volume would not say", not "zero free". Refusing on an
        // unanswered question would make the check the thing that blocks the
        // work.
        let Some(free) = crate::native::drives::free_bytes(Path::new(&root)) else {
            continue;
        };
        if free < bytes {
            return Err(format!(
                "this needs {bytes} bytes on {root} and only {free} are free --                  nothing has been moved"
            ));
        }
    }

    Ok(())
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

    /// Writes a REAL file and indexes it with the size and last-modified it
    /// actually has. `execute_plan_with` re-checks the file's identity at
    /// execute time, so a row pointing at a path that does not exist -- or at a
    /// different object than the one reviewed -- is skipped. These fixtures must
    /// be real, and their recorded identity must be the real one.
    fn seed_file(conn: &Connection, id: i64, path: &std::path::Path) {
        std::fs::write(path, [7u8; 10]).expect("write fixture file");
        let meta = std::fs::metadata(path).expect("stat fixture file");
        let modified = crate::ontology::fs_identity::modified_secs(&meta);
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, size, modified_at, media_kind, indexed_at)
             VALUES (?1, 1, ?2, 'f.exe', 10, ?3, 'installer', 0)",
            rusqlite::params![id, path.to_string_lossy(), modified],
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

    /// A drive letter nothing is mounted on, so the destination is genuinely
    /// unreachable rather than merely unusual.
    #[cfg(windows)]
    fn drive_root(letter: char) -> std::path::PathBuf {
        std::path::PathBuf::from(format!("{letter}:{}", std::path::MAIN_SEPARATOR))
    }

    #[cfg(windows)]
    fn an_unused_drive_letter() -> char {
        ('D'..='Z')
            .rev()
            .find(|letter| !drive_root(*letter).exists())
            .expect("no free drive letter on this machine")
    }

    /// A move has a real half-done state, so an unreachable destination has to
    /// stop the plan before the first file rather than after the fortieth.
    #[cfg(windows)]
    #[test]
    fn an_unreachable_destination_stops_the_plan_before_anything_moves() {
        let root = test_root("dest-unreachable");
        let from = root.join("a.exe");
        let mut conn = migrated_conn();
        seed_file(&conn, 1, &from);
        let to = drive_root(an_unused_drive_letter())
            .join("filed")
            .join("a.exe")
            .to_string_lossy()
            .to_string();
        let plan_id = create_plan(
            &conn,
            &[PlanItem {
                file_id: 1,
                from_path: from.to_string_lossy().to_string(),
                to_path: to,
                size: 10,
                discovery_id: None,
            }],
        )
        .unwrap();

        let mover = FakeMover { fail: vec![], calls: RefCell::new(vec![]) };
        let error = execute_plan_with(&mut conn, plan_id, &mover)
            .expect_err("an unreachable destination must refuse the plan");
        assert!(
            error.to_string().contains("is not connected"),
            "the message has to name the destination problem: {error}"
        );
        assert!(mover.calls.borrow().is_empty(), "nothing may be attempted");

        // The plan is untouched, so it is still there to run once the drive is
        // connected. Marking it executed would lose it.
        let status: String = conn
            .query_row(
                "SELECT status FROM ontology_relocation_plans WHERE id = ?1",
                params![plan_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_ne!(status, "executed");
        cleanup(&root);
    }

    /// The destination has to hold the bytes. Filling a disk on the fortieth
    /// file has already scattered thirty-nine.
    #[cfg(windows)]
    #[test]
    fn a_cross_volume_plan_that_cannot_fit_is_refused_before_anything_moves() {
        let root = test_root("dest-too-small");
        let from = root.join("huge.bin");
        let mut conn = migrated_conn();
        seed_file(&conn, 1, &from);
        // std::env::temp_dir() and the build tree are on different volumes on
        // this machine; if they ever are not, the crossing check will not fire
        // and this test says so rather than passing quietly.
        let to = std::env::temp_dir().join("birdseye-preflight").join("huge.bin");
        assert_eq!(
            crate::native::drives::same_volume(&from, &to),
            Some(false),
            "this test needs a genuine cross-volume pair"
        );
        let plan_id = create_plan(
            &conn,
            &[PlanItem {
                file_id: 1,
                from_path: from.to_string_lossy().to_string(),
                to_path: to.to_string_lossy().to_string(),
                size: i64::MAX,
                discovery_id: None,
            }],
        )
        .unwrap();

        let mover = FakeMover { fail: vec![], calls: RefCell::new(vec![]) };
        let error = execute_plan_with(&mut conn, plan_id, &mover)
            .expect_err("no volume has i64::MAX bytes free");
        assert!(
            error.to_string().contains("nothing has been moved"),
            "the message has to say the plan did not start: {error}"
        );
        assert!(mover.calls.borrow().is_empty(), "nothing may be attempted");
        cleanup(&root);
    }

    /// The counterpart, and the reason the crossing test above is not just a
    /// size check: a move within one volume is a rename and needs no space at
    /// all, so an enormous same-volume plan must go straight through.
    #[test]
    fn a_same_volume_plan_is_never_refused_for_space() {
        let root = test_root("same-volume-huge");
        let from = root.join("huge.bin");
        let to = root.join("filed").join("huge.bin");
        let mut conn = migrated_conn();
        seed_file(&conn, 1, &from);
        let plan_id = create_plan(
            &conn,
            &[PlanItem {
                file_id: 1,
                from_path: from.to_string_lossy().to_string(),
                to_path: to.to_string_lossy().to_string(),
                size: i64::MAX,
                discovery_id: None,
            }],
        )
        .unwrap();

        let mover = FakeMover { fail: vec![], calls: RefCell::new(vec![]) };
        let result = execute_plan_with(&mut conn, plan_id, &mover)
            .expect("a rename consumes no space, so this must not be refused");
        assert_eq!(result.moved, 1);
        cleanup(&root);
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

    /// Same-path, same-size, different file. Existence would wave this through
    /// and file a document the user never chose to file.
    /// Same protection, from the filesystem's own answer: the row names an
    /// object that is not the one at that path any more.
    #[test]
    fn skips_an_item_whose_file_is_now_a_different_object() {
        let root = test_root("skips-other-object");
        let from = root.join("swapped.exe");
        let mut conn = migrated_conn();
        seed_file(&conn, 1, &from);
        conn.execute(
            "UPDATE files SET object_id = 'ffffffffffffffff:             ffffffffffffffffffffffffffffffff' WHERE id = 1",
            [],
        )
        .unwrap();

        let plan_id = create_plan(
            &conn,
            &[PlanItem {
                file_id: 1,
                from_path: from.to_string_lossy().to_string(),
                to_path: root
                    .join("dest")
                    .join("swapped.exe")
                    .to_string_lossy()
                    .to_string(),
                size: 10,
                discovery_id: None,
            }],
        )
        .unwrap();

        let mover = FakeMover {
            fail: vec![],
            calls: RefCell::new(vec![]),
        };
        let result = execute_plan_with(&mut conn, plan_id, &mover).unwrap();

        assert_eq!(result.moved, 0);
        assert!(
            mover.calls.borrow().is_empty(),
            "a different object must never be moved"
        );
        let item = &plan_items(&conn, plan_id).unwrap()[0];
        assert_eq!(item.status, "skipped");
        assert!(
            item.note
                .as_deref()
                .unwrap_or("")
                .contains("a different file is at this path"),
            "the note must say why: {:?}",
            item.note
        );
        cleanup(&root);
    }

    #[test]
    fn skips_an_item_whose_file_was_replaced_since_review() {
        let root = test_root("skips-replaced");
        let from = root.join("swapped.exe");
        let mut conn = migrated_conn();
        seed_file(&conn, 1, &from);

        // Rewrite with the same byte count, then age the indexed stamp so the
        // recorded identity and the file on disk disagree without the test
        // depending on filesystem timestamp resolution.
        std::fs::write(&from, [9u8; 10]).expect("rewrite fixture");
        conn.execute("UPDATE files SET modified_at = modified_at - 120 WHERE id = 1", [])
            .unwrap();

        let plan_id = create_plan(
            &conn,
            &[PlanItem {
                file_id: 1,
                from_path: from.to_string_lossy().to_string(),
                to_path: root.join("dest").join("swapped.exe").to_string_lossy().to_string(),
                size: 10,
                discovery_id: None,
            }],
        )
        .unwrap();

        let mover = FakeMover { fail: vec![], calls: RefCell::new(vec![]) };
        let result = execute_plan_with(&mut conn, plan_id, &mover).unwrap();

        assert_eq!(result.moved, 0);
        assert!(mover.calls.borrow().is_empty(), "the replacement must never be moved");
        let item = &plan_items(&conn, plan_id).unwrap()[0];
        assert_eq!(item.status, "skipped");
        assert!(
            item.note.as_deref().unwrap_or("").contains("changed since it was reviewed"),
            "the note must say why: {:?}",
            item.note
        );
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
