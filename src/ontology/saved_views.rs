//! Wave 1 starter saved-views library (spec §10).
//!
//! Each view is a parameterized read-only query over the existing `files` table
//! joined to ontology facts. Cross-cutting lists exclude files whose resolved
//! sensitivity attr carries `display_in_global_views = 0` (invariant #12).

use crate::ontology::OntologyError;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SavedView {
    pub id: String,
    pub name: String,
    pub description: String,
    /// True when this view lists *protected* files, not cleanup candidates.
    pub protective: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SavedViewRow {
    pub file_id: i64,
    pub path: String,
    pub size: i64,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ViewParams {
    /// For the "untouched N days" views; defaults to 365.
    pub days: Option<i64>,
    /// For the size-threshold view; defaults to 100 MB.
    pub min_bytes: Option<i64>,
}

pub fn list_saved_views() -> Vec<SavedView> {
    vec![
        SavedView { id: "finished-untouched".into(), name: "Finished projects untouched 1+ year".into(), description: "Files in projects marked finished or archived, not accessed in over a year.".into(), protective: false },
        SavedView { id: "regenerable-large".into(), name: "Regenerable derivatives over 100 MB".into(), description: "Large derivative files that can be regenerated from a surviving source.".into(), protective: false },
        SavedView { id: "unprojected-files".into(), name: "Files in folders not part of any Project".into(), description: "Files whose folder has no project membership yet.".into(), protective: false },
        SavedView { id: "unclassified".into(), name: "Files with no classification yet".into(), description: "Files lacking any role — an invitation to classify.".into(), protective: false },
        SavedView { id: "orphan-sources".into(), name: "Sources with no surviving derivatives".into(), description: "Source files whose derivatives are gone — archive candidates.".into(), protective: false },
        SavedView { id: "orphan-backups".into(), name: "Backups whose origin no longer exists".into(), description: "Protected: the only surviving copy. Never cleanup candidates.".into(), protective: true },
    ]
}

const NOT_SENSITIVE: &str = "
  AND NOT EXISTS (
    SELECT 1 FROM ontology_entities se
    JOIN ontology_attrs sa ON sa.entity_id = se.id AND sa.key = 'sensitivity'
    WHERE se.kind = 'File' AND se.linked_file_id = f.id AND sa.display_in_global_views = 0
  )";

fn unix_now() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn query_rows(conn: &Connection, sql: &str, p: &[&dyn rusqlite::ToSql]) -> Result<Vec<SavedViewRow>, OntologyError> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt
        .query_map(p, |r| {
            Ok(SavedViewRow { file_id: r.get(0)?, path: r.get(1)?, size: r.get(2)? })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Run a saved view by id. Read-only; never mutates.
pub fn run_saved_view(
    conn: &Connection,
    view_id: &str,
    params: &ViewParams,
) -> Result<Vec<SavedViewRow>, OntologyError> {
    let days = params.days.unwrap_or(365);
    let cutoff = unix_now() - days * 86_400;
    let min_bytes = params.min_bytes.unwrap_or(100 * 1024 * 1024);

    match view_id {
        // 1. Finished/archived projects, untouched > N days.
        "finished-untouched" => query_rows(
            conn,
            &format!(
                "SELECT f.id, f.path, f.size FROM files f
                 JOIN ontology_entities e ON e.kind = 'File' AND e.linked_file_id = f.id
                 JOIN ontology_relations r ON r.subject_id = e.id AND r.predicate = 'partOf'
                 JOIN ontology_entities pe ON pe.id = r.object_id AND pe.kind = 'Project'
                 JOIN ontology_attrs la ON la.entity_id = pe.id AND la.key = 'lifecycle'
                    AND la.value IN ('finished','archived')
                 WHERE f.deleted_at IS NULL
                   AND COALESCE(f.accessed_at, f.modified_at, 0) < ?1
                   {NOT_SENSITIVE}
                 GROUP BY f.id ORDER BY f.size DESC"
            ),
            &[&cutoff],
        ),
        // 2. Regenerable derivatives over min_bytes.
        "regenerable-large" => query_rows(
            conn,
            &format!(
                "SELECT f.id, f.path, f.size FROM files f
                 JOIN ontology_entities e ON e.kind = 'File' AND e.linked_file_id = f.id
                 WHERE f.deleted_at IS NULL AND f.size > ?1
                   AND EXISTS (SELECT 1 FROM ontology_attrs a WHERE a.entity_id = e.id AND a.key='role' AND a.value='derivative')
                   AND EXISTS (SELECT 1 FROM ontology_attrs a WHERE a.entity_id = e.id AND a.key='replaceability' AND a.value='regenerable')
                   {NOT_SENSITIVE}
                 ORDER BY f.size DESC"
            ),
            &[&min_bytes],
        ),
        // 3. Files whose folder is not part of any Project.
        "unprojected-files" => query_rows(
            conn,
            &format!(
                "SELECT f.id, f.path, f.size FROM files f
                 JOIN ontology_entities e ON e.kind = 'File' AND e.linked_file_id = f.id
                 WHERE f.deleted_at IS NULL
                   AND NOT EXISTS (SELECT 1 FROM ontology_relations r WHERE r.subject_id = e.id AND r.predicate = 'partOf')
                   {NOT_SENSITIVE}
                 ORDER BY f.size DESC"
            ),
            &[],
        ),
        // 4. Files lacking any role.
        "unclassified" => query_rows(
            conn,
            &format!(
                "SELECT f.id, f.path, f.size FROM files f
                 JOIN ontology_entities e ON e.kind = 'File' AND e.linked_file_id = f.id
                 WHERE f.deleted_at IS NULL
                   AND NOT EXISTS (SELECT 1 FROM ontology_attrs a WHERE a.entity_id = e.id AND a.key = 'role')
                   {NOT_SENSITIVE}
                 ORDER BY f.size DESC"
            ),
            &[],
        ),
        // 5. role=source with no surviving (non-deleted) derivative.
        "orphan-sources" => query_rows(
            conn,
            &format!(
                "SELECT f.id, f.path, f.size FROM files f
                 JOIN ontology_entities e ON e.kind = 'File' AND e.linked_file_id = f.id
                 WHERE f.deleted_at IS NULL
                   AND EXISTS (SELECT 1 FROM ontology_attrs a WHERE a.entity_id = e.id AND a.key='role' AND a.value='source')
                   AND NOT EXISTS (
                     SELECT 1 FROM ontology_relations r
                     JOIN ontology_entities de ON de.id = r.subject_id
                     JOIN files df ON df.id = de.linked_file_id AND df.deleted_at IS NULL
                     WHERE r.predicate = 'derivedFrom' AND r.object_id = e.id)
                   {NOT_SENSITIVE}
                 ORDER BY f.size DESC"
            ),
            &[],
        ),
        // 6. PROTECTIVE: role=backup whose origin is gone-from-disk.
        "orphan-backups" => query_rows(
            conn,
            &format!(
                "SELECT f.id, f.path, f.size FROM files f
                 JOIN ontology_entities e ON e.kind = 'File' AND e.linked_file_id = f.id
                 WHERE f.deleted_at IS NULL
                   AND EXISTS (SELECT 1 FROM ontology_attrs a WHERE a.entity_id = e.id AND a.key='role' AND a.value='backup')
                   AND EXISTS (
                     SELECT 1 FROM ontology_relations r
                     JOIN ontology_entities oe ON oe.id = r.object_id
                     LEFT JOIN files of ON of.id = oe.linked_file_id
                     WHERE r.predicate = 'backupOf' AND r.subject_id = e.id
                       AND (of.id IS NULL OR of.deleted_at IS NOT NULL))
                   {NOT_SENSITIVE}
                 ORDER BY f.size DESC"
            ),
            &[],
        ),
        other => Err(OntologyError::Populator(format!("unknown saved view: {other}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::schema::ALL_MIGRATIONS;
    use crate::ontology::attrs::{assert_attr, NewAssertion};
    use crate::ontology::entities::upsert_entity;
    use crate::ontology::vocabulary::{keys, EntityKind};
    use rusqlite::params;

    fn migrated_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        for (_, sql) in ALL_MIGRATIONS {
            conn.execute_batch(sql).unwrap();
        }
        conn
    }

    fn ensure_folder(conn: &Connection, folder_id: i64) {
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM folders WHERE id = ?1",
                params![folder_id],
                |r| r.get(0),
            )
            .unwrap();
        if exists == 0 {
            conn.execute(
                "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at) VALUES (?1, NULL, '/root', 'root', 0, 0)",
                params![folder_id],
            )
            .unwrap();
        }
    }

    fn seed_file(conn: &Connection, id: i64, path: &str, size: i64) -> i64 {
        ensure_folder(conn, 1);
        let name = path.rsplit('/').next().unwrap_or(path);
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, size, indexed_at, hash_state) VALUES (?1, 1, ?2, ?3, ?4, 0, 4)",
            params![id, path, name, size],
        )
        .unwrap();
        upsert_entity(conn, EntityKind::File, path, Some(id), None, None)
            .unwrap()
            .id
    }

    #[test]
    fn catalog_has_six_views_with_one_protective() {
        let views = list_saved_views();
        assert_eq!(views.len(), 6);
        assert_eq!(views.iter().filter(|v| v.protective).count(), 1);
        assert!(views.iter().any(|v| v.id == "orphan-backups" && v.protective));
    }

    #[test]
    fn unclassified_view_lists_files_without_role() {
        let conn = migrated_conn();
        let classified = seed_file(&conn, 1, "/a/has_role.png", 10);
        seed_file(&conn, 2, "/a/no_role.png", 20);
        assert_attr(&conn, classified, &NewAssertion { key: keys::ROLE, value: "derivative", source: "rule:x", confidence: 0.9, display_in_global_views: true }).unwrap();

        let rows = run_saved_view(&conn, "unclassified", &ViewParams::default()).unwrap();
        let ids: Vec<i64> = rows.iter().map(|r| r.file_id).collect();
        assert_eq!(ids, vec![2]);
    }

    #[test]
    fn regenerable_large_respects_min_bytes_and_facts() {
        let conn = migrated_conn();
        let big = seed_file(&conn, 1, "/a/big.png", 200_000_000);
        let small = seed_file(&conn, 2, "/a/small.png", 10);
        for e in [big, small] {
            assert_attr(&conn, e, &NewAssertion { key: keys::ROLE, value: "derivative", source: "user", confidence: 1.0, display_in_global_views: true }).unwrap();
            assert_attr(&conn, e, &NewAssertion { key: keys::REPLACEABILITY, value: "regenerable", source: "user", confidence: 1.0, display_in_global_views: true }).unwrap();
        }
        let rows = run_saved_view(&conn, "regenerable-large", &ViewParams::default()).unwrap();
        assert_eq!(rows.iter().map(|r| r.file_id).collect::<Vec<_>>(), vec![1]);
    }

    #[test]
    fn sensitive_files_are_excluded_from_listings() {
        let conn = migrated_conn();
        let e = seed_file(&conn, 1, "/Personal Details/secret.png", 20);
        // Unclassified (no role) but sensitivity stored with display_in_global_views = 0.
        assert_attr(&conn, e, &NewAssertion { key: keys::SENSITIVITY, value: "restricted", source: "rule:x", confidence: 1.0, display_in_global_views: false }).unwrap();
        let rows = run_saved_view(&conn, "unclassified", &ViewParams::default()).unwrap();
        assert!(rows.is_empty(), "sensitive file must not appear in cross-cutting view");
    }

    #[test]
    fn unknown_view_id_errors() {
        let conn = migrated_conn();
        let err = run_saved_view(&conn, "nope", &ViewParams::default()).unwrap_err();
        match err {
            OntologyError::Populator(msg) => assert!(msg.contains("unknown saved view")),
            other => panic!("expected populator error, got {other:?}"),
        }
    }
}
