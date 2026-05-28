//! Typed-relation CRUD.

use crate::ontology::{OntologyError, VOCABULARY_VERSION};
use rusqlite::{params, Connection};

#[derive(Debug, Clone, PartialEq)]
pub struct Relation {
    pub id: i64,
    pub subject_id: i64,
    pub predicate: String,
    pub object_id: i64,
    pub source: String,
    pub confidence: f32,
    pub asserted_at: i64,
    pub vocabulary_version: i64,
}

pub struct NewRelation<'a> {
    pub subject_id: i64,
    pub predicate: &'a str,
    pub object_id: i64,
    pub source: &'a str,
    pub confidence: f32,
}

pub fn assert_relation(conn: &Connection, r: &NewRelation<'_>) -> Result<Relation, OntologyError> {
    let now = unix_now();
    conn.execute(
        "INSERT INTO ontology_relations
            (subject_id, predicate, object_id, source, confidence, asserted_at, vocabulary_version)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            r.subject_id,
            r.predicate,
            r.object_id,
            r.source,
            r.confidence,
            now,
            VOCABULARY_VERSION,
        ],
    )?;
    Ok(Relation {
        id: conn.last_insert_rowid(),
        subject_id: r.subject_id,
        predicate: r.predicate.to_string(),
        object_id: r.object_id,
        source: r.source.to_string(),
        confidence: r.confidence,
        asserted_at: now,
        vocabulary_version: VOCABULARY_VERSION,
    })
}

pub fn outbound(
    conn: &Connection,
    subject_id: i64,
    predicate: &str,
) -> Result<Vec<Relation>, OntologyError> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, subject_id, predicate, object_id, source, confidence, asserted_at, vocabulary_version
         FROM ontology_relations WHERE subject_id = ?1 AND predicate = ?2",
    )?;
    let rows = stmt
        .query_map(params![subject_id, predicate], row_to_relation)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn inbound(
    conn: &Connection,
    object_id: i64,
    predicate: &str,
) -> Result<Vec<Relation>, OntologyError> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, subject_id, predicate, object_id, source, confidence, asserted_at, vocabulary_version
         FROM ontology_relations WHERE object_id = ?1 AND predicate = ?2",
    )?;
    let rows = stmt
        .query_map(params![object_id, predicate], row_to_relation)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn row_to_relation(row: &rusqlite::Row<'_>) -> rusqlite::Result<Relation> {
    Ok(Relation {
        id: row.get(0)?,
        subject_id: row.get(1)?,
        predicate: row.get(2)?,
        object_id: row.get(3)?,
        source: row.get(4)?,
        confidence: row.get::<_, f64>(5)? as f32,
        asserted_at: row.get(6)?,
        vocabulary_version: row.get(7)?,
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
    use crate::ontology::vocabulary::{predicates, EntityKind};
    use rusqlite::Connection;

    fn migrated_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        for (_, sql) in ALL_MIGRATIONS {
            conn.execute_batch(sql).unwrap();
        }
        conn
    }

    fn seed_two_file_entities(conn: &Connection) -> (i64, i64) {
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
        let a = upsert_entity(conn, EntityKind::File, "/root/a.psd", Some(1), None, None)
            .unwrap()
            .id;
        let b = upsert_entity(conn, EntityKind::File, "/root/a.png", Some(2), None, None)
            .unwrap()
            .id;
        (a, b)
    }

    #[test]
    fn assert_outbound_inbound_round_trip() {
        let conn = migrated_conn();
        let (psd, png) = seed_two_file_entities(&conn);

        let r = assert_relation(
            &conn,
            &NewRelation {
                subject_id: png,
                predicate: predicates::DERIVED_FROM,
                object_id: psd,
                source: "heuristic:sibling-name",
                confidence: 0.55,
            },
        )
        .unwrap();

        assert!(r.id > 0);
        let out = outbound(&conn, png, predicates::DERIVED_FROM).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].object_id, psd);

        let inb = inbound(&conn, psd, predicates::DERIVED_FROM).unwrap();
        assert_eq!(inb.len(), 1);
        assert_eq!(inb[0].subject_id, png);
    }

    #[test]
    fn multiple_assertions_accumulate() {
        let conn = migrated_conn();
        let (psd, png) = seed_two_file_entities(&conn);

        for source in &["heuristic:sibling-name", "user"] {
            assert_relation(
                &conn,
                &NewRelation {
                    subject_id: png,
                    predicate: predicates::DERIVED_FROM,
                    object_id: psd,
                    source,
                    confidence: 0.8,
                },
            )
            .unwrap();
        }
        let out = outbound(&conn, png, predicates::DERIVED_FROM).unwrap();
        assert_eq!(out.len(), 2);
    }
}
