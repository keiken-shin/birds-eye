//! Negative assertion CRUD (user-rejected facts). Blocks re-suggestion.

use crate::ontology::OntologyError;
use rusqlite::{params, Connection};

pub fn reject_pair(
    conn: &Connection,
    subject_id: i64,
    predicate: &str,
    object_id: i64,
    reason: Option<&str>,
) -> Result<(), OntologyError> {
    conn.execute(
        "INSERT INTO ontology_negative_assertions
            (subject_id, predicate, object_id, rejected_at, reason)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![subject_id, predicate, object_id, unix_now(), reason],
    )?;
    Ok(())
}

pub fn reject_property(
    conn: &Connection,
    subject_id: i64,
    key: &str,
    value: &str,
    reason: Option<&str>,
) -> Result<(), OntologyError> {
    conn.execute(
        "INSERT INTO ontology_negative_assertions
            (subject_id, predicate, key, value, rejected_at, reason)
         VALUES (?1, 'property', ?2, ?3, ?4, ?5)",
        params![subject_id, key, value, unix_now(), reason],
    )?;
    Ok(())
}

pub fn is_rejected_pair(
    conn: &Connection,
    subject_id: i64,
    predicate: &str,
    object_id: i64,
) -> Result<bool, OntologyError> {
    let mut stmt = conn.prepare_cached(
        "SELECT 1 FROM ontology_negative_assertions
         WHERE subject_id = ?1 AND predicate = ?2 AND object_id = ?3
         LIMIT 1",
    )?;
    Ok(stmt.exists(params![subject_id, predicate, object_id])?)
}

pub fn is_rejected_property_value(
    conn: &Connection,
    subject_id: i64,
    key: &str,
    value: &str,
) -> Result<bool, OntologyError> {
    let mut stmt = conn.prepare_cached(
        "SELECT 1 FROM ontology_negative_assertions
         WHERE subject_id = ?1 AND predicate = 'property' AND key = ?2 AND value = ?3
         LIMIT 1",
    )?;
    Ok(stmt.exists(params![subject_id, key, value])?)
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
    use crate::ontology::entities::upsert_entity;
    use crate::ontology::vocabulary::{predicates, EntityKind};
    use rusqlite::Connection;

    fn migrated_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        for (_, sql) in ALL_MIGRATIONS {
            conn.execute_batch(sql).unwrap();
        }
        conn
    }

    fn seed(conn: &Connection) -> (i64, i64) {
        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
             VALUES (1, NULL, '/root', 'root', 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, size, indexed_at)
             VALUES (1, 1, '/root/a.psd', 'a.psd', 100, 0),
                    (2, 1, '/root/a.png', 'a.png', 10, 0)",
            [],
        )
        .unwrap();
        (
            upsert_entity(conn, EntityKind::File, "/root/a.psd", Some(1), None, None)
                .unwrap()
                .id,
            upsert_entity(conn, EntityKind::File, "/root/a.png", Some(2), None, None)
                .unwrap()
                .id,
        )
    }

    #[test]
    fn pair_rejection_round_trip() {
        let conn = migrated_conn();
        let (psd, png) = seed(&conn);
        assert!(!is_rejected_pair(&conn, png, predicates::DERIVED_FROM, psd).unwrap());

        reject_pair(
            &conn,
            png,
            predicates::DERIVED_FROM,
            psd,
            Some("not actually derived"),
        )
        .unwrap();
        assert!(is_rejected_pair(&conn, png, predicates::DERIVED_FROM, psd).unwrap());

        assert!(!is_rejected_pair(&conn, psd, predicates::DERIVED_FROM, png).unwrap());
    }

    #[test]
    fn property_rejection_round_trip() {
        let conn = migrated_conn();
        let (psd, _) = seed(&conn);
        assert!(!is_rejected_property_value(&conn, psd, "role", "scratch").unwrap());

        reject_property(&conn, psd, "role", "scratch", None).unwrap();
        assert!(is_rejected_property_value(&conn, psd, "role", "scratch").unwrap());

        assert!(!is_rejected_property_value(&conn, psd, "role", "system").unwrap());
    }
}
