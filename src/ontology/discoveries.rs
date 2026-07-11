//! Discoveries-queue CRUD.
//!
//! Populators use this queue to emit low-confidence, pattern-level facts for
//! later user confirmation. Confirmed discoveries can then graduate into
//! stronger ontology facts, while rejected or expired discoveries stay out of
//! normal assertion resolution.

use crate::ontology::OntologyError;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Discovery {
    pub id: i64,
    pub kind: String,
    pub payload: String,
    pub status: DiscoveryStatus,
    pub confidence: f32,
    pub potential_bytes_unlocked: u64,
    pub created_at: i64,
    pub resolved_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DiscoveryStatus {
    Pending,
    Confirmed,
    Rejected,
    Expired,
}

impl DiscoveryStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            DiscoveryStatus::Pending => "pending",
            DiscoveryStatus::Confirmed => "confirmed",
            DiscoveryStatus::Rejected => "rejected",
            DiscoveryStatus::Expired => "expired",
        }
    }

    pub fn from_str(s: &str) -> Result<Self, OntologyError> {
        match s {
            "pending" => Ok(DiscoveryStatus::Pending),
            "confirmed" => Ok(DiscoveryStatus::Confirmed),
            "rejected" => Ok(DiscoveryStatus::Rejected),
            "expired" => Ok(DiscoveryStatus::Expired),
            other => Err(OntologyError::InvalidVocabulary(format!(
                "DiscoveryStatus: {other}"
            ))),
        }
    }
}

pub struct NewDiscovery<'a> {
    pub kind: &'a str,
    pub payload_json: &'a str,
    pub confidence: f32,
    pub potential_bytes_unlocked: u64,
}

pub fn insert_discovery(
    conn: &Connection,
    d: &NewDiscovery<'_>,
) -> Result<Discovery, OntologyError> {
    let now = unix_now();
    let potential_bytes_unlocked =
        i64::try_from(d.potential_bytes_unlocked).map_err(|_| {
            OntologyError::Populator(
                "potential_bytes_unlocked exceeds sqlite INTEGER range".to_owned(),
            )
        })?;

    conn.execute(
        "INSERT INTO ontology_discoveries
            (kind, payload, status, confidence, potential_bytes_unlocked, created_at, resolved_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)",
        params![
            d.kind,
            d.payload_json,
            DiscoveryStatus::Pending.as_str(),
            d.confidence,
            potential_bytes_unlocked,
            now,
        ],
    )?;

    Ok(Discovery {
        id: conn.last_insert_rowid(),
        kind: d.kind.to_string(),
        payload: d.payload_json.to_string(),
        status: DiscoveryStatus::Pending,
        confidence: d.confidence,
        potential_bytes_unlocked: d.potential_bytes_unlocked,
        created_at: now,
        resolved_at: None,
    })
}

pub fn get_discovery(conn: &Connection, id: i64) -> Result<Option<Discovery>, OntologyError> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, kind, payload, status, confidence, potential_bytes_unlocked, created_at, resolved_at
         FROM ontology_discoveries WHERE id = ?1",
    )?;
    Ok(stmt.query_row(params![id], row_to_discovery).optional()?)
}

pub fn list_pending_by_kind(
    conn: &Connection,
    kind: &str,
    limit: u32,
) -> Result<Vec<Discovery>, OntologyError> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, kind, payload, status, confidence, potential_bytes_unlocked, created_at, resolved_at
         FROM ontology_discoveries
         WHERE status = 'pending' AND kind = ?1
         ORDER BY potential_bytes_unlocked DESC, confidence DESC
         LIMIT ?2",
    )?;
    let rows = stmt
        .query_map(params![kind, limit as i64], row_to_discovery)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn count_pending(conn: &Connection) -> Result<u64, OntologyError> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM ontology_discoveries WHERE status = 'pending'",
        [],
        |row| row.get(0),
    )?;
    Ok(count as u64)
}

fn row_to_discovery(row: &rusqlite::Row<'_>) -> rusqlite::Result<Discovery> {
    let status_str: String = row.get(3)?;
    let status = DiscoveryStatus::from_str(&status_str).map_err(|_| {
        rusqlite::Error::InvalidColumnType(3, "status".into(), rusqlite::types::Type::Text)
    })?;
    let potential_bytes_unlocked: i64 = row.get(5)?;
    if potential_bytes_unlocked < 0 {
        return Err(rusqlite::Error::InvalidColumnType(
            5,
            "potential_bytes_unlocked".into(),
            rusqlite::types::Type::Integer,
        ));
    }

    Ok(Discovery {
        id: row.get(0)?,
        kind: row.get(1)?,
        payload: row.get(2)?,
        status,
        confidence: row.get::<_, f64>(4)? as f32,
        potential_bytes_unlocked: potential_bytes_unlocked as u64,
        created_at: row.get(6)?,
        resolved_at: row.get(7)?,
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
    use rusqlite::{params, Connection};

    fn migrated_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        for (_, sql) in ALL_MIGRATIONS {
            conn.execute_batch(sql).unwrap();
        }
        conn
    }

    #[test]
    fn insert_and_get_discovery_round_trips() {
        let conn = migrated_conn();

        let inserted = insert_discovery(
            &conn,
            &NewDiscovery {
                kind: "duplicate-pattern",
                payload_json: r#"{"extension":"psd","pattern":"backup"}"#,
                confidence: 0.42,
                potential_bytes_unlocked: 4096,
            },
        )
        .unwrap();

        assert!(inserted.id > 0);
        assert_eq!(inserted.kind, "duplicate-pattern");
        assert_eq!(
            inserted.payload,
            r#"{"extension":"psd","pattern":"backup"}"#
        );
        assert_eq!(inserted.status, DiscoveryStatus::Pending);
        assert!((inserted.confidence - 0.42).abs() < 1e-6);
        assert_eq!(inserted.potential_bytes_unlocked, 4096);
        assert!(inserted.created_at > 0);
        assert_eq!(inserted.resolved_at, None);

        let fetched = get_discovery(&conn, inserted.id).unwrap().expect("present");
        assert_eq!(fetched, inserted);
        assert!(get_discovery(&conn, 9999).unwrap().is_none());
    }

    #[test]
    fn list_pending_by_kind_sorts_by_roi() {
        let conn = migrated_conn();

        let low_bytes = insert_discovery(
            &conn,
            &NewDiscovery {
                kind: "duplicate-pattern",
                payload_json: r#"{"name":"low-bytes"}"#,
                confidence: 0.99,
                potential_bytes_unlocked: 10,
            },
        )
        .unwrap();
        let high_confidence = insert_discovery(
            &conn,
            &NewDiscovery {
                kind: "duplicate-pattern",
                payload_json: r#"{"name":"high-confidence"}"#,
                confidence: 0.9,
                potential_bytes_unlocked: 100,
            },
        )
        .unwrap();
        let high_bytes = insert_discovery(
            &conn,
            &NewDiscovery {
                kind: "duplicate-pattern",
                payload_json: r#"{"name":"high-bytes"}"#,
                confidence: 0.1,
                potential_bytes_unlocked: 200,
            },
        )
        .unwrap();
        insert_discovery(
            &conn,
            &NewDiscovery {
                kind: "theme-pattern",
                payload_json: r#"{"name":"other-kind"}"#,
                confidence: 1.0,
                potential_bytes_unlocked: 999,
            },
        )
        .unwrap();

        let pending = list_pending_by_kind(&conn, "duplicate-pattern", 3).unwrap();
        let ids: Vec<i64> = pending.iter().map(|d| d.id).collect();
        assert_eq!(ids, vec![high_bytes.id, high_confidence.id, low_bytes.id]);

        let limit: u32 = 2;
        let limited = list_pending_by_kind(&conn, "duplicate-pattern", limit).unwrap();
        assert_eq!(limited.len(), 2);
        assert_eq!(limited[0].id, high_bytes.id);
        assert_eq!(limited[1].id, high_confidence.id);
    }

    #[test]
    fn count_pending_counts_only_pending() {
        let conn = migrated_conn();

        let pending = insert_discovery(
            &conn,
            &NewDiscovery {
                kind: "duplicate-pattern",
                payload_json: r#"{"name":"pending"}"#,
                confidence: 0.7,
                potential_bytes_unlocked: 20,
            },
        )
        .unwrap();
        let confirmed = insert_discovery(
            &conn,
            &NewDiscovery {
                kind: "duplicate-pattern",
                payload_json: r#"{"name":"confirmed"}"#,
                confidence: 0.8,
                potential_bytes_unlocked: 30,
            },
        )
        .unwrap();

        conn.execute(
            "UPDATE ontology_discoveries SET status = ?1, resolved_at = ?2 WHERE id = ?3",
            params![
                DiscoveryStatus::Confirmed.as_str(),
                confirmed.created_at + 1,
                confirmed.id
            ],
        )
        .unwrap();

        assert_eq!(count_pending(&conn).unwrap(), 1);
        assert_eq!(
            get_discovery(&conn, pending.id).unwrap().unwrap().status,
            DiscoveryStatus::Pending
        );
    }

    #[test]
    fn insert_rejects_potential_bytes_above_sqlite_integer_range() {
        let conn = migrated_conn();

        let err = insert_discovery(
            &conn,
            &NewDiscovery {
                kind: "duplicate-pattern",
                payload_json: r#"{"name":"too-large"}"#,
                confidence: 0.9,
                potential_bytes_unlocked: i64::MAX as u64 + 1,
            },
        )
        .expect_err("overflow should be rejected");

        match err {
            OntologyError::Populator(msg) => {
                assert!(msg.contains("potential_bytes_unlocked"));
            }
            other => panic!("expected populator error, got {other:?}"),
        }
    }

    #[test]
    fn get_discovery_rejects_negative_potential_bytes() {
        let conn = migrated_conn();

        conn.execute(
            "INSERT INTO ontology_discoveries
                (id, kind, payload, status, confidence, potential_bytes_unlocked, created_at, resolved_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)",
            params![
                42_i64,
                "duplicate-pattern",
                r#"{"name":"corrupt"}"#,
                DiscoveryStatus::Pending.as_str(),
                0.5_f64,
                -1_i64,
                123_i64,
            ],
        )
        .unwrap();

        let err = get_discovery(&conn, 42).expect_err("negative bytes should be rejected");
        match err {
            OntologyError::Sqlite(rusqlite::Error::InvalidColumnType(index, name, _)) => {
                assert_eq!(index, 5);
                assert_eq!(name, "potential_bytes_unlocked");
            }
            other => panic!("expected invalid column type, got {other:?}"),
        }
    }
}
