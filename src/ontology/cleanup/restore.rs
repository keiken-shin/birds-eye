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
    if entry.restore_status != "in_recycle_bin" {
        return Err(OntologyError::Populator(format!(
            "cleanup-log entry {entry_id} is not restorable (status={})",
            entry.restore_status
        )));
    }

    restorer
        .restore(Path::new(&entry.original_path))
        .map_err(OntologyError::Populator)?;

    conn.execute(
        "UPDATE ontology_cleanup_log SET restore_status = 'restored' WHERE id = ?1",
        params![entry_id],
    )?;
    // Re-link to the scan index if the file row still exists.
    conn.execute(
        "UPDATE files SET deleted_at = NULL WHERE id = ?1",
        params![entry.file_id],
    )?;
    Ok(())
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
            Ok(())
        }
    }

    #[test]
    fn restore_flips_status_and_clears_deleted_at() {
        let mut conn = migrated_conn();
        let entry_id = seed_cleaned_file(&conn, Some(i64::MAX));

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
}
