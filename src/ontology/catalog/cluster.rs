//! Candidate selection and clustering.

use crate::ontology::catalog::zones::is_in_zone;
use crate::ontology::OntologyError;
use rusqlite::Connection;
use std::collections::HashMap;

/// Roles that mean "this file belongs to something" — a checked-out repo or a
/// build directory sitting in Downloads is protected by its files' roles, since
/// V1 has no folder-coherence classification.
const PROTECTED_ROLES: [&str; 4] = ["system", "scratch", "source", "asset"];

#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub file_id: i64,
    pub path: String,
    pub name: String,
    pub size: i64,
    pub media_kind: String,
    pub zone: String,
}

/// Every live file inside an inbox zone that carries no protective role.
///
/// Resolves zones through `folders` first — there are orders of magnitude fewer
/// folders than files, so this never loads a 500k-row `files` table into memory
/// just to discard almost all of it.
pub fn candidates(conn: &Connection, zones: &[String]) -> Result<Vec<Candidate>, OntologyError> {
    if zones.is_empty() {
        return Ok(Vec::new());
    }

    // (folder_id, owning zone) for every indexed folder inside a zone.
    let mut zone_folders: Vec<(i64, String)> = Vec::new();
    {
        let mut stmt = conn.prepare("SELECT id, path FROM folders")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (id, path) = row?;
            if let Some(zone) = zones
                .iter()
                .find(|zone| is_in_zone(&path, std::slice::from_ref(*zone)))
            {
                zone_folders.push((id, zone.clone()));
            }
        }
    }
    if zone_folders.is_empty() {
        return Ok(Vec::new());
    }

    let zone_of: HashMap<i64, String> = zone_folders.iter().cloned().collect();
    let placeholders = std::iter::repeat("?")
        .take(zone_folders.len())
        .collect::<Vec<_>>()
        .join(",");
    let protected_roles = PROTECTED_ROLES
        .iter()
        .map(|role| format!("'{role}'"))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT f.id, f.folder_id, f.path, f.name, f.size, COALESCE(f.media_kind, 'other')
         FROM files f
         WHERE f.deleted_at IS NULL
           AND f.folder_id IN ({placeholders})
           AND NOT EXISTS (
             SELECT 1
             FROM ontology_entities e
             JOIN ontology_attrs a ON a.entity_id = e.id
             WHERE e.linked_file_id = f.id
               AND a.key = 'role'
               AND a.value IN ({protected_roles})
           )
         ORDER BY f.id ASC"
    );

    let ids: Vec<i64> = zone_folders.iter().map(|(id, _)| *id).collect();
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(ids), |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, String>(5)?,
        ))
    })?;

    let mut out = Vec::new();
    for row in rows {
        let (file_id, folder_id, path, name, size, media_kind) = row?;
        let Some(zone) = zone_of.get(&folder_id) else {
            continue;
        };
        out.push(Candidate {
            file_id,
            path,
            name,
            size,
            media_kind,
            zone: zone.clone(),
        });
    }
    Ok(out)
}

/// `media_kind` is a nine-value extension whitelist, so `.psd`, `.svg`, `.iso`
/// and extensionless files all land in `other`. Name patterns carry the real
/// discrimination.
pub fn refine_kind(media_kind: &str, name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    let refined = match media_kind {
        "photo" if lower.starts_with("screenshot") || lower.starts_with("screen shot") => {
            Some("screenshot")
        }
        "photo" if lower.starts_with("img_") || lower.starts_with("dsc_") || lower.starts_with("dscf") => {
            Some("camera-photo")
        }
        "document" if lower.contains("invoice") || lower.contains("receipt") => Some("invoice"),
        "document" if lower.contains("resume") || lower.contains("cv-") => Some("resume"),
        _ => None,
    };
    refined.unwrap_or(media_kind).to_string()
}

/// One cluster per (zone, refined kind). Returned sorted by size descending so
/// the biggest wins are emitted first.
pub fn cluster(candidates: Vec<Candidate>) -> Vec<(String, String, Vec<Candidate>)> {
    let mut groups: HashMap<(String, String), Vec<Candidate>> = HashMap::new();
    for candidate in candidates {
        let kind = refine_kind(&candidate.media_kind, &candidate.name);
        groups
            .entry((candidate.zone.clone(), kind))
            .or_default()
            .push(candidate);
    }

    let mut out: Vec<(String, String, Vec<Candidate>)> = groups
        .into_iter()
        .map(|((zone, kind), members)| (zone, kind, members))
        .collect();
    out.sort_by(|a, b| b.2.len().cmp(&a.2.len()).then_with(|| a.1.cmp(&b.1)));
    out
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
        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
             VALUES (1, NULL, 'C:\\Inbox', 'Inbox', 0, 0)",
            [],
        )
        .unwrap();
        conn
    }

    fn add_file(conn: &Connection, id: i64, name: &str, kind: &str, size: i64) {
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, size, media_kind, indexed_at)
             VALUES (?1, 1, ?2, ?3, ?4, ?5, 0)",
            rusqlite::params![id, format!("C:\\Inbox\\{name}"), name, size, kind],
        )
        .unwrap();
    }

    fn add_role(conn: &Connection, file_id: i64, path: &str, role: &str) {
        conn.execute(
            "INSERT INTO ontology_entities (kind, canonical_id, linked_file_id, created_at)
             VALUES ('File', ?1, ?2, 0)",
            rusqlite::params![path, file_id],
        )
        .unwrap();
        let eid = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO ontology_attrs
                (entity_id, key, value, source, confidence, asserted_at, vocabulary_version, display_in_global_views)
             VALUES (?1, 'role', ?2, 'rule:test', 0.95, 0, 1, 1)",
            rusqlite::params![eid, role],
        )
        .unwrap();
    }

    #[test]
    fn only_files_inside_a_zone_are_candidates() {
        let conn = migrated_conn();
        add_file(&conn, 1, "setup.exe", "installer", 100);
        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
             VALUES (2, NULL, 'D:\\Work', 'Work', 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, size, media_kind, indexed_at)
             VALUES (2, 2, 'D:\\Work\\report.pdf', 'report.pdf', 50, 'document', 0)",
            [],
        )
        .unwrap();

        let zones = vec!["C:\\Inbox".to_string()];
        let found = candidates(&conn, &zones).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].file_id, 1);
    }

    #[test]
    fn protected_roles_are_excluded() {
        let conn = migrated_conn();
        for (id, name, role) in [
            (1_i64, "a.rs", Some("source")),
            (2, "b.dll", Some("system")),
            (3, "c.tmp", Some("scratch")),
            (4, "d.png", Some("asset")),
            (5, "keep.pdf", None),
        ] {
            add_file(&conn, id, name, "document", 10);
            if let Some(role) = role {
                add_role(&conn, id, &format!("C:\\Inbox\\{name}"), role);
            }
        }

        let found = candidates(&conn, &["C:\\Inbox".to_string()]).unwrap();
        assert_eq!(found.len(), 1, "only the unroled file survives: {found:?}");
        assert_eq!(found[0].name, "keep.pdf");
    }

    #[test]
    fn deleted_files_are_never_candidates() {
        let conn = migrated_conn();
        add_file(&conn, 1, "gone.exe", "installer", 100);
        conn.execute("UPDATE files SET deleted_at = 1 WHERE id = 1", []).unwrap();
        assert!(candidates(&conn, &["C:\\Inbox".to_string()]).unwrap().is_empty());
    }

    #[test]
    fn name_patterns_refine_the_coarse_media_kind() {
        assert_eq!(refine_kind("photo", "Screenshot 2026-01-02 101112.png"), "screenshot");
        assert_eq!(refine_kind("photo", "IMG_4821.JPG"), "camera-photo");
        assert_eq!(refine_kind("photo", "DSC_0001.jpg"), "camera-photo");
        assert_eq!(refine_kind("document", "invoice-jan.pdf"), "invoice");
        assert_eq!(refine_kind("document", "Receipt_2026.pdf"), "invoice");
        assert_eq!(refine_kind("document", "my-resume.docx"), "resume");
        // Nothing matched: the coarse kind stands.
        assert_eq!(refine_kind("document", "notes.md"), "document");
        assert_eq!(refine_kind("other", "thing.psd"), "other");
    }

    #[test]
    fn clusters_group_by_zone_and_refined_kind() {
        let make = |id: i64, name: &str, kind: &str| Candidate {
            file_id: id,
            path: format!("C:\\Inbox\\{name}"),
            name: name.to_string(),
            size: 10,
            media_kind: kind.to_string(),
            zone: "C:\\Inbox".to_string(),
        };
        let clusters = cluster(vec![
            make(1, "a.exe", "installer"),
            make(2, "b.exe", "installer"),
            make(3, "invoice-a.pdf", "document"),
            make(4, "notes.md", "document"),
        ]);

        let mut sizes: Vec<(String, usize)> = clusters
            .iter()
            .map(|(_, kind, members)| (kind.clone(), members.len()))
            .collect();
        sizes.sort();
        assert_eq!(
            sizes,
            vec![
                ("document".to_string(), 1),
                ("installer".to_string(), 2),
                ("invoice".to_string(), 1),
            ]
        );
    }
}
