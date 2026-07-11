//! Ontology-enabled toggle (per-index opt-in).
//!
//! A single row in `ontology_enabled` controls whether populators run and
//! ontology surfaces are exposed. Missing row means disabled.

use crate::ontology::OntologyError;
use rusqlite::{params, Connection};

pub fn enable(conn: &Connection) -> Result<(), OntologyError> {
    set_enabled(conn, true)
}

pub fn disable(conn: &Connection) -> Result<(), OntologyError> {
    set_enabled(conn, false)
}

pub fn is_enabled(conn: &Connection) -> Result<bool, OntologyError> {
    let mut stmt =
        conn.prepare_cached("SELECT enabled FROM ontology_enabled WHERE index_singleton = 1")?;
    let row: Option<i64> = stmt
        .query_row([], |r| r.get(0))
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(0),
            other => Err(other),
        })
        .ok();
    Ok(matches!(row, Some(1)))
}

fn set_enabled(conn: &Connection, enabled: bool) -> Result<(), OntologyError> {
    conn.execute(
        "INSERT INTO ontology_enabled (index_singleton, enabled, changed_at)
         VALUES (1, ?1, ?2)
         ON CONFLICT(index_singleton) DO UPDATE SET enabled = excluded.enabled, changed_at = excluded.changed_at",
        params![if enabled { 1 } else { 0 }, unix_now()],
    )?;
    Ok(())
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
        conn
    }

    #[test]
    fn defaults_to_disabled() {
        let conn = migrated_conn();
        assert!(!is_enabled(&conn).unwrap());
    }

    #[test]
    fn enable_then_disable() {
        let conn = migrated_conn();
        enable(&conn).unwrap();
        assert!(is_enabled(&conn).unwrap());

        disable(&conn).unwrap();
        assert!(!is_enabled(&conn).unwrap());
    }

    #[test]
    fn enable_is_idempotent() {
        let conn = migrated_conn();
        enable(&conn).unwrap();
        enable(&conn).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM ontology_enabled", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }
}
