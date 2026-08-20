//! The staging desk: things a person set aside, kept across restarts.
//!
//! Deliberately *not* pinning. `ontology_pinned_files` means "never delete
//! this", and it feeds the **Don't touch** label — so making "set this aside
//! while I think" write to the same table would quietly mark every uncertain
//! file undeletable forever. Two different intentions, two different tables.
//!
//! Rows are keyed on `path` because folders are staged as often as files and
//! have no file row. `file_id` rides along for files so a cleanup plan can
//! record the exact rows a person reviewed.

use crate::ontology::OntologyError;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StagedItem {
    pub id: i64,
    pub kind: String,
    pub path: String,
    pub file_id: Option<i64>,
    pub name: String,
    pub bytes: i64,
    pub verdict: Option<String>,
    pub reason: Option<String>,
    pub group_name: Option<String>,
    pub note: Option<String>,
    pub added_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NewStagedItem {
    pub kind: String,
    pub path: String,
    #[serde(default)]
    pub file_id: Option<i64>,
    pub name: String,
    #[serde(default)]
    pub bytes: i64,
    #[serde(default)]
    pub verdict: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub group_name: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
}

/// Add or update one staged item. Staging the same path twice is the same as
/// staging it once — `path` is UNIQUE, the same idempotence `pin_file` gets.
pub fn stage(conn: &Connection, item: &NewStagedItem) -> Result<(), OntologyError> {
    conn.execute(
        "INSERT INTO ontology_staged_items
            (kind, path, file_id, name, bytes, verdict, reason, group_name, note, added_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, strftime('%s','now'))
         ON CONFLICT(path) DO UPDATE SET
            kind = excluded.kind,
            file_id = excluded.file_id,
            name = excluded.name,
            bytes = excluded.bytes,
            verdict = excluded.verdict,
            reason = excluded.reason,
            -- A re-stage must not silently drop the group or note a person set.
            group_name = COALESCE(excluded.group_name, ontology_staged_items.group_name),
            note = COALESCE(excluded.note, ontology_staged_items.note)",
        params![
            item.kind,
            item.path,
            item.file_id,
            item.name,
            item.bytes,
            item.verdict,
            item.reason,
            item.group_name,
            item.note,
        ],
    )?;
    Ok(())
}

pub fn unstage(conn: &Connection, path: &str) -> Result<(), OntologyError> {
    conn.execute(
        "DELETE FROM ontology_staged_items WHERE path = ?1",
        params![path],
    )?;
    Ok(())
}

/// Everything on the desk, newest first within each group.
pub fn list_staged(conn: &Connection) -> Result<Vec<StagedItem>, OntologyError> {
    let mut stmt = conn.prepare(
        "SELECT id, kind, path, file_id, name, bytes, verdict, reason, group_name, note, added_at
         FROM ontology_staged_items
         ORDER BY group_name IS NULL, group_name ASC, added_at DESC, id DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(StagedItem {
            id: row.get(0)?,
            kind: row.get(1)?,
            path: row.get(2)?,
            file_id: row.get(3)?,
            name: row.get(4)?,
            bytes: row.get(5)?,
            verdict: row.get(6)?,
            reason: row.get(7)?,
            group_name: row.get(8)?,
            note: row.get(9)?,
            added_at: row.get(10)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(OntologyError::from)
}

/// Move a set of staged paths into a named group (or out of one, with `None`).
pub fn set_group(
    conn: &mut Connection,
    paths: &[String],
    group_name: Option<&str>,
) -> Result<(), OntologyError> {
    let tx = conn.transaction()?;
    for path in paths {
        tx.execute(
            "UPDATE ontology_staged_items SET group_name = ?2 WHERE path = ?1",
            params![path, group_name],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// Clear the desk, or just one group of it.
pub fn clear_staged(conn: &Connection, group_name: Option<&str>) -> Result<(), OntologyError> {
    match group_name {
        Some(g) => conn.execute(
            "DELETE FROM ontology_staged_items WHERE group_name = ?1",
            params![g],
        )?,
        None => conn.execute("DELETE FROM ontology_staged_items", [])?,
    };
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::schema::ALL_MIGRATIONS;

    fn migrated_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        for (_, sql) in ALL_MIGRATIONS {
            conn.execute_batch(sql).unwrap();
        }
        conn
    }

    fn item(path: &str, kind: &str, file_id: Option<i64>) -> NewStagedItem {
        NewStagedItem {
            kind: kind.to_string(),
            path: path.to_string(),
            file_id,
            name: path.rsplit(['/', '\\']).next().unwrap_or(path).to_string(),
            bytes: 100,
            verdict: Some("review".to_string()),
            reason: None,
            group_name: None,
            note: None,
        }
    }

    /// Folders are staged as often as files and have no file row — keying this
    /// table on `file_id` would have silently dropped every treemap selection.
    #[test]
    fn holds_folders_as_well_as_files() {
        let conn = migrated_conn();
        stage(&conn, &item(r"C:\Users\a\Downloads", "folder", None)).unwrap();
        stage(&conn, &item(r"C:\Users\a\big.iso", "file", Some(7))).unwrap();

        let rows = list_staged(&conn).unwrap();
        assert_eq!(rows.len(), 2);
        let folder = rows.iter().find(|r| r.kind == "folder").unwrap();
        assert_eq!(folder.file_id, None);
        let file = rows.iter().find(|r| r.kind == "file").unwrap();
        assert_eq!(file.file_id, Some(7));
    }

    #[test]
    fn staging_the_same_path_twice_is_staging_it_once() {
        let conn = migrated_conn();
        stage(&conn, &item(r"C:\a.iso", "file", Some(1))).unwrap();
        stage(&conn, &item(r"C:\a.iso", "file", Some(1))).unwrap();
        assert_eq!(list_staged(&conn).unwrap().len(), 1);
    }

    /// Re-staging happens whenever a view repaints its rows. It must not wipe
    /// the group a person put the item in — that is their work, not ours.
    #[test]
    fn re_staging_keeps_the_group_and_note() {
        let mut conn = migrated_conn();
        stage(&conn, &item(r"C:\a.iso", "file", Some(1))).unwrap();
        set_group(&mut conn, &[r"C:\a.iso".to_string()], Some("Archive")).unwrap();

        stage(&conn, &item(r"C:\a.iso", "file", Some(1))).unwrap();

        let rows = list_staged(&conn).unwrap();
        assert_eq!(rows[0].group_name.as_deref(), Some("Archive"));
    }

    #[test]
    fn unstage_and_clear_by_group() {
        let mut conn = migrated_conn();
        stage(&conn, &item(r"C:\a.iso", "file", Some(1))).unwrap();
        stage(&conn, &item(r"C:\b.iso", "file", Some(2))).unwrap();
        stage(&conn, &item(r"C:\c.iso", "file", Some(3))).unwrap();
        set_group(
            &mut conn,
            &[r"C:\a.iso".to_string(), r"C:\b.iso".to_string()],
            Some("Archive"),
        )
        .unwrap();

        unstage(&conn, r"C:\c.iso").unwrap();
        assert_eq!(list_staged(&conn).unwrap().len(), 2);

        clear_staged(&conn, Some("Archive")).unwrap();
        assert!(list_staged(&conn).unwrap().is_empty());
    }
}
