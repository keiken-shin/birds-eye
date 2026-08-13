//! The move log: every file Bird's Eye relocated, and the path back.
//!
//! Deletions have had a durable undo since MIGRATION_005 — `ontology_cleanup_log`
//! plus `cleanup::restore::restore_with`, listed as "Recently cleaned" and
//! restorable for 30 days. Moving a file is the other way Bird's Eye touches the
//! disk, and until MIGRATION_013 its undo lived only in React state: close the
//! app and the move became permanent, with no record it happened.
//!
//! This is the same pattern for that half. Deliberately the same shape as the
//! cleanup log so both undos behave the same way for the person using them:
//! append-only rows, a status that only moves forward, a restore that refuses
//! out loud rather than guessing.

use crate::ontology::catalog::executor::Mover;
use crate::ontology::OntologyError;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RelocationLogEntry {
    pub id: i64,
    pub file_id: Option<i64>,
    pub from_path: String,
    pub to_path: String,
    pub size: i64,
    pub moved_at: i64,
    pub modified_at: Option<i64>,
    pub restore_status: String,
}

/// Append one row for a file that has just been moved.
///
/// Called from `native::api::move_files`, the single point every relocation
/// routes through — a reviewed plan, a manual move from the Files view and the
/// session undo toast all end up there, so one write covers all of them.
///
/// Logged after the bytes land rather than before, unlike the cleanup log: the
/// identity we store (size and last-modified) can only be read once the file is
/// at the destination, and the failure mode is mild either way. A crash in the
/// gap leaves the file at a real, visible path that the next scan picks up —
/// not sitting invisibly in a recycle bin, which is why cleanup logs first.
pub fn log_move(
    conn: &Connection,
    from: &str,
    to: &str,
    file_id: Option<i64>,
) -> Result<(), OntologyError> {
    // A move that exactly reverses an open entry is a put-back, not a new move:
    // close that entry rather than opening a second one. `SystemMover` already
    // avoids double-logging by passing no index path, but the session undo toast
    // reverses through `move_files` like any other move, and without this the log
    // would claim both directions happened and offer to undo each of them.
    let reversed: Option<i64> = conn
        .query_row(
            "SELECT id FROM ontology_relocation_log
             WHERE restore_status = 'moved' AND from_path = ?1 AND to_path = ?2
             ORDER BY moved_at DESC, id DESC
             LIMIT 1",
            params![to, from],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(id) = reversed {
        conn.execute(
            "UPDATE ontology_relocation_log SET restore_status = 'restored' WHERE id = ?1",
            params![id],
        )?;
        return Ok(());
    }

    let (size, modified_at) = identity_of(Path::new(to));
    conn.execute(
        "INSERT INTO ontology_relocation_log
            (file_id, from_path, to_path, size, moved_at, modified_at, restore_status)
         VALUES (?1, ?2, ?3, ?4, strftime('%s','now'), ?5, 'moved')",
        params![file_id, from, to, size, modified_at],
    )?;
    Ok(())
}

pub fn recently_moved(
    conn: &Connection,
    limit: u32,
    offset: u32,
) -> Result<Vec<RelocationLogEntry>, OntologyError> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, file_id, from_path, to_path, size, moved_at, modified_at, restore_status
         FROM ontology_relocation_log
         ORDER BY moved_at DESC, id DESC
         LIMIT ?1 OFFSET ?2",
    )?;
    let rows = stmt
        .query_map(params![limit, offset], row_to_entry)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn get_log_entry(
    conn: &Connection,
    entry_id: i64,
) -> Result<Option<RelocationLogEntry>, OntologyError> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, file_id, from_path, to_path, size, moved_at, modified_at, restore_status
         FROM ontology_relocation_log WHERE id = ?1",
    )?;
    Ok(stmt.query_row(params![entry_id], row_to_entry).optional()?)
}

/// Put a moved file back where it came from, with an injected mover.
///
/// Every way this can go wrong ends in a refusal the UI can show as-is. It
/// never overwrites: if anything at all already sits at the original path the
/// move does not happen, and if the file at the destination is not the one that
/// was logged — gone, resized, edited — it stays where it is.
pub fn restore_move_with(
    conn: &Connection,
    entry_id: i64,
    mover: &dyn Mover,
) -> Result<(), OntologyError> {
    let entry = get_log_entry(conn, entry_id)?.ok_or_else(|| {
        OntologyError::Refused("Bird's Eye has no record of that move.".to_string())
    })?;
    if entry.restore_status != "moved" {
        return Err(OntologyError::Refused(
            "Bird's Eye already put this file back.".to_string(),
        ));
    }

    let Ok(found) = std::fs::metadata(&entry.to_path) else {
        return Err(OntologyError::Refused(
            "Bird's Eye couldn't put this file back — it is no longer where it was moved to."
                .to_string(),
        ));
    };
    // Last-modified is only compared when we managed to read one at move time,
    // so an entry with no recorded timestamp still checks its size rather than
    // becoming permanently unrestorable.
    //
    // `size` has no NULL to mean "unknown" (the column is NOT NULL), so a failed
    // metadata read at move time lands as 0 with no timestamp beside it. Comparing
    // that literally would refuse every later restore of a non-empty file and say
    // the file changed, which is a lie. Treat the pair as the unknown it is — a
    // genuinely empty file with a readable timestamp still gets both checks.
    let identity_unknown = entry.size == 0 && entry.modified_at.is_none();
    let changed = !identity_unknown
        && (found.len() as i64 != entry.size
            || entry
                .modified_at
                .is_some_and(|logged| modified_secs(&found) != Some(logged)));
    if changed {
        return Err(OntologyError::Refused(
            "Bird's Eye couldn't put this file back — it has changed since it was moved."
                .to_string(),
        ));
    }
    if Path::new(&entry.from_path).exists() {
        return Err(OntologyError::Refused(
            "Bird's Eye couldn't put this file back — something else is at its old location now."
                .to_string(),
        ));
    }

    mover.move_one(&entry.to_path, &entry.from_path).map_err(|reason| {
        OntologyError::Refused(format!("Bird's Eye couldn't put this file back: {reason}"))
    })?;

    conn.execute(
        "UPDATE ontology_relocation_log SET restore_status = 'restored' WHERE id = ?1",
        params![entry_id],
    )?;
    // Re-link to the scan index if the file row still exists, same as the
    // cleanup log's restore. The forward move soft-deleted this row; putting the
    // file back is the exact inverse of that step.
    if let Some(file_id) = entry.file_id {
        conn.execute(
            "UPDATE files SET deleted_at = NULL WHERE id = ?1",
            params![file_id],
        )?;
    }
    Ok(())
}

/// Size and last-modified of the file at `path`, as the identity a later
/// restore checks against. Both fall back to unknown rather than failing the
/// move that just succeeded.
fn identity_of(path: &Path) -> (i64, Option<i64>) {
    match std::fs::metadata(path) {
        Ok(meta) => (meta.len() as i64, modified_secs(&meta)),
        Err(_) => (0, None),
    }
}

fn modified_secs(meta: &std::fs::Metadata) -> Option<i64> {
    meta.modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs() as i64)
}

fn row_to_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<RelocationLogEntry> {
    Ok(RelocationLogEntry {
        id: row.get(0)?,
        file_id: row.get(1)?,
        from_path: row.get(2)?,
        to_path: row.get(3)?,
        size: row.get(4)?,
        moved_at: row.get(5)?,
        modified_at: row.get(6)?,
        restore_status: row.get(7)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::schema::ALL_MIGRATIONS;
    use std::path::PathBuf;

    fn test_root(name: &str) -> PathBuf {
        let root = std::env::current_dir()
            .expect("failed to get current dir")
            .join("target")
            .join("relocation-log-tests")
            .join(format!(
                "{}-{}",
                name,
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .expect("clock before epoch")
                    .as_nanos()
            ));
        if root.exists() {
            std::fs::remove_dir_all(&root).expect("failed to remove test folder");
        }
        std::fs::create_dir_all(&root).expect("create test root");
        root
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

    /// Writes a real file at `from`, indexes it, moves it to `to` and logs the
    /// move — the state the app is in right after a relocation.
    fn seed_moved_file(conn: &Connection, from: &Path, to: &Path) -> i64 {
        std::fs::write(from, b"the original bytes").expect("write fixture");
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, size, indexed_at, deleted_at)
             VALUES (1, 1, ?1, 'a.exe', 18, 0, 555)",
            params![from.to_string_lossy()],
        )
        .unwrap();
        std::fs::create_dir_all(to.parent().unwrap()).expect("create destination folder");
        std::fs::rename(from, to).expect("move fixture");
        log_move(conn, &from.to_string_lossy(), &to.to_string_lossy(), Some(1)).unwrap();
        conn.last_insert_rowid()
    }

    /// Actually moves the file, so the tests can assert where it ended up.
    struct FsMover;
    impl Mover for FsMover {
        fn move_one(&self, from: &str, to: &str) -> Result<(), String> {
            std::fs::rename(from, to).map_err(|e| e.to_string())
        }
    }

    /// The session undo toast reverses a relocation through `move_files` like any
    /// other move, so the log sees the exact inverse of a row it already holds.
    /// It must close that row, not open a second one — otherwise the list offers
    /// to undo both directions of a move that is already back where it started.
    #[test]
    fn reversing_a_move_closes_the_entry_instead_of_logging_another() {
        let root = test_root("reverse-closes");
        let from = root.join("a.exe");
        let to = root.join("dest").join("a.exe");
        let conn = migrated_conn();
        let entry_id = seed_moved_file(&conn, &from, &to);

        // Exactly what the undo toast does: the same pair, swapped.
        log_move(&conn, &to.to_string_lossy(), &from.to_string_lossy(), Some(1)).unwrap();

        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM ontology_relocation_log", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1, "the reverse must not add a second row");
        let status: String = conn
            .query_row(
                "SELECT restore_status FROM ontology_relocation_log WHERE id = ?1",
                params![entry_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(status, "restored", "the original entry is the one that closed");

        // An unrelated move still logs normally.
        log_move(&conn, "C:\\x\\other.bin", "D:\\y\\other.bin", None).unwrap();
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM ontology_relocation_log", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 2);
    }

    /// A failed metadata read at move time records size 0 with no timestamp. That
    /// is "unknown", not "empty", and comparing it literally would refuse every
    /// later restore while claiming the file had changed.
    #[test]
    fn an_entry_with_no_recorded_identity_can_still_be_put_back() {
        let root = test_root("unknown-identity");
        let from = root.join("a.exe");
        let to = root.join("dest").join("a.exe");
        std::fs::create_dir_all(to.parent().unwrap()).unwrap();
        std::fs::write(&to, b"bytes that were never measured").unwrap();

        let conn = migrated_conn();
        conn.execute(
            "INSERT INTO ontology_relocation_log
                (file_id, from_path, to_path, size, moved_at, modified_at, restore_status)
             VALUES (NULL, ?1, ?2, 0, 0, NULL, 'moved')",
            params![from.to_string_lossy(), to.to_string_lossy()],
        )
        .unwrap();
        let entry_id = conn.last_insert_rowid();

        restore_move_with(&conn, entry_id, &FsMover).expect("unknown identity must not block undo");
        assert!(from.exists(), "the file is back where it came from");
    }

    #[test]
    fn a_logged_move_restores_to_its_original_path() {
        let root = test_root("restores");
        let from = root.join("a.exe");
        let to = root.join("dest").join("a.exe");
        let conn = migrated_conn();
        let entry_id = seed_moved_file(&conn, &from, &to);

        restore_move_with(&conn, entry_id, &FsMover).unwrap();

        assert!(from.exists(), "the file must be back at its original path");
        assert!(!to.exists(), "and gone from where it was moved to");
        let status: String = conn
            .query_row(
                "SELECT restore_status FROM ontology_relocation_log WHERE id = ?1",
                params![entry_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(status, "restored");

        let deleted_at: Option<i64> = conn
            .query_row("SELECT deleted_at FROM files WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert!(deleted_at.is_none(), "deleted_at must be cleared on restore");
    }

    #[test]
    fn a_second_restore_of_the_same_entry_is_refused() {
        let root = test_root("restore-twice");
        let from = root.join("a.exe");
        let to = root.join("dest").join("a.exe");
        let conn = migrated_conn();
        let entry_id = seed_moved_file(&conn, &from, &to);

        restore_move_with(&conn, entry_id, &FsMover).unwrap();
        let err = restore_move_with(&conn, entry_id, &FsMover)
            .expect_err("an already-restored entry must not restore again");

        assert_eq!(err.to_string(), "Bird's Eye already put this file back.");
    }

    #[test]
    fn a_destination_file_that_is_gone_is_refused() {
        let root = test_root("destination-gone");
        let from = root.join("a.exe");
        let to = root.join("dest").join("a.exe");
        let conn = migrated_conn();
        let entry_id = seed_moved_file(&conn, &from, &to);
        std::fs::remove_file(&to).expect("delete the moved file out from under the log");

        let err = restore_move_with(&conn, entry_id, &FsMover).expect_err("must refuse");

        assert!(err.to_string().contains("no longer where it was moved to"));
        let status: String = conn
            .query_row(
                "SELECT restore_status FROM ontology_relocation_log WHERE id = ?1",
                params![entry_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(status, "moved", "a refused restore must not flip the status");
    }

    #[test]
    fn a_destination_file_that_changed_is_refused() {
        let root = test_root("destination-changed");
        let from = root.join("a.exe");
        let to = root.join("dest").join("a.exe");
        let conn = migrated_conn();
        let entry_id = seed_moved_file(&conn, &from, &to);
        std::fs::write(&to, b"someone edited this after the move").expect("rewrite");

        let err = restore_move_with(&conn, entry_id, &FsMover).expect_err("must refuse");

        assert!(err.to_string().contains("changed since it was moved"));
        assert!(to.exists(), "the edited file stays exactly where it is");
        assert!(!from.exists(), "and nothing is written to the original path");
    }

    #[test]
    fn an_occupied_original_path_is_refused_without_overwriting() {
        let root = test_root("original-occupied");
        let from = root.join("a.exe");
        let to = root.join("dest").join("a.exe");
        let conn = migrated_conn();
        let entry_id = seed_moved_file(&conn, &from, &to);
        std::fs::write(&from, b"an unrelated newer file").expect("occupy the original path");

        let err = restore_move_with(&conn, entry_id, &FsMover).expect_err("must refuse");

        assert!(err.to_string().contains("something else is at its old location"));
        assert_eq!(
            std::fs::read(&from).unwrap(),
            b"an unrelated newer file",
            "the file sitting at the original path must be untouched"
        );
        assert!(to.exists(), "and the moved file stays where it is");
    }

    #[test]
    fn recently_moved_lists_entries_newest_first() {
        let root = test_root("listing");
        let from = root.join("a.exe");
        let to = root.join("dest").join("a.exe");
        let conn = migrated_conn();
        seed_moved_file(&conn, &from, &to);
        std::fs::write(root.join("b.exe"), b"second").unwrap();
        log_move(
            &conn,
            &root.join("b.exe").to_string_lossy(),
            &root.join("b.exe").to_string_lossy(),
            None,
        )
        .unwrap();

        let rows = recently_moved(&conn, 10, 0).unwrap();

        assert_eq!(rows.len(), 2);
        assert!(rows[0].from_path.ends_with("b.exe"), "newest first");
        assert_eq!(rows[0].restore_status, "moved");
        assert_eq!(rows[1].size, 18, "the logged size is the destination's");
        assert_eq!(rows[1].file_id, Some(1));
        assert_eq!(recently_moved(&conn, 1, 1).unwrap().len(), 1, "paging works");
    }
}
