//! Sensitivity-containment helpers (Constitutional Defense #3).
//!
//! Cross-cutting UI surfaces must exclude entities with `private` or
//! `restricted` sensitivity at confidence >= 0.5.

use crate::ontology::vocabulary::{keys, Sensitivity};
use crate::ontology::OntologyError;
use rusqlite::{params, Connection};

pub fn is_globally_visible_file(conn: &Connection, file_id: i64) -> Result<bool, OntologyError> {
    is_globally_visible(conn, "File", "linked_file_id", file_id)
}

pub fn is_globally_visible_folder(conn: &Connection, folder_id: i64) -> Result<bool, OntologyError> {
    is_globally_visible(conn, "Folder", "linked_folder_id", folder_id)
}

fn is_globally_visible(
    conn: &Connection,
    kind: &str,
    link_column: &str,
    linked_id: i64,
) -> Result<bool, OntologyError> {
    let sql = format!(
        "SELECT a.value
         FROM ontology_entities e
         JOIN ontology_attrs a ON a.entity_id = e.id
         WHERE e.kind = ?1
           AND e.{link_column} = ?2
           AND a.key = ?3
           AND a.confidence >= 0.5"
    );
    let mut stmt = conn.prepare_cached(&sql)?;
    let mut rows = stmt.query(params![kind, linked_id, keys::SENSITIVITY])?;

    while let Some(row) = rows.next()? {
        let value: String = row.get(0)?;
        if let Ok(s) = Sensitivity::from_str(&value) {
            if s.restricted_or_private() {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::schema::ALL_MIGRATIONS;
    use crate::ontology::attrs::{assert_attr, NewAssertion};
    use crate::ontology::entities::upsert_entity;
    use crate::ontology::vocabulary::{keys, EntityKind, Sensitivity};
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
             VALUES (1, 1, '/root/safe.txt', 'safe.txt', 100, 0),
                    (2, 1, '/root/secret.pdf', 'secret.pdf', 200, 0)",
            [],
        )
        .unwrap();
        conn
    }

    #[test]
    fn files_without_sensitivity_are_visible() {
        let conn = migrated_conn();
        upsert_entity(&conn, EntityKind::File, "/root/safe.txt", Some(1), None, None).unwrap();
        assert!(is_globally_visible_file(&conn, 1).unwrap());
    }

    #[test]
    fn restricted_files_are_hidden() {
        let conn = migrated_conn();
        let e =
            upsert_entity(&conn, EntityKind::File, "/root/secret.pdf", Some(2), None, None)
                .unwrap();
        assert_attr(
            &conn,
            e.id,
            &NewAssertion {
                key: keys::SENSITIVITY,
                value: Sensitivity::Restricted.as_str(),
                source: "rule:path-personal-details",
                confidence: 1.0,
                display_in_global_views: true,
            },
        )
        .unwrap();
        assert!(!is_globally_visible_file(&conn, 2).unwrap());
    }

    #[test]
    fn private_files_are_hidden() {
        let conn = migrated_conn();
        let e =
            upsert_entity(&conn, EntityKind::File, "/root/secret.pdf", Some(2), None, None)
                .unwrap();
        assert_attr(
            &conn,
            e.id,
            &NewAssertion {
                key: keys::SENSITIVITY,
                value: Sensitivity::Private.as_str(),
                source: "user",
                confidence: 1.0,
                display_in_global_views: true,
            },
        )
        .unwrap();
        assert!(!is_globally_visible_file(&conn, 2).unwrap());
    }

    #[test]
    fn low_confidence_sensitivity_does_not_hide() {
        let conn = migrated_conn();
        let e =
            upsert_entity(&conn, EntityKind::File, "/root/secret.pdf", Some(2), None, None)
                .unwrap();
        assert_attr(
            &conn,
            e.id,
            &NewAssertion {
                key: keys::SENSITIVITY,
                value: Sensitivity::Restricted.as_str(),
                source: "heuristic:guess",
                confidence: 0.3,
                display_in_global_views: true,
            },
        )
        .unwrap();
        assert!(is_globally_visible_file(&conn, 2).unwrap());
    }

    #[test]
    fn folder_visibility_works_the_same_way() {
        let conn = migrated_conn();
        let e = upsert_entity(&conn, EntityKind::Folder, "/root", None, Some(1), None).unwrap();
        assert_attr(
            &conn,
            e.id,
            &NewAssertion {
                key: keys::SENSITIVITY,
                value: Sensitivity::Restricted.as_str(),
                source: "rule:path-personal-details",
                confidence: 1.0,
                display_in_global_views: true,
            },
        )
        .unwrap();
        assert!(!is_globally_visible_folder(&conn, 1).unwrap());
    }
}
