//! Candidate query over `v_cleanup_candidates` plus scope filtering.

use crate::ontology::cleanup::CleanupCandidate;
use crate::ontology::OntologyError;
use rusqlite::Connection;

/// Read every cleanup candidate from the view (no scope filter).
pub fn list_all_candidates(conn: &Connection) -> Result<Vec<CleanupCandidate>, OntologyError> {
    let mut stmt = conn.prepare_cached(
        "SELECT file_id, entity_id, path, size, reason
         FROM v_cleanup_candidates
         ORDER BY size DESC, file_id ASC",
    )?;
    let rows = stmt
        .query_map([], row_to_candidate)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Apply a scope filter to an already-fetched candidate list.
/// - `reasons`: keep only candidates whose reason is in this set (empty = all reasons).
/// - `max_size`: keep only candidates with `size <= max_size` (None = no cap).
/// - `path_prefix`: keep only candidates at or under this path (None = any path).
pub fn filter_candidates(
    candidates: Vec<CleanupCandidate>,
    reasons: &[String],
    max_size: Option<i64>,
    path_prefix: Option<&str>,
) -> Vec<CleanupCandidate> {
    candidates
        .into_iter()
        .filter(|c| reasons.is_empty() || reasons.iter().any(|r| r == &c.reason))
        .filter(|c| max_size.map(|m| c.size <= m).unwrap_or(true))
        .filter(|c| path_prefix.map(|p| path_under_prefix(&c.path, p)).unwrap_or(true))
        .collect()
}

/// Boundary-aware path scoping: `path` matches `prefix` only when it IS the prefix or sits
/// under it past a separator. A raw `starts_with` would let staging file `report.txt` also
/// sweep `report.txt.bak`, or folder `proj` also sweep sibling `project` — data loss.
fn path_under_prefix(path: &str, prefix: &str) -> bool {
    if path == prefix {
        return true;
    }
    let stem = prefix.trim_end_matches(['/', '\\']);
    if stem.is_empty() {
        return true; // prefix was only separators (e.g. a drive/filesystem root) → matches all
    }
    match path.strip_prefix(stem) {
        Some(rest) => rest.starts_with('/') || rest.starts_with('\\'),
        None => false,
    }
}

fn row_to_candidate(row: &rusqlite::Row<'_>) -> rusqlite::Result<CleanupCandidate> {
    Ok(CleanupCandidate {
        file_id: row.get(0)?,
        entity_id: row.get(1)?,
        path: row.get(2)?,
        size: row.get(3)?,
        reason: row.get(4)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::schema::ALL_MIGRATIONS;
    use crate::ontology::attrs::{assert_attr, NewAssertion};
    use crate::ontology::entities::upsert_entity;
    use crate::ontology::pinning::pin_file;
    use crate::ontology::relations::{assert_relation, NewRelation};
    use crate::ontology::vocabulary::{keys, predicates, EntityKind};
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
        conn
    }

    fn add_file(conn: &Connection, id: i64, path: &str, size: i64) -> i64 {
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, size, indexed_at)
             VALUES (?1, 1, ?2, ?2, ?3, 0)",
            rusqlite::params![id, path, size],
        )
        .unwrap();
        upsert_entity(conn, EntityKind::File, path, Some(id), None, None)
            .unwrap()
            .id
    }

    fn set_role(conn: &Connection, entity_id: i64, value: &str, conf: f32) {
        assert_attr(
            conn,
            entity_id,
            &NewAssertion {
                key: keys::ROLE,
                value,
                source: "rule:test",
                confidence: conf,
                display_in_global_views: true,
            },
        )
        .unwrap();
    }

    fn set_attr(conn: &Connection, entity_id: i64, key: &str, value: &str, conf: f32) {
        assert_attr(
            conn,
            entity_id,
            &NewAssertion {
                key,
                value,
                source: "rule:test",
                confidence: conf,
                display_in_global_views: true,
            },
        )
        .unwrap();
    }

    #[test]
    fn safe_derivative_with_surviving_source_is_a_candidate() {
        let conn = migrated_conn();
        let src = add_file(&conn, 1, "/root/Logo.psd", 5_000_000);
        let der = add_file(&conn, 2, "/root/Logo.png", 200_000);
        set_role(&conn, der, "derivative", 0.9);
        set_attr(&conn, der, keys::REPLACEABILITY, "regenerable", 0.95);
        assert_relation(
            &conn,
            &NewRelation {
                subject_id: der,
                predicate: predicates::DERIVED_FROM,
                object_id: src,
                source: "user",
                confidence: 1.0,
            },
        )
        .unwrap();

        let cands = list_all_candidates(&conn).unwrap();
        assert_eq!(cands.len(), 1);
        assert_eq!(cands[0].file_id, 2);
        assert_eq!(cands[0].reason, "safe-derivative");
    }

    #[test]
    fn irreplaceable_file_is_never_a_candidate() {
        // Constitutional Defense #4.
        let conn = migrated_conn();
        let der = add_file(&conn, 1, "/root/precious.png", 100);
        set_role(&conn, der, "derivative", 0.9);
        set_attr(&conn, der, keys::REPLACEABILITY, "irreplaceable", 0.95);

        let cands = list_all_candidates(&conn).unwrap();
        assert!(cands.is_empty(), "irreplaceable must never appear");
    }

    #[test]
    fn pinned_file_is_never_a_candidate() {
        // Constitutional Defense #9.
        let conn = migrated_conn();
        let scratch = add_file(&conn, 1, "/root/node_modules/x.js", 100);
        set_role(&conn, scratch, "scratch", 0.95);
        // Without a pin it is a candidate:
        assert_eq!(list_all_candidates(&conn).unwrap().len(), 1);
        pin_file(&conn, 1, Some("keep")).unwrap();
        assert!(
            list_all_candidates(&conn).unwrap().is_empty(),
            "pinned file must be excluded"
        );
    }

    #[test]
    fn restricted_sensitivity_file_is_never_a_candidate() {
        let conn = migrated_conn();
        let f = add_file(&conn, 1, "/root/Personal Details/passport.png", 100);
        set_role(&conn, f, "scratch", 0.95); // would otherwise qualify
        set_attr(&conn, f, keys::SENSITIVITY, "restricted", 1.0);
        assert!(list_all_candidates(&conn).unwrap().is_empty());
    }

    #[test]
    fn scratch_below_confidence_threshold_is_not_a_candidate() {
        let conn = migrated_conn();
        let f = add_file(&conn, 1, "/root/dist/x.js", 100);
        set_role(&conn, f, "scratch", 0.7); // < 0.9 threshold
        assert!(list_all_candidates(&conn).unwrap().is_empty());
    }

    #[test]
    fn redundant_backup_with_surviving_origin_is_a_candidate() {
        let conn = migrated_conn();
        let bk = add_file(&conn, 1, "/root/Backup/notes.txt", 1000);
        let org = add_file(&conn, 2, "/root/Active/notes.txt", 1000);
        set_role(&conn, bk, "backup", 0.85);
        assert_relation(
            &conn,
            &NewRelation {
                subject_id: bk,
                predicate: predicates::BACKUP_OF,
                object_id: org,
                source: "user",
                confidence: 1.0,
            },
        )
        .unwrap();

        let cands = list_all_candidates(&conn).unwrap();
        assert_eq!(cands.len(), 1);
        assert_eq!(cands[0].reason, "redundant-backup");
    }

    #[test]
    fn backup_is_protected_when_origin_is_deleted() {
        // Verification scenario V3: once the origin is gone, the backup must NOT
        // be a candidate (the only-copy case).
        let conn = migrated_conn();
        let bk = add_file(&conn, 1, "/root/Backup/notes.txt", 1000);
        let org = add_file(&conn, 2, "/root/Active/notes.txt", 1000);
        set_role(&conn, bk, "backup", 0.85);
        assert_relation(
            &conn,
            &NewRelation {
                subject_id: bk,
                predicate: predicates::BACKUP_OF,
                object_id: org,
                source: "user",
                confidence: 1.0,
            },
        )
        .unwrap();
        // Mark the origin as deleted-from-disk.
        conn.execute("UPDATE files SET deleted_at = 1 WHERE id = 2", [])
            .unwrap();

        let cands = list_all_candidates(&conn).unwrap();
        assert!(
            cands.is_empty(),
            "backup must be protected once its origin is gone"
        );
    }

    #[test]
    fn filter_candidates_applies_reasons_size_and_prefix() {
        let all = vec![
            CleanupCandidate { file_id: 1, entity_id: 1, path: "/a/x.js".into(), size: 100, reason: "scratch".into() },
            CleanupCandidate { file_id: 2, entity_id: 2, path: "/b/y.png".into(), size: 9_000, reason: "safe-derivative".into() },
            CleanupCandidate { file_id: 3, entity_id: 3, path: "/a/z.js".into(), size: 50, reason: "scratch".into() },
        ];

        let only_scratch = filter_candidates(all.clone(), &["scratch".to_string()], None, None);
        assert_eq!(only_scratch.len(), 2);

        let capped = filter_candidates(all.clone(), &[], Some(99), None);
        assert_eq!(capped.len(), 1);
        assert_eq!(capped[0].file_id, 3);

        let under_a = filter_candidates(all, &[], None, Some("/a/"));
        assert_eq!(under_a.len(), 2);
    }

    #[test]
    fn path_prefix_respects_separator_boundaries() {
        // Staging one file must never sweep a same-stem sibling (report.txt vs report.txt.bak),
        // and scoping to a folder must never catch a sibling sharing its name prefix (proj/project).
        let all = vec![
            CleanupCandidate { file_id: 1, entity_id: 1, path: r"D:\x\report.txt".into(), size: 10, reason: "scratch".into() },
            CleanupCandidate { file_id: 2, entity_id: 2, path: r"D:\x\report.txt.bak".into(), size: 10, reason: "scratch".into() },
            CleanupCandidate { file_id: 3, entity_id: 3, path: r"D:\proj\a.js".into(), size: 10, reason: "scratch".into() },
            CleanupCandidate { file_id: 4, entity_id: 4, path: r"D:\project\b.js".into(), size: 10, reason: "scratch".into() },
        ];

        let just_report = filter_candidates(all.clone(), &[], None, Some(r"D:\x\report.txt"));
        assert_eq!(just_report.len(), 1, "report.txt must not drag in report.txt.bak");
        assert_eq!(just_report[0].file_id, 1);

        let under_proj = filter_candidates(all, &[], None, Some(r"D:\proj"));
        assert_eq!(under_proj.len(), 1, "folder proj must not catch sibling project");
        assert_eq!(under_proj[0].file_id, 3);
    }
}
