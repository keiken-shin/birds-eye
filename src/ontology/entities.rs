//! Entity CRUD.

use crate::ontology::vocabulary::EntityKind;
use crate::ontology::OntologyError;
use rusqlite::{params, Connection, OptionalExtension};

#[derive(Debug, Clone, PartialEq)]
pub struct Entity {
    pub id: i64,
    pub kind: EntityKind,
    pub canonical_id: String,
    pub linked_file_id: Option<i64>,
    pub linked_folder_id: Option<i64>,
    pub display_name: Option<String>,
    pub created_at: i64,
}

/// Insert an entity, or return the existing entity's row if one already exists
/// with the same `(kind, canonical_id)`.
pub fn upsert_entity(
    conn: &Connection,
    kind: EntityKind,
    canonical_id: &str,
    linked_file_id: Option<i64>,
    linked_folder_id: Option<i64>,
    display_name: Option<&str>,
) -> Result<Entity, OntologyError> {
    conn.execute(
        "INSERT OR IGNORE INTO ontology_entities
            (kind, canonical_id, linked_file_id, linked_folder_id, display_name, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            kind.as_str(),
            canonical_id,
            linked_file_id,
            linked_folder_id,
            display_name,
            unix_now(),
        ],
    )?;

    get_entity_by_canonical(conn, kind, canonical_id)?
        .ok_or_else(|| OntologyError::Sqlite(rusqlite::Error::QueryReturnedNoRows))
}

pub fn get_entity(conn: &Connection, id: i64) -> Result<Option<Entity>, OntologyError> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, kind, canonical_id, linked_file_id, linked_folder_id, display_name, created_at
         FROM ontology_entities WHERE id = ?1",
    )?;
    Ok(stmt.query_row(params![id], row_to_entity).optional()?)
}

pub fn get_entity_by_canonical(
    conn: &Connection,
    kind: EntityKind,
    canonical_id: &str,
) -> Result<Option<Entity>, OntologyError> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, kind, canonical_id, linked_file_id, linked_folder_id, display_name, created_at
         FROM ontology_entities WHERE kind = ?1 AND canonical_id = ?2",
    )?;
    Ok(stmt
        .query_row(params![kind.as_str(), canonical_id], row_to_entity)
        .optional()?)
}

pub fn find_entity_for_file(
    conn: &Connection,
    file_id: i64,
) -> Result<Option<Entity>, OntologyError> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, kind, canonical_id, linked_file_id, linked_folder_id, display_name, created_at
         FROM ontology_entities WHERE kind = 'File' AND linked_file_id = ?1",
    )?;
    Ok(stmt
        .query_row(params![file_id], row_to_entity)
        .optional()?)
}

pub fn find_entity_for_folder(
    conn: &Connection,
    folder_id: i64,
) -> Result<Option<Entity>, OntologyError> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, kind, canonical_id, linked_file_id, linked_folder_id, display_name, created_at
         FROM ontology_entities WHERE kind = 'Folder' AND linked_folder_id = ?1",
    )?;
    Ok(stmt
        .query_row(params![folder_id], row_to_entity)
        .optional()?)
}

fn row_to_entity(row: &rusqlite::Row<'_>) -> rusqlite::Result<Entity> {
    let kind_str: String = row.get(1)?;
    let kind = EntityKind::from_str(&kind_str).map_err(|_| {
        rusqlite::Error::InvalidColumnType(1, "kind".into(), rusqlite::types::Type::Text)
    })?;
    Ok(Entity {
        id: row.get(0)?,
        kind,
        canonical_id: row.get(2)?,
        linked_file_id: row.get(3)?,
        linked_folder_id: row.get(4)?,
        display_name: row.get(5)?,
        created_at: row.get(6)?,
    })
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
    use crate::ontology::vocabulary::EntityKind;
    use rusqlite::Connection;

    fn migrated_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        for (_, sql) in ALL_MIGRATIONS {
            conn.execute_batch(sql).unwrap();
        }
        conn
    }

    #[test]
    fn upsert_inserts_then_returns_existing() {
        let conn = migrated_conn();

        let first = upsert_entity(
            &conn,
            EntityKind::Project,
            "proj-uuid-1",
            None,
            None,
            Some("Japanese"),
        )
        .unwrap();
        assert_eq!(first.kind, EntityKind::Project);
        assert_eq!(first.canonical_id, "proj-uuid-1");
        assert_eq!(first.display_name.as_deref(), Some("Japanese"));

        let second = upsert_entity(
            &conn,
            EntityKind::Project,
            "proj-uuid-1",
            None,
            None,
            Some("Japanese"),
        )
        .unwrap();
        assert_eq!(second.id, first.id);
    }

    #[test]
    fn upsert_distinguishes_kinds() {
        let conn = migrated_conn();
        let a = upsert_entity(&conn, EntityKind::Project, "same-id", None, None, None).unwrap();
        let b = upsert_entity(&conn, EntityKind::Theme, "same-id", None, None, None).unwrap();
        assert_ne!(a.id, b.id);
        assert_eq!(a.kind, EntityKind::Project);
        assert_eq!(b.kind, EntityKind::Theme);
    }

    #[test]
    fn get_entity_roundtrips() {
        let conn = migrated_conn();
        let inserted = upsert_entity(
            &conn,
            EntityKind::Work,
            "Beyblade (2001)",
            None,
            None,
            Some("Beyblade"),
        )
        .unwrap();

        let fetched = get_entity(&conn, inserted.id).unwrap().expect("present");
        assert_eq!(fetched, inserted);

        assert!(get_entity(&conn, 9999).unwrap().is_none());
    }

    #[test]
    fn find_entity_for_file_and_folder() {
        let conn = migrated_conn();

        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
             VALUES (1, NULL, '/root', 'root', 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, size, indexed_at)
             VALUES (1, 1, '/root/a.txt', 'a.txt', 100, 0)",
            [],
        )
        .unwrap();

        let file_entity =
            upsert_entity(&conn, EntityKind::File, "/root/a.txt", Some(1), None, None).unwrap();
        let folder_entity =
            upsert_entity(&conn, EntityKind::Folder, "/root", None, Some(1), None).unwrap();

        assert_eq!(
            find_entity_for_file(&conn, 1).unwrap().unwrap().id,
            file_entity.id
        );
        assert_eq!(
            find_entity_for_folder(&conn, 1).unwrap().unwrap().id,
            folder_entity.id
        );
        assert!(find_entity_for_file(&conn, 999).unwrap().is_none());
    }
}
