//! Candidate selection and clustering.

use crate::ontology::catalog::infer::{MIN_LEARNED_FILES, MIN_LEARNED_SHARE};
use crate::ontology::catalog::zones::zone_for_folder;
use crate::ontology::OntologyError;
use rusqlite::Connection;
use std::collections::{HashMap, HashSet};

/// Roles that mean "this file belongs to something" — a checked-out repo or a
/// build directory sitting in Downloads is protected by its files' roles.
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

/// One indexed folder sitting inside an inbox zone.
struct ZoneFolder {
    id: i64,
    parent_id: Option<i64>,
    /// True when this folder *is* the zone (e.g. Downloads itself).
    is_zone_root: bool,
    zone: String,
}

/// Every live file inside an inbox zone that carries no protective role and does
/// not sit under a folder that already looks settled.
///
/// Resolves zones through `folders` first — there are orders of magnitude fewer
/// folders than files, so this never loads a 500k-row `files` table into memory
/// just to discard almost all of it.
pub fn candidates(conn: &Connection, zones: &[String]) -> Result<Vec<Candidate>, OntologyError> {
    if zones.is_empty() {
        return Ok(Vec::new());
    }

    // Every indexed folder inside a zone, with the tree links needed to ask
    // "is anything above me settled?".
    let mut zone_folders: Vec<ZoneFolder> = Vec::new();
    {
        let mut stmt = conn.prepare("SELECT id, parent_id, path FROM folders")?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        for row in rows {
            let (id, parent_id, path) = row?;
            // Folder semantics, not file semantics: under a `D:\` zone this is the difference
            // between "files loose at the root of D:" and "everything in D:\Projects".
            if let Some(zone) = zone_for_folder(&path, zones) {
                zone_folders.push(ZoneFolder {
                    id,
                    parent_id,
                    is_zone_root: same_folder(&path, zone),
                    zone: zone.clone(),
                });
            }
        }
    }
    if zone_folders.is_empty() {
        return Ok(Vec::new());
    }

    let left_alone = settled_subtrees(conn, &zone_folders)?;
    let zone_of: HashMap<i64, String> = zone_folders
        .iter()
        .filter(|folder| !left_alone.contains(&folder.id))
        .map(|folder| (folder.id, folder.zone.clone()))
        .collect();
    if zone_of.is_empty() {
        return Ok(Vec::new());
    }

    let placeholders = std::iter::repeat_n("?", zone_of.len())
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

    let ids: Vec<i64> = zone_of.keys().copied().collect();
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

/// Same folder, ignoring a trailing separator and ASCII case.
fn same_folder(path: &str, zone: &str) -> bool {
    path.trim_end_matches(['\\', '/'])
        .eq_ignore_ascii_case(zone.trim_end_matches(['\\', '/']))
}

/// Folder ids to leave alone: every folder that looks settled, plus everything
/// beneath it.
///
/// A folder is settled when it holds at least `MIN_LEARNED_FILES` live files and
/// at least `MIN_LEARNED_SHARE` of them are one `media_kind`. Those are
/// `infer::learned_home`'s own two constants on purpose — a folder that would be
/// good enough to *adopt* as a destination outside a zone should not be
/// dismantled just because it happens to sit inside one. Ten files is more than
/// a handful (three PDFs in Downloads is an accident; thirty is a filing
/// decision) and 60% tolerates the stray README or cover image without letting a
/// mixed dumping ground through.
///
/// Two deliberate asymmetries:
///
/// - **The zone root can never be settled.** Downloads full of PDFs *is* the
///   problem, not evidence of intent; letting it protect itself would switch the
///   whole engine off.
/// - **Every live file counts, including role-protected ones.** Coherence is a
///   property of the folder, not of the candidate set, so a stray invoice among
///   thirty source files rides along with them.
///
/// This only ever shrinks the candidate set. The worst outcome is a suggestion
/// that never appears.
fn settled_subtrees(
    conn: &Connection,
    zone_folders: &[ZoneFolder],
) -> Result<HashSet<i64>, OntologyError> {
    let placeholders = std::iter::repeat_n("?", zone_folders.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT folder_id, COALESCE(media_kind, 'other') AS k, COUNT(*)
         FROM files
         WHERE deleted_at IS NULL AND folder_id IN ({placeholders})
         GROUP BY folder_id, k"
    );
    let ids: Vec<i64> = zone_folders.iter().map(|folder| folder.id).collect();
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(ids), |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(2)?))
    })?;

    // folder id -> (files, biggest single kind)
    let mut tally: HashMap<i64, (i64, i64)> = HashMap::new();
    for row in rows {
        let (folder_id, count) = row?;
        let entry = tally.entry(folder_id).or_insert((0, 0));
        entry.0 += count;
        entry.1 = entry.1.max(count);
    }

    let roots: HashSet<i64> = zone_folders
        .iter()
        .filter(|folder| folder.is_zone_root)
        .map(|folder| folder.id)
        .collect();
    let settled: HashSet<i64> = tally
        .into_iter()
        .filter(|(id, (total, top))| {
            !roots.contains(id)
                && *total >= MIN_LEARNED_FILES
                && *top as f64 / *total as f64 >= MIN_LEARNED_SHARE
        })
        .map(|(id, _)| id)
        .collect();
    if settled.is_empty() {
        return Ok(settled);
    }

    // Walk up `parent_id` rather than matching path prefixes, so a sibling named
    // `tax-2024-old` can never be swallowed by `tax-2024`. The chain leaves the
    // map (and stops) as soon as it passes the zone root.
    let parent_of: HashMap<i64, Option<i64>> = zone_folders
        .iter()
        .map(|folder| (folder.id, folder.parent_id))
        .collect();
    let mut out = HashSet::new();
    for folder in zone_folders {
        let mut cursor = Some(folder.id);
        // A parent_id cycle in a corrupt index must not hang the scan.
        for _ in 0..=zone_folders.len() {
            let Some(id) = cursor else { break };
            if settled.contains(&id) {
                out.insert(folder.id);
                break;
            }
            cursor = parent_of.get(&id).copied().flatten();
        }
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
    out.sort_by(|a, b| {
        b.2.len()
            .cmp(&a.2.len())
            .then_with(|| a.1.cmp(&b.1))
            .then_with(|| a.0.cmp(&b.0))
    });
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

    fn add_folder(conn: &Connection, id: i64, parent_id: i64, path: &str) {
        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
             VALUES (?1, ?2, ?3, ?3, 1, 0)",
            rusqlite::params![id, parent_id, path],
        )
        .unwrap();
    }

    /// `n` files of one kind in `folder_id`. Ids double as unique names, since
    /// `files.path` is UNIQUE.
    fn fill(conn: &Connection, folder_id: i64, first_id: i64, n: i64, kind: &str, dir: &str) {
        for id in first_id..first_id + n {
            let name = format!("f{id}.dat");
            conn.execute(
                "INSERT INTO files (id, folder_id, path, name, size, media_kind, indexed_at)
                 VALUES (?1, ?2, ?3, ?4, 10, ?5, 0)",
                rusqlite::params![id, folder_id, format!("{dir}\\{name}"), name, kind],
            )
            .unwrap();
        }
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

    #[test]
    fn cluster_order_is_deterministic_and_total() {
        let make = |id: i64, name: &str, kind: &str, zone: &str| Candidate {
            file_id: id,
            path: format!("{zone}\\{name}"),
            name: name.to_string(),
            size: 10,
            media_kind: kind.to_string(),
            zone: zone.to_string(),
        };

        // Two zones each produce a 3-member "screenshot" cluster (ties on both
        // size and refined kind — the exact collision `inbox_zones()` hits every
        // time, since it always returns Downloads and Desktop). A same-size
        // "camera-photo" cluster and a smaller "document" cluster round it out so
        // all three sort levels (size desc, kind asc, zone asc) get exercised.
        let fresh_input = || {
            vec![
                make(1, "Screenshot 1.png", "photo", "C:\\Downloads"),
                make(2, "Screenshot 2.png", "photo", "C:\\Downloads"),
                make(3, "Screenshot 3.png", "photo", "C:\\Downloads"),
                make(4, "Screenshot 4.png", "photo", "C:\\Desktop"),
                make(5, "Screenshot 5.png", "photo", "C:\\Desktop"),
                make(6, "Screenshot 6.png", "photo", "C:\\Desktop"),
                make(7, "IMG_1.jpg", "photo", "C:\\Desktop"),
                make(8, "IMG_2.jpg", "photo", "C:\\Desktop"),
                make(9, "IMG_3.jpg", "photo", "C:\\Desktop"),
                make(10, "notes1.md", "document", "C:\\Downloads"),
                make(11, "notes2.md", "document", "C:\\Downloads"),
            ]
        };

        let expected = vec![
            ("C:\\Desktop".to_string(), "camera-photo".to_string()),
            ("C:\\Desktop".to_string(), "screenshot".to_string()),
            ("C:\\Downloads".to_string(), "screenshot".to_string()),
            ("C:\\Downloads".to_string(), "document".to_string()),
        ];

        for _ in 0..5 {
            // Fresh input each time so a fresh HashMap (and its randomized
            // iteration order) is built underneath `cluster()`.
            let clusters = cluster(fresh_input());
            let order: Vec<(String, String)> = clusters
                .iter()
                .map(|(zone, kind, _)| (zone.clone(), kind.clone()))
                .collect();
            assert_eq!(order, expected, "cluster() order must be total and stable");
        }
    }

    #[test]
    fn candidates_attribute_the_correct_zone_across_multiple_zones() {
        let conn = migrated_conn(); // folder 1 = 'C:\Inbox'
        add_file(&conn, 1, "inbox-file.txt", "document", 10);

        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
             VALUES (2, NULL, 'D:\\Desktop', 'Desktop', 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, size, media_kind, indexed_at)
             VALUES (2, 2, 'D:\\Desktop\\desktop-file.txt', 'desktop-file.txt', 20, 'document', 0)",
            [],
        )
        .unwrap();

        // A third folder that belongs to neither requested zone.
        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
             VALUES (3, NULL, 'E:\\Projects', 'Projects', 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, size, media_kind, indexed_at)
             VALUES (3, 3, 'E:\\Projects\\outside-file.txt', 'outside-file.txt', 30, 'document', 0)",
            [],
        )
        .unwrap();

        let zones = vec!["C:\\Inbox".to_string(), "D:\\Desktop".to_string()];
        let found = candidates(&conn, &zones).unwrap();

        assert_eq!(found.len(), 2, "the outside folder contributes nothing: {found:?}");
        assert!(!found.iter().any(|c| c.file_id == 3));

        let inbox = found.iter().find(|c| c.file_id == 1).expect("inbox file present");
        assert_eq!(inbox.zone, "C:\\Inbox");
        let desktop = found.iter().find(|c| c.file_id == 2).expect("desktop file present");
        assert_eq!(desktop.zone, "D:\\Desktop");
    }

    /// The drive-root case at the level that actually decides candidacy. `D:\` is a scan root,
    /// so `inbox_zones()` makes it a zone; `is_in_zone` calls the *folder* `D:\Projects` a direct
    /// child of it, which turned every file sitting directly in `D:\Projects` into a relocation
    /// candidate. Three loose documents are too few and too mixed for the settled-folder guard to
    /// catch, so only the folder-vs-file distinction keeps them out.
    #[test]
    fn a_drive_root_zone_never_scatters_the_folders_on_it() {
        let conn = migrated_conn();
        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
             VALUES (10, NULL, 'D:\\', 'D:', 0, 0)",
            [],
        )
        .unwrap();
        add_folder(&conn, 11, 10, "D:\\Projects");
        fill(&conn, 11, 100, 3, "document", "D:\\Projects");
        // Loose at the root: still the inbox, still candidates.
        fill(&conn, 10, 200, 2, "installer", "D:");

        let found = candidates(&conn, &["D:\\".to_string()]).unwrap();
        assert_eq!(found.len(), 2, "only the loose files are candidates: {found:?}");
        assert!(found.iter().all(|c| !c.path.contains("Projects")));
        assert!(found.iter().all(|c| c.zone == "D:\\"));
    }

    const ZONE: &str = "C:\\Inbox";

    fn in_zone(conn: &Connection) -> Vec<Candidate> {
        candidates(conn, &[ZONE.to_string()]).unwrap()
    }

    #[test]
    fn a_settled_folder_inside_a_zone_is_left_alone() {
        // The case the design spec named: Downloads\tax-2024 with thirty PDFs in
        // it, none of them carrying a protective role.
        let conn = migrated_conn(); // folder 1 = the zone itself
        add_folder(&conn, 2, 1, "C:\\Inbox\\tax-2024");
        fill(&conn, 2, 100, 30, "document", "C:\\Inbox\\tax-2024");

        let found = in_zone(&conn);
        assert!(found.is_empty(), "a settled folder must not be scattered: {found:?}");
    }

    #[test]
    fn loose_files_in_the_zone_are_still_proposed() {
        // The zone root can never settle itself, however much lands in it —
        // otherwise a busy Downloads would switch the whole engine off.
        let conn = migrated_conn();
        fill(&conn, 1, 100, 30, "document", ZONE);
        add_folder(&conn, 2, 1, "C:\\Inbox\\tax-2024");
        fill(&conn, 2, 200, 30, "document", "C:\\Inbox\\tax-2024");

        let found = in_zone(&conn);
        assert_eq!(found.len(), 30, "loose files stay candidates: {found:?}");
        assert!(found.iter().all(|c| !c.path.contains("tax-2024")));
    }

    #[test]
    fn a_folder_just_under_the_threshold_is_still_proposed() {
        // Nine files of one kind is not proof of intent. Pins the boundary at
        // MIN_LEARNED_FILES so a retune has to update this test on purpose.
        let conn = migrated_conn();
        add_folder(&conn, 2, 1, "C:\\Inbox\\maybe");
        fill(&conn, 2, 100, MIN_LEARNED_FILES - 1, "document", "C:\\Inbox\\maybe");
        assert_eq!(in_zone(&conn).len() as i64, MIN_LEARNED_FILES - 1);

        // The tenth file settles it.
        fill(&conn, 2, 200, 1, "document", "C:\\Inbox\\maybe");
        assert!(in_zone(&conn).is_empty(), "the threshold file must protect the folder");
    }

    #[test]
    fn a_folder_under_a_settled_parent_is_left_alone_too() {
        let conn = migrated_conn();
        add_folder(&conn, 2, 1, "C:\\Inbox\\tax-2024");
        fill(&conn, 2, 100, 30, "document", "C:\\Inbox\\tax-2024");

        // Too small and too mixed to protect itself; the settled parent covers it.
        add_folder(&conn, 3, 2, "C:\\Inbox\\tax-2024\\receipts");
        fill(&conn, 3, 200, 2, "photo", "C:\\Inbox\\tax-2024\\receipts");
        add_folder(&conn, 4, 3, "C:\\Inbox\\tax-2024\\receipts\\scans");
        fill(&conn, 4, 300, 1, "photo", "C:\\Inbox\\tax-2024\\receipts\\scans");

        // A sibling that merely shares the name prefix is NOT covered — the walk
        // is up parent_id, not along path prefixes.
        add_folder(&conn, 5, 1, "C:\\Inbox\\tax-2024-old");
        fill(&conn, 5, 400, 3, "document", "C:\\Inbox\\tax-2024-old");

        let found = in_zone(&conn);
        assert_eq!(found.len(), 3, "only the prefix-sibling survives: {found:?}");
        assert!(found.iter().all(|c| c.path.contains("tax-2024-old")));
    }

    #[test]
    fn a_mixed_bag_folder_is_still_proposed() {
        // Thirty files over five kinds: plenty of files, no dominant purpose.
        let conn = migrated_conn();
        add_folder(&conn, 2, 1, "C:\\Inbox\\junk");
        for (n, kind) in ["document", "photo", "video", "music", "installer"]
            .iter()
            .enumerate()
        {
            fill(&conn, 2, 100 + n as i64 * 10, 6, kind, "C:\\Inbox\\junk");
        }

        let found = in_zone(&conn);
        assert_eq!(found.len(), 30, "a dumping ground is not a filing decision: {found:?}");
    }

    #[test]
    fn a_file_with_an_unrelated_role_is_still_a_candidate() {
        let conn = migrated_conn();
        add_file(&conn, 1, "keep.pdf", "document", 10);
        add_role(&conn, 1, "C:\\Inbox\\keep.pdf", "backup");

        let found = candidates(&conn, &["C:\\Inbox".to_string()]).unwrap();
        assert_eq!(
            found.len(),
            1,
            "an unprotected role must not disqualify the file: {found:?}"
        );
        assert_eq!(found[0].name, "keep.pdf");
    }
}
