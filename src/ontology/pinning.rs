//! Pin-to-keep CRUD. Files in this set are permanently excluded from
//! automated cleanup regardless of role/replaceability.

use crate::ontology::OntologyError;
use rusqlite::{params, Connection};

pub fn pin_file(conn: &Connection, file_id: i64, note: Option<&str>) -> Result<(), OntologyError> {
    conn.execute(
        "INSERT OR REPLACE INTO ontology_pinned_files (file_id, pinned_at, note)
         VALUES (?1, ?2, ?3)",
        params![file_id, unix_now(), note],
    )?;
    Ok(())
}

pub fn unpin_file(conn: &Connection, file_id: i64) -> Result<(), OntologyError> {
    conn.execute(
        "DELETE FROM ontology_pinned_files WHERE file_id = ?1",
        params![file_id],
    )?;
    Ok(())
}

pub fn is_pinned(conn: &Connection, file_id: i64) -> Result<bool, OntologyError> {
    let mut stmt =
        conn.prepare_cached("SELECT 1 FROM ontology_pinned_files WHERE file_id = ?1 LIMIT 1")?;
    Ok(stmt.exists(params![file_id])?)
}

fn unix_now() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::schema::ALL_MIGRATIONS;
    use rusqlite::Connection;

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
            "INSERT INTO files (id, folder_id, path, name, size, indexed_at)
             VALUES (1, 1, '/root/x.txt', 'x.txt', 100, 0)",
            [],
        )
        .unwrap();
        conn
    }

    #[test]
    fn pin_unpin_round_trip() {
        let conn = migrated_conn();
        assert!(!is_pinned(&conn, 1).unwrap());

        pin_file(&conn, 1, Some("never delete")).unwrap();
        assert!(is_pinned(&conn, 1).unwrap());

        unpin_file(&conn, 1).unwrap();
        assert!(!is_pinned(&conn, 1).unwrap());
    }

    #[test]
    fn pin_is_idempotent() {
        let conn = migrated_conn();
        pin_file(&conn, 1, Some("a")).unwrap();
        pin_file(&conn, 1, Some("b")).unwrap();
        assert!(is_pinned(&conn, 1).unwrap());
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM ontology_pinned_files WHERE file_id = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }
}
