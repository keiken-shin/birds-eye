//! Attribute (EAV) CRUD and resolution.

use crate::ontology::{source_priority, OntologyError, VOCABULARY_VERSION};
use rusqlite::{params, Connection};

#[derive(Debug, Clone, PartialEq)]
pub struct Assertion {
    pub id: i64,
    pub entity_id: i64,
    pub key: String,
    pub value: String,
    pub source: String,
    pub confidence: f32,
    pub asserted_at: i64,
    pub vocabulary_version: i64,
    pub display_in_global_views: bool,
}

pub struct NewAssertion<'a> {
    pub key: &'a str,
    pub value: &'a str,
    pub source: &'a str,
    pub confidence: f32,
    pub display_in_global_views: bool,
}

/// Insert a new assertion. Multiple assertions for the same `(entity, key)` are
/// allowed; resolution at query time picks the winning value.
pub fn assert_attr(
    conn: &Connection,
    entity_id: i64,
    a: &NewAssertion<'_>,
) -> Result<Assertion, OntologyError> {
    let now = unix_now();
    conn.execute(
        "INSERT INTO ontology_attrs
            (entity_id, key, value, source, confidence, asserted_at, vocabulary_version, display_in_global_views)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            entity_id,
            a.key,
            a.value,
            a.source,
            a.confidence,
            now,
            VOCABULARY_VERSION,
            if a.display_in_global_views { 1 } else { 0 },
        ],
    )?;
    let id = conn.last_insert_rowid();
    Ok(Assertion {
        id,
        entity_id,
        key: a.key.to_string(),
        value: a.value.to_string(),
        source: a.source.to_string(),
        confidence: a.confidence,
        asserted_at: now,
        vocabulary_version: VOCABULARY_VERSION,
        display_in_global_views: a.display_in_global_views,
    })
}

pub fn get_attrs(
    conn: &Connection,
    entity_id: i64,
    key: &str,
) -> Result<Vec<Assertion>, OntologyError> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, entity_id, key, value, source, confidence, asserted_at, vocabulary_version, display_in_global_views
         FROM ontology_attrs WHERE entity_id = ?1 AND key = ?2",
    )?;
    let rows = stmt
        .query_map(params![entity_id, key], row_to_assertion)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Returns the winning assertion for an entity+key:
/// highest confidence, then source priority, then newest assertion.
pub fn resolve_attr(
    conn: &Connection,
    entity_id: i64,
    key: &str,
) -> Result<Option<Assertion>, OntologyError> {
    let candidates = get_attrs(conn, entity_id, key)?;
    Ok(candidates.into_iter().max_by(|a, b| {
        a.confidence
            .partial_cmp(&b.confidence)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| source_priority(&a.source).cmp(&source_priority(&b.source)))
            .then_with(|| a.asserted_at.cmp(&b.asserted_at))
    }))
}

fn row_to_assertion(row: &rusqlite::Row<'_>) -> rusqlite::Result<Assertion> {
    Ok(Assertion {
        id: row.get(0)?,
        entity_id: row.get(1)?,
        key: row.get(2)?,
        value: row.get(3)?,
        source: row.get(4)?,
        confidence: row.get::<_, f64>(5)? as f32,
        asserted_at: row.get(6)?,
        vocabulary_version: row.get(7)?,
        display_in_global_views: row.get::<_, i64>(8)? != 0,
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
    use crate::ontology::entities::upsert_entity;
    use crate::ontology::vocabulary::EntityKind;
    use rusqlite::Connection;

    fn migrated_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        for (_, sql) in ALL_MIGRATIONS {
            conn.execute_batch(sql).unwrap();
        }
        conn
    }

    fn seed_file_entity(conn: &Connection) -> i64 {
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
        upsert_entity(conn, EntityKind::File, "/root/a.txt", Some(1), None, None)
            .unwrap()
            .id
    }

    #[test]
    fn assert_and_get_attrs() {
        let conn = migrated_conn();
        let eid = seed_file_entity(&conn);

        let a = assert_attr(
            &conn,
            eid,
            &NewAssertion {
                key: "role",
                value: "source",
                source: "rule:psd-extension",
                confidence: 0.85,
                display_in_global_views: true,
            },
        )
        .unwrap();

        assert!(a.id > 0);
        let fetched = get_attrs(&conn, eid, "role").unwrap();
        assert_eq!(fetched.len(), 1);
        assert_eq!(fetched[0].value, "source");
        assert_eq!(fetched[0].source, "rule:psd-extension");
        assert!((fetched[0].confidence - 0.85).abs() < 1e-6);
    }

    #[test]
    fn resolve_prefers_higher_confidence() {
        let conn = migrated_conn();
        let eid = seed_file_entity(&conn);

        assert_attr(
            &conn,
            eid,
            &NewAssertion {
                key: "role",
                value: "source",
                source: "rule:r1",
                confidence: 0.5,
                display_in_global_views: true,
            },
        )
        .unwrap();
        assert_attr(
            &conn,
            eid,
            &NewAssertion {
                key: "role",
                value: "derivative",
                source: "heuristic:h1",
                confidence: 0.9,
                display_in_global_views: true,
            },
        )
        .unwrap();

        let winner = resolve_attr(&conn, eid, "role").unwrap().unwrap();
        assert_eq!(winner.value, "derivative");
    }

    #[test]
    fn resolve_tie_broken_by_source_priority() {
        let conn = migrated_conn();
        let eid = seed_file_entity(&conn);

        assert_attr(
            &conn,
            eid,
            &NewAssertion {
                key: "role",
                value: "source",
                source: "rule:r1",
                confidence: 0.7,
                display_in_global_views: true,
            },
        )
        .unwrap();
        assert_attr(
            &conn,
            eid,
            &NewAssertion {
                key: "role",
                value: "derivative",
                source: "user",
                confidence: 0.7,
                display_in_global_views: true,
            },
        )
        .unwrap();

        let winner = resolve_attr(&conn, eid, "role").unwrap().unwrap();
        assert_eq!(winner.value, "derivative", "user should beat rule on tie");
    }

    #[test]
    fn resolve_returns_none_when_absent() {
        let conn = migrated_conn();
        let eid = seed_file_entity(&conn);
        assert!(resolve_attr(&conn, eid, "role").unwrap().is_none());
    }
}
