//! Entity CRUD.

use crate::ontology::vocabulary::EntityKind;
use crate::ontology::OntologyError;
use rusqlite::{params, Connection, OptionalExtension};
use std::str::FromStr;

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

/// Insert an entity, or return the one that already stands for the same thing.
///
/// "The same thing" is the linked row when there is one. A path is a label a
/// file wears, not the file: keying on it meant a rename produced a *second*
/// entity, with everything ever learned about that file left on the first and
/// nothing on the second. `linked_file_id` survives a rename, so it is the
/// identity, and the path follows the file rather than defining it.
///
/// An entity with no linked row -- a `Project`, a `Theme` -- has nothing else
/// to be identified by, so for those the canonical id is still the key. That is
/// correct: those ids are chosen names, not observations of a disk.
pub fn upsert_entity(
    conn: &Connection,
    kind: EntityKind,
    canonical_id: &str,
    linked_file_id: Option<i64>,
    linked_folder_id: Option<i64>,
    display_name: Option<&str>,
) -> Result<Entity, OntologyError> {
    if let Some(existing) = get_entity_by_link(conn, kind, linked_file_id, linked_folder_id)? {
        // The file is the same file; only what it is called has changed.
        if existing.canonical_id != canonical_id {
            conn.execute(
                "UPDATE ontology_entities SET canonical_id = ?1 WHERE id = ?2",
                params![canonical_id, existing.id],
            )?;
        }
        return get_entity(conn, existing.id)?
            .ok_or_else(|| OntologyError::Sqlite(rusqlite::Error::QueryReturnedNoRows));
    }

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

/// The entity standing for a linked `files` or `folders` row, if one exists.
/// `None` when the caller linked nothing -- there is no row to be identified by.
fn get_entity_by_link(
    conn: &Connection,
    kind: EntityKind,
    linked_file_id: Option<i64>,
    linked_folder_id: Option<i64>,
) -> Result<Option<Entity>, OntologyError> {
    let (column, id) = match (linked_file_id, linked_folder_id) {
        (Some(id), _) => ("linked_file_id", id),
        (None, Some(id)) => ("linked_folder_id", id),
        (None, None) => return Ok(None),
    };
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT id, kind, canonical_id, linked_file_id, linked_folder_id, display_name, created_at
         FROM ontology_entities WHERE kind = ?1 AND {column} = ?2"
    ))?;
    Ok(stmt.query_row(params![kind.as_str(), id], row_to_entity).optional()?)
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

    fn seed_one_file(conn: &Connection) {
        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
             VALUES (1, NULL, '/r', 'r', 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, size, indexed_at)
             VALUES (1, 1, '/r/old.txt', 'old.txt', 5, 0)",
            [],
        )
        .unwrap();
    }

    /// A rename must not create a second entity. It used to: everything ever
    /// learned about the file stayed on the first one and the populators wrote
    /// to a blank second one, so the file silently forgot itself.
    #[test]
    fn renaming_a_file_keeps_its_entity_and_everything_on_it() {
        let conn = migrated_conn();
        seed_one_file(&conn);

        let before =
            upsert_entity(&conn, EntityKind::File, "/r/old.txt", Some(1), None, None).unwrap();
        crate::ontology::attrs::assert_attr(
            &conn,
            before.id,
            &crate::ontology::attrs::NewAssertion {
                key: "role",
                value: "keep",
                source: "user",
                confidence: 1.0,
                display_in_global_views: true,
            },
        )
        .unwrap();

        // The scan renames the file. Same row, new path.
        conn.execute(
            "UPDATE files SET path = '/r/new.txt', name = 'new.txt' WHERE id = 1",
            [],
        )
        .unwrap();
        let after =
            upsert_entity(&conn, EntityKind::File, "/r/new.txt", Some(1), None, None).unwrap();

        assert_eq!(after.id, before.id, "one file, one entity");
        assert_eq!(
            after.canonical_id, "/r/new.txt",
            "the label follows the file"
        );
        let kept: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM ontology_attrs WHERE entity_id = ?1 AND key = 'role'",
                params![after.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(kept, 1, "what was asserted about the file is still about it");
    }

    /// An entity with nothing linked -- a Project, a Theme -- has no row to be
    /// identified by, so its chosen name is still its identity.
    #[test]
    fn an_unlinked_entity_is_still_keyed_by_its_chosen_name() {
        let conn = migrated_conn();
        let first =
            upsert_entity(&conn, EntityKind::Project, "proj-a", None, None, Some("A")).unwrap();
        let second =
            upsert_entity(&conn, EntityKind::Project, "proj-b", None, None, Some("B")).unwrap();
        assert_ne!(
            first.id, second.id,
            "two named projects are two entities, not one"
        );
    }

    /// Indexes an existing install already split have to be repaired, not just
    /// prevented from splitting further -- the history is on the older row.
    #[test]
    fn migration_merges_entities_that_already_split() {
        let conn = Connection::open_in_memory().unwrap();
        for (version, sql) in ALL_MIGRATIONS {
            if *version == 28 {
                // The state an older build left: one file, two entities, the
                // history on the first and a later assertion on the second.
                seed_one_file(&conn);
                conn.execute(
                    "INSERT INTO ontology_entities (id, kind, canonical_id, linked_file_id, created_at)
                     VALUES (1, 'File', '/r/old.txt', 1, 0), (2, 'File', '/r/new.txt', 1, 0)",
                    [],
                )
                .unwrap();
                conn.execute(
                    "INSERT INTO ontology_attrs
                        (entity_id, key, value, source, confidence, asserted_at, vocabulary_version)
                     VALUES (1, 'role', 'keep', 'user', 1.0, 0, 1),
                            (2, 'media', 'text', 'rule:ext', 0.9, 0, 1)",
                    [],
                )
                .unwrap();
            }
            conn.execute_batch(sql).unwrap();
        }

        let entities: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM ontology_entities WHERE linked_file_id = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(entities, 1, "the two collapse into one");

        let survivor: i64 = conn
            .query_row("SELECT id FROM ontology_entities WHERE linked_file_id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(survivor, 1, "the older row is the one that holds the history");

        let facts: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM ontology_attrs WHERE entity_id = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(facts, 2, "nothing asserted about the file is thrown away");
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
