//! Cleanup-log listing, restore path, and retention expiry.
//!
//! Constitutional Defense #1: the restore log persists with one-click restore for
//! a configurable window, surviving recycle-bin emptying. Expired entries can no
//! longer be restored.

use crate::ontology::OntologyError;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CleanupLogEntry {
    pub id: i64,
    pub cleanup_plan_id: i64,
    pub file_id: i64,
    pub original_path: String,
    pub size: i64,
    pub cleaned_at: i64,
    pub reason: String,
    pub restore_status: String,
    pub expires_at: Option<i64>,
}

/// Abstraction over "restore this path from the OS recycle bin to its original
/// location". Production uses the `trash` crate's `os_limited` module where the
/// platform supports it; tests inject a fake.
pub trait Restorer {
    fn restore(&self, original_path: &Path) -> Result<(), String>;
}

/// Production restorer. On Windows and Linux (freedesktop) it finds the most
/// recently trashed item whose original location matches and restores it. On
/// platforms without `os_limited` support (e.g. macOS) it returns an error.
pub struct SystemRestorer;

impl Restorer for SystemRestorer {
    #[cfg(any(target_os = "windows", all(unix, not(target_os = "macos"))))]
    fn restore(&self, original_path: &Path) -> Result<(), String> {
        use trash::os_limited;
        let items = os_limited::list().map_err(|e| e.to_string())?;
        // Match by reconstructed original path (original_parent + name).
        let mut matches: Vec<_> = items
            .into_iter()
            .filter(|it| it.original_parent.join(&it.name) == original_path)
            .collect();
        if matches.is_empty() {
            return Err(format!(
                "no recycle-bin item matches original path {}",
                original_path.display()
            ));
        }
        // Restore the most recent match.
        matches.sort_by_key(|it| it.time_deleted);
        let newest = matches.pop().unwrap();
        os_limited::restore_all([newest]).map_err(|e| e.to_string())
    }

    #[cfg(not(any(target_os = "windows", all(unix, not(target_os = "macos")))))]
    fn restore(&self, _original_path: &Path) -> Result<(), String> {
        Err("restore-from-recycle-bin is not supported on this platform".to_string())
    }
}

pub fn recently_cleaned(
    conn: &Connection,
    limit: u32,
    offset: u32,
) -> Result<Vec<CleanupLogEntry>, OntologyError> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, cleanup_plan_id, file_id, original_path, size, cleaned_at, reason,
                restore_status, expires_at
         FROM ontology_cleanup_log
         ORDER BY cleaned_at DESC
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
) -> Result<Option<CleanupLogEntry>, OntologyError> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, cleanup_plan_id, file_id, original_path, size, cleaned_at, reason,
                restore_status, expires_at
         FROM ontology_cleanup_log WHERE id = ?1",
    )?;
    Ok(stmt.query_row(params![entry_id], row_to_entry).optional()?)
}

/// Restore a cleaned file with an injected restorer.
pub fn restore_with(
    conn: &mut Connection,
    entry_id: i64,
    restorer: &dyn Restorer,
) -> Result<(), OntologyError> {
    let entry = get_log_entry(conn, entry_id)?
        .ok_or_else(|| OntologyError::Populator(format!("cleanup-log entry {entry_id} not found")))?;
    if entry.restore_status != "in_recycle_bin" && entry.restore_status != "restore_pending" {
        return Err(OntologyError::Populator(format!(
            "cleanup-log entry {entry_id} is not restorable (status={})",
            entry.restore_status
        )));
    }

    // A row left at `restore_pending` by a crash means the bin restore may
    // already have run. If the file is back at its original path, the only thing
    // outstanding is the bookkeeping — finish it rather than asking the recycle
    // bin for an item that is no longer in it, which fails identically on every
    // retry while the Library keeps offering the button.
    if entry.restore_status == "restore_pending" && Path::new(&entry.original_path).exists() {
        return settle_restore(conn, &entry);
    }

    // Claim the restore before doing it, so the crash window above is a state
    // rather than a silence. Same shape as the relocation log's put-back.
    conn.execute(
        "UPDATE ontology_cleanup_log SET restore_status = 'restore_pending' WHERE id = ?1",
        params![entry_id],
    )?;

    if let Err(reason) = restorer.restore(Path::new(&entry.original_path)) {
        // Scoped, for the same reason the relocation log's rollback is.
        conn.execute(
            "UPDATE ontology_cleanup_log SET restore_status = 'in_recycle_bin'
             WHERE id = ?1 AND restore_status = 'restore_pending'",
            params![entry_id],
        )?;
        return Err(OntologyError::Populator(reason));
    }

    settle_restore(conn, &entry)
}

/// What the object now sitting at the original path has to say for itself,
/// compared with what was recorded when the file was removed.
///
/// `Ok(())` means it is the file that went away. `Err(reason)` means something
/// is there, or nothing is, but it is not that file.
fn identity_after_restore(conn: &Connection, entry: &CleanupLogEntry) -> Result<(), String> {
    let path = Path::new(&entry.original_path);
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) => {
            // The restore reported success and yet the path is empty. On
            // Windows the bin puts a file back beside an occupant under a
            // generated name rather than overwriting, which lands exactly here.
            return Err(format!(
                "the restore reported success but nothing is at {} -- {error}",
                entry.original_path
            ));
        }
    };

    // The filesystem's own id for the object, which settles the question
    // outright when both sides have one. Measured on this NTFS volume by
    // `tests/recycle_bin_identity.rs`: sending a file to the bin and restoring
    // it returns the same id, byte for byte. So a mismatch here means the
    // object is not the one that was removed, and it is treated as such.
    let recorded_object: Option<String> = conn
        .query_row(
            "SELECT object_id FROM files WHERE id = ?1",
            params![entry.file_id],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten();
    if let (Some(recorded), Ok(found)) = (
        recorded_object.as_deref(),
        crate::native::file_id::object_id(path),
    ) {
        return if found.key() == recorded {
            Ok(())
        } else {
            // A restore that had to copy the bytes -- across volumes, or on a
            // trash implementation that does not rename -- would also land
            // here. Saying so plainly is better than either silently trusting
            // it or claiming certainty about which of the two happened.
            Err(format!(
                "what is at {} is not the object that was removed -- if the restore made a new copy                  rather than putting the original back, rescan and it will be picked up",
                entry.original_path
            ))
        };
    }

    // No id on either side. Falling back to size: weaker, but it is the one
    // fact the log itself records, so it works for an index row written before
    // ids were collected.
    let found = metadata.len() as i64;
    if found == entry.size {
        return Ok(());
    }
    Err(format!(
        "what is at {} is not the file that was removed -- it was {} bytes, and this is {found}",
        entry.original_path, entry.size
    ))
}

/// Close the log entry, and re-link the index row only if what came back is
/// really the file that went away.
fn settle_restore(conn: &Connection, entry: &CleanupLogEntry) -> Result<(), OntologyError> {
    let verdict = identity_after_restore(conn, entry);

    // The entry leaves `restore_pending` either way. It is no longer in the
    // recycle bin, and leaving it pending would offer a button that fails
    // identically forever.
    conn.execute(
        "UPDATE ontology_cleanup_log SET restore_status = 'restored' WHERE id = ?1",
        params![entry.id],
    )?;

    match verdict {
        Ok(()) => {
            conn.execute(
                "UPDATE files SET deleted_at = NULL WHERE id = ?1",
                params![entry.file_id],
            )?;
            Ok(())
        }
        // The index row stays deleted on purpose. Marking it live would point a
        // row carrying the old size and the old hashes at an object that is not
        // that file, and every later answer built on it would be wrong. The
        // next scan will index whatever is actually there.
        Err(reason) => Err(OntologyError::Populator(reason)),
    }
}

/// Public entry point: open the index, use the OS recycle bin.
pub fn restore_from_cleanup_log(index_path: &Path, entry_id: i64) -> Result<(), OntologyError> {
    let mut conn = crate::index::open_index_connection(index_path)?;
    restore_with(&mut conn, entry_id, &SystemRestorer)
}

/// Mark all still-in-recycle-bin entries whose retention window has passed as
/// `expired`. Returns the number of entries expired.
pub fn expire_old_entries(conn: &Connection, now: i64) -> Result<u64, OntologyError> {
    let affected = conn.execute(
        "UPDATE ontology_cleanup_log
         SET restore_status = 'expired'
         WHERE restore_status = 'in_recycle_bin'
           AND expires_at IS NOT NULL
           AND expires_at <= ?1",
        params![now],
    )?;
    Ok(affected as u64)
}

fn row_to_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<CleanupLogEntry> {
    Ok(CleanupLogEntry {
        id: row.get(0)?,
        cleanup_plan_id: row.get(1)?,
        file_id: row.get(2)?,
        original_path: row.get(3)?,
        size: row.get(4)?,
        cleaned_at: row.get(5)?,
        reason: row.get(6)?,
        restore_status: row.get(7)?,
        expires_at: row.get(8)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::schema::ALL_MIGRATIONS;
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

    /// Seed a cleaned file: a `files` row (deleted), a cleanup plan, and a log entry.
    fn seed_cleaned_file(conn: &Connection, expires_at: Option<i64>) -> i64 {
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, size, indexed_at, deleted_at)
             VALUES (1, 1, '/root/dist/a.js', 'a.js', 100, 0, 555)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ontology_cleanup_plans (id, created_at, executed_at, scope, status)
             VALUES (1, 0, 555, '{}', 'executed')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ontology_cleanup_log
                (cleanup_plan_id, file_id, original_path, size, cleaned_at, reason,
                 gating_facts, restore_status, expires_at)
             VALUES (1, 1, '/root/dist/a.js', 100, 555, 'scratch', '{}', 'in_recycle_bin', ?1)",
            params![expires_at],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    struct OkRestorer {
        seen: Mutex<Vec<String>>,
    }
    impl OkRestorer {
        fn new() -> Self {
            Self { seen: Mutex::new(Vec::new()) }
        }
    }
    impl Restorer for OkRestorer {
        fn restore(&self, original_path: &Path) -> Result<(), String> {
            self.seen.lock().unwrap().push(original_path.display().to_string());
            // A restore that reports success has put a file back. Saying so
            // without doing it is the exact failure the verification exists to
            // catch, so the honest fake writes the file.
            std::fs::write(original_path, vec![0_u8; SEEDED_SIZE as usize]).unwrap();
            Ok(())
        }
    }

    /// The size the seeded log entry records, and therefore what an honest
    /// restore has to put back.
    const SEEDED_SIZE: i64 = 100;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "be-cleanup-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Point a seeded entry at a real path on disk, which is what every test
    /// that actually restores needs.
    fn point_at(conn: &Connection, entry_id: i64, path: &Path) {
        conn.execute(
            "UPDATE ontology_cleanup_log SET original_path = ?2 WHERE id = ?1",
            params![entry_id, path.to_string_lossy()],
        )
        .unwrap();
    }

    /// The peer of the relocation log's stranding: bin restore succeeds, the
    /// status write fails, and every retry then asks the recycle bin for an item
    /// that is no longer in it — failing identically forever while the Library
    /// keeps offering the button. Safe, but never convergent.
    #[test]
    fn a_bin_restore_that_already_happened_converges_on_retry() {
        struct AlwaysFails;
        impl Restorer for AlwaysFails {
            fn restore(&self, _p: &Path) -> Result<(), String> {
                Err("no recycle-bin item matches original path".to_string())
            }
        }

        let dir = temp_dir("converge");
        let original = dir.join("back-already.txt");
        std::fs::write(&original, vec![0_u8; SEEDED_SIZE as usize]).unwrap();

        let mut conn = migrated_conn();
        let entry_id = seed_cleaned_file(&conn, Some(i64::MAX));
        // The state a crash between the bin restore and the status write leaves:
        // claimed, and the file already back at its original path.
        conn.execute(
            "UPDATE ontology_cleanup_log
             SET restore_status = 'restore_pending', original_path = ?2
             WHERE id = ?1",
            params![entry_id, original.to_string_lossy()],
        )
        .unwrap();

        // Even a restorer that always fails must not block this: the work is
        // already done, so nothing is asked of the recycle bin at all.
        restore_with(&mut conn, entry_id, &AlwaysFails)
            .expect("a completed restore must converge, not refuse forever");

        let status: String = conn
            .query_row(
                "SELECT restore_status FROM ontology_cleanup_log WHERE id=?1",
                params![entry_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(status, "restored");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A failed restore must hand the row back, or a locked file strands its own
    /// entry at `restore_pending` and the Library stops offering the undo.
    #[test]
    fn a_failed_bin_restore_leaves_the_entry_restorable() {
        struct AlwaysFails;
        impl Restorer for AlwaysFails {
            fn restore(&self, _p: &Path) -> Result<(), String> {
                Err("bin item is gone".to_string())
            }
        }

        let mut conn = migrated_conn();
        let entry_id = seed_cleaned_file(&conn, Some(i64::MAX));

        restore_with(&mut conn, entry_id, &AlwaysFails).expect_err("the restorer refused");

        let status: String = conn
            .query_row(
                "SELECT restore_status FROM ontology_cleanup_log WHERE id=?1",
                params![entry_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(status, "in_recycle_bin", "a failed restore must not strand the row");
    }

    #[test]
    fn restore_flips_status_and_clears_deleted_at() {
        let mut conn = migrated_conn();
        let entry_id = seed_cleaned_file(&conn, Some(i64::MAX));
        let dir = temp_dir("happy");
        point_at(&conn, entry_id, &dir.join("a.js"));

        let restorer = OkRestorer::new();
        restore_with(&mut conn, entry_id, &restorer).unwrap();

        assert_eq!(restorer.seen.lock().unwrap().len(), 1);
        let status: String = conn
            .query_row("SELECT restore_status FROM ontology_cleanup_log WHERE id=?1", params![entry_id], |r| r.get(0))
            .unwrap();
        assert_eq!(status, "restored");

        let deleted_at: Option<i64> = conn
            .query_row("SELECT deleted_at FROM files WHERE id=1", [], |r| r.get(0))
            .unwrap();
        assert!(deleted_at.is_none(), "deleted_at must be cleared on restore");
    }

    #[test]
    fn restore_refuses_non_recycle_bin_entry() {
        let mut conn = migrated_conn();
        let entry_id = seed_cleaned_file(&conn, Some(i64::MAX));
        conn.execute(
            "UPDATE ontology_cleanup_log SET restore_status='expired' WHERE id=?1",
            params![entry_id],
        )
        .unwrap();
        let restorer = OkRestorer::new();
        assert!(restore_with(&mut conn, entry_id, &restorer).is_err());
    }

    #[test]
    fn recently_cleaned_lists_entries_newest_first() {
        let conn = migrated_conn();
        seed_cleaned_file(&conn, Some(i64::MAX));
        let rows = recently_cleaned(&conn, 10, 0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].original_path, "/root/dist/a.js");
        assert_eq!(rows[0].restore_status, "in_recycle_bin");
    }

    #[test]
    fn expire_old_entries_marks_only_past_due() {
        let conn = migrated_conn();
        seed_cleaned_file(&conn, Some(100)); // expires_at=100
        // Now=50: nothing expired yet.
        assert_eq!(expire_old_entries(&conn, 50).unwrap(), 0);
        // Now=200: past due → expired.
        assert_eq!(expire_old_entries(&conn, 200).unwrap(), 1);
        let status: String = conn
            .query_row("SELECT restore_status FROM ontology_cleanup_log", [], |r| r.get(0))
            .unwrap();
        assert_eq!(status, "expired");
    }

    /// The recycle bin reported success and put nothing back. On Windows this
    /// is what happens when the original path is occupied: the item lands
    /// beside it under a generated name, and the bin still calls that a
    /// restore.
    #[test]
    fn a_restore_that_put_nothing_back_is_not_reported_as_success() {
        struct LiesAboutIt;
        impl Restorer for LiesAboutIt {
            fn restore(&self, _p: &Path) -> Result<(), String> {
                Ok(())
            }
        }

        let mut conn = migrated_conn();
        let entry_id = seed_cleaned_file(&conn, Some(i64::MAX));
        let dir = temp_dir("empty-handed");
        point_at(&conn, entry_id, &dir.join("a.js"));

        let error = restore_with(&mut conn, entry_id, &LiesAboutIt)
            .expect_err("nothing came back, so this is not a restore");
        assert!(
            error.to_string().contains("nothing is at"),
            "the message has to say what is wrong: {error}"
        );

        let deleted_at: Option<i64> = conn
            .query_row("SELECT deleted_at FROM files WHERE id=1", [], |r| r.get(0))
            .unwrap();
        assert!(
            deleted_at.is_some(),
            "the index row must stay deleted -- nothing came back to point it at"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Something is at the path, but it is not the file that was removed.
    /// Re-linking the index row here would point a row carrying the old size
    /// and the old hashes at a stranger.
    #[test]
    fn a_different_file_at_the_original_path_is_not_the_restored_file() {
        struct PutsBackSomethingElse;
        impl Restorer for PutsBackSomethingElse {
            fn restore(&self, original_path: &Path) -> Result<(), String> {
                std::fs::write(original_path, b"a completely different file").unwrap();
                Ok(())
            }
        }

        let mut conn = migrated_conn();
        let entry_id = seed_cleaned_file(&conn, Some(i64::MAX));
        let dir = temp_dir("stranger");
        point_at(&conn, entry_id, &dir.join("a.js"));

        let error = restore_with(&mut conn, entry_id, &PutsBackSomethingElse)
            .expect_err("a different file is not the file that was removed");
        assert!(
            error.to_string().contains("is not the file that was removed"),
            "the message has to name the problem: {error}"
        );

        let (status, deleted_at): (String, Option<i64>) = (
            conn.query_row(
                "SELECT restore_status FROM ontology_cleanup_log WHERE id=?1",
                params![entry_id],
                |r| r.get(0),
            )
            .unwrap(),
            conn.query_row("SELECT deleted_at FROM files WHERE id=1", [], |r| r.get(0))
                .unwrap(),
        );
        assert_eq!(
            status, "restored",
            "the entry must leave restore_pending, or the undo button fails forever"
        );
        assert!(
            deleted_at.is_some(),
            "the index row must stay deleted -- it does not describe what is there"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The strict branch: an id was recorded, and what is at the path is a
    /// different object. Same size, so the weaker check would have waved it
    /// through.
    #[test]
    fn a_recorded_object_id_that_does_not_match_is_refused_even_at_the_right_size() {
        struct PutsBackATwin;
        impl Restorer for PutsBackATwin {
            fn restore(&self, original_path: &Path) -> Result<(), String> {
                std::fs::write(original_path, vec![1_u8; SEEDED_SIZE as usize]).unwrap();
                Ok(())
            }
        }

        let mut conn = migrated_conn();
        let entry_id = seed_cleaned_file(&conn, Some(i64::MAX));
        let dir = temp_dir("twin");
        point_at(&conn, entry_id, &dir.join("a.js"));
        conn.execute(
            "UPDATE files SET object_id = 'deadbeefdeadbeef:00000000000000000000000000000001'
             WHERE id = 1",
            [],
        )
        .unwrap();

        let error = restore_with(&mut conn, entry_id, &PutsBackATwin)
            .expect_err("the right size is not the right file");
        assert!(
            error.to_string().contains("not the object that was removed"),
            "the message has to name the problem: {error}"
        );
        let deleted_at: Option<i64> = conn
            .query_row("SELECT deleted_at FROM files WHERE id=1", [], |r| r.get(0))
            .unwrap();
        assert!(deleted_at.is_some(), "the index row must stay deleted");
        std::fs::remove_dir_all(&dir).ok();
    }
}
