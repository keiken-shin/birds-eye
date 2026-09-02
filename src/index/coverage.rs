//! How much of the disk the index actually knows about.
//!
//! "1,000,000 files scanned" is a count of directory entries, not of files
//! Bird's Eye understands. Reading a file's contents is a separate, later pass,
//! it only runs on files that could be duplicates at all, and it fails in
//! several distinguishable ways. A recommendation drawn from that index is only
//! as good as the part of it that was actually read, and until now nothing said
//! which part that was.
//!
//! This is that statement, assembled from what is already recorded rather than
//! from new instrumentation:
//!
//! - `files.hash_state` for what was read, and how completely
//! - per-scan skip counters for what could not be read, and why
//! - `scan_sessions.inaccessible_entries` for folders that were never opened,
//!   which is the blind spot no per-file number can see
//!
//! The skip counters come from `scan_sessions` and not from counting
//! `scan_issues` rows, because that table stops at `SCAN_ISSUES_CAP`. Counting
//! rows would understate the damage exactly when there is most of it.

use crate::index::writer::IndexError;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use crate::index::analysis::AnalysisLevel;

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ScanCoverage {
    /// Files in the index, excluding ones already deleted.
    pub files_indexed: i64,
    /// Files whose complete contents were read.
    pub read_fully: i64,
    /// Files where only selected chunks were read. Enough to group candidates,
    /// not enough to delete one on.
    pub read_sampled: i64,
    /// Files that were never candidates for content reading. Not a failure:
    /// nothing else on the disk is their size, so there is nothing to compare.
    pub not_needed: i64,

    /// Online-only cloud placeholders: the bytes are not on this machine.
    pub skipped_offline: i64,
    /// Something else held the file open.
    pub skipped_locked: i64,
    /// The filesystem refused access.
    pub skipped_denied: i64,
    /// The file moved under the read, so no digest could describe it.
    pub skipped_changed: i64,
    /// Everything else, kept separate so it never hides inside a named class.
    pub skipped_failed: i64,

    /// Folders the walker could not open at all. Whatever is under them is not
    /// in any number above.
    pub folders_unreadable: i64,

    /// What kind of volume this was: `fixed`, `removable`, `remote`, `cdrom`,
    /// `ramdisk`, or `unknown`. It changes what the numbers mean. A share can
    /// go quiet without anything being deleted; a stick can be pulled between
    /// the scan and the cleanup; only a fixed disk makes "it was there a minute
    /// ago" a safe assumption.
    pub volume_kind: String,
}

impl ScanCoverage {
    pub fn skipped_total(&self) -> i64 {
        self.skipped_offline
            + self.skipped_locked
            + self.skipped_denied
            + self.skipped_changed
            + self.skipped_failed
    }

    /// Share of the files that needed content read that actually were, as a
    /// fraction from 0 to 1. `None` when nothing needed reading -- there is no
    /// honest percentage for an empty denominator, and 100% would be a lie of a
    /// particularly confident kind.
    ///
    /// Sampled files count as read: they were opened and compared, just not in
    /// full. What they cannot support is a deletion, and that is enforced at the
    /// point of deletion rather than by discounting them here.
    pub fn read_fraction(&self) -> Option<f64> {
        let attempted = self.read_fully + self.read_sampled + self.skipped_total();
        if attempted == 0 {
            return None;
        }
        Some((self.read_fully + self.read_sampled) as f64 / attempted as f64)
    }
}

pub fn scan_coverage(conn: &Connection, scan_id: i64) -> Result<ScanCoverage, IndexError> {
    let (files_indexed, read_fully, read_sampled, not_needed) = conn.query_row(
        "SELECT COUNT(*),
                COALESCE(SUM(hash_state = ?1), 0),
                COALESCE(SUM(hash_state = ?2), 0),
                COALESCE(SUM(hash_state = ?3), 0)
         FROM files WHERE deleted_at IS NULL",
        params![
            AnalysisLevel::Complete.as_i64(),
            AnalysisLevel::Sampled.as_i64(),
            AnalysisLevel::None.as_i64()
        ],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;

    // A scan row can be missing (a fresh index, a deleted session). Zeroes are
    // the truthful answer then, not an error.
    #[allow(clippy::type_complexity)]
    let session: Option<(i64, i64, i64, i64, i64, i64, Option<String>)> = conn
        .query_row(
            "SELECT skipped_offline, skipped_locked, skipped_denied, skipped_changed,
                    skipped_failed, inaccessible_entries, volume_kind
             FROM scan_sessions WHERE id = ?1",
            params![scan_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .optional()?;
    let (offline, locked, denied, changed, failed, folders, volume_kind) =
        session.unwrap_or((0, 0, 0, 0, 0, 0, None));

    Ok(ScanCoverage {
        files_indexed,
        read_fully,
        read_sampled,
        not_needed,
        skipped_offline: offline,
        skipped_locked: locked,
        skipped_denied: denied,
        skipped_changed: changed,
        skipped_failed: failed,
        folders_unreadable: folders,
        // A scan recorded before the kind was known says so, rather than
        // claiming to be a fixed disk.
        volume_kind: volume_kind.unwrap_or_else(|| "unknown".to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::schema::ALL_MIGRATIONS;

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
        conn.execute(
            "INSERT INTO scan_sessions (id, root_path, started_at, status)
             VALUES (1, '/root', 0, 'finished')",
            [],
        )
        .unwrap();
        conn
    }

    fn add_file(conn: &Connection, id: i64, hash_state: i64, deleted: bool) {
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, size, hash_state, deleted_at, indexed_at)
             VALUES (?1, 1, ?2, 'f', 10, ?3, ?4, 0)",
            params![id, format!("/root/{id}"), hash_state, deleted.then_some(1_i64)],
        )
        .unwrap();
    }

    #[test]
    fn counts_what_was_read_and_what_was_not() {
        let conn = migrated_conn();
        add_file(&conn, 1, 4, false);
        add_file(&conn, 2, 4, false);
        add_file(&conn, 3, 2, false);
        add_file(&conn, 4, 0, false);
        add_file(&conn, 5, 4, true); // deleted: outside every count

        let c = scan_coverage(&conn, 1).unwrap();
        assert_eq!(c.files_indexed, 4);
        assert_eq!(c.read_fully, 2);
        assert_eq!(c.read_sampled, 1);
        assert_eq!(c.not_needed, 1);
    }

    #[test]
    fn reports_each_reason_a_file_went_unread() {
        let conn = migrated_conn();
        add_file(&conn, 1, 4, false);
        conn.execute(
            "UPDATE scan_sessions
             SET skipped_offline = 3, skipped_locked = 2, skipped_denied = 1,
                 skipped_changed = 5, skipped_failed = 4, inaccessible_entries = 7
             WHERE id = 1",
            [],
        )
        .unwrap();

        let c = scan_coverage(&conn, 1).unwrap();
        assert_eq!(c.skipped_offline, 3);
        assert_eq!(c.skipped_changed, 5);
        assert_eq!(c.skipped_total(), 15);
        assert_eq!(c.folders_unreadable, 7, "a folder we never opened is its own blind spot");
    }

    #[test]
    fn read_fraction_counts_only_files_that_needed_reading() {
        let conn = migrated_conn();
        for id in 1..=9 {
            add_file(&conn, id, 4, false);
        }
        // 90 files that were never candidates must not inflate the share.
        for id in 10..=99 {
            add_file(&conn, id, 0, false);
        }
        conn.execute("UPDATE scan_sessions SET skipped_locked = 1 WHERE id = 1", [])
            .unwrap();

        let c = scan_coverage(&conn, 1).unwrap();
        assert_eq!(c.read_fraction(), Some(0.9));
    }

    /// An empty denominator has no honest percentage, and 100% would be the
    /// most confident possible way of saying nothing.
    #[test]
    fn read_fraction_is_unknown_when_nothing_needed_reading() {
        let conn = migrated_conn();
        add_file(&conn, 1, 0, false);
        assert_eq!(scan_coverage(&conn, 1).unwrap().read_fraction(), None);
    }

    #[test]
    fn a_missing_scan_row_reports_zeroes_rather_than_failing() {
        let conn = migrated_conn();
        add_file(&conn, 1, 4, false);
        let c = scan_coverage(&conn, 999).unwrap();
        assert_eq!(c.read_fully, 1);
        assert_eq!(c.skipped_total(), 0);
    }
}
