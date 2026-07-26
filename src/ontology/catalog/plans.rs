//! Relocation plans: an explicit per-file (from, to) list.
//!
//! Unlike a cleanup plan — which stores a scope predicate and recomputes its
//! candidates — a relocation's destinations are chosen per file and cannot be
//! re-derived, so they are persisted as rows.

use crate::ontology::OntologyError;
use rusqlite::{params, Connection};
use serde::Serialize;

pub struct PlanItem {
    pub file_id: i64,
    pub from_path: String,
    pub to_path: String,
    pub size: i64,
    pub discovery_id: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PlannedItem {
    pub id: i64,
    pub file_id: i64,
    pub from_path: String,
    pub to_path: String,
    pub size: i64,
    pub status: String,
    pub note: Option<String>,
}

pub fn create_plan(conn: &Connection, items: &[PlanItem]) -> Result<i64, OntologyError> {
    conn.execute(
        "INSERT INTO ontology_relocation_plans (created_at, status)
         VALUES (strftime('%s','now'), 'draft')",
        [],
    )?;
    let plan_id = conn.last_insert_rowid();

    for item in items {
        conn.execute(
            "INSERT INTO ontology_relocation_plan_items
                (plan_id, discovery_id, file_id, from_path, to_path, size, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'planned')",
            params![
                plan_id,
                item.discovery_id,
                item.file_id,
                item.from_path,
                item.to_path,
                item.size
            ],
        )?;
    }
    Ok(plan_id)
}

pub fn plan_items(conn: &Connection, plan_id: i64) -> Result<Vec<PlannedItem>, OntologyError> {
    let mut stmt = conn.prepare(
        "SELECT id, file_id, from_path, to_path, size, status, note
         FROM ontology_relocation_plan_items
         WHERE plan_id = ?1
         ORDER BY id ASC",
    )?;
    let rows = stmt.query_map([plan_id], |row| {
        Ok(PlannedItem {
            id: row.get(0)?,
            file_id: row.get(1)?,
            from_path: row.get(2)?,
            to_path: row.get(3)?,
            size: row.get(4)?,
            status: row.get(5)?,
            note: row.get(6)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(OntologyError::from)
}

pub fn set_plan_status(conn: &Connection, plan_id: i64, status: &str) -> Result<(), OntologyError> {
    conn.execute(
        "UPDATE ontology_relocation_plans
         SET status = ?2,
             executed_at = CASE WHEN ?2 = 'executed' THEN strftime('%s','now') ELSE executed_at END
         WHERE id = ?1",
        params![plan_id, status],
    )?;
    Ok(())
}

pub fn set_item_status(
    conn: &Connection,
    item_id: i64,
    status: &str,
    note: Option<&str>,
) -> Result<(), OntologyError> {
    conn.execute(
        "UPDATE ontology_relocation_plan_items SET status = ?2, note = ?3 WHERE id = ?1",
        params![item_id, status, note],
    )?;
    Ok(())
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
    fn creates_a_draft_plan_with_per_file_destinations() {
        let conn = migrated_conn();
        let plan_id = create_plan(
            &conn,
            &[
                PlanItem {
                    file_id: 1,
                    from_path: "C:\\Inbox\\a.exe".to_string(),
                    to_path: "D:\\Software\\a.exe".to_string(),
                    size: 10,
                    discovery_id: Some(7),
                },
                PlanItem {
                    file_id: 2,
                    from_path: "C:\\Inbox\\b.exe".to_string(),
                    to_path: "D:\\Software\\b.exe".to_string(),
                    size: 20,
                    discovery_id: Some(7),
                },
            ],
        )
        .unwrap();

        let items = plan_items(&conn, plan_id).unwrap();
        assert_eq!(items.len(), 2);
        assert!(items.iter().all(|i| i.status == "planned"));
        // Each item carries its OWN destination — this is what a cleanup scope
        // predicate cannot express.
        assert_eq!(items[0].to_path, "D:\\Software\\a.exe");
        assert_eq!(items[1].to_path, "D:\\Software\\b.exe");

        let status: String = conn
            .query_row(
                "SELECT status FROM ontology_relocation_plans WHERE id = ?1",
                [plan_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(status, "draft");
    }

    #[test]
    fn item_status_and_note_persist() {
        let conn = migrated_conn();
        let plan_id = create_plan(
            &conn,
            &[PlanItem {
                file_id: 1,
                from_path: "a".to_string(),
                to_path: "b".to_string(),
                size: 1,
                discovery_id: None,
            }],
        )
        .unwrap();
        let item_id = plan_items(&conn, plan_id).unwrap()[0].id;

        set_item_status(&conn, item_id, "skipped", Some("vanished")).unwrap();

        let after = plan_items(&conn, plan_id).unwrap();
        assert_eq!(after[0].status, "skipped");
        assert_eq!(after[0].note.as_deref(), Some("vanished"));
    }
}
