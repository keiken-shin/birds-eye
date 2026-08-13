//! Inbox-zone resolution.
//!
//! Cataloging only ever proposes moves for files sitting in an "inbox" — the
//! places downloads and stray files accumulate. Everything else is left alone,
//! because V1 has no folder-coherence classification to protect a real project.

use crate::ontology::OntologyError;
use rusqlite::Connection;

/// `C:\`, `D:` — a volume root, not a folder on one.
pub fn is_drive_root(path: &str) -> bool {
    let trimmed = path.trim_end_matches(['\\', '/']);
    trimmed.len() == 2 && trimmed.ends_with(':') && trimmed.starts_with(|c: char| c.is_ascii_alphabetic())
}

/// True when `path` is the zone itself or lives underneath it. Prefix matching
/// alone would put `DownloadsOld` inside `Downloads`, so a separator boundary is
/// required.
///
/// Depth is asymmetric by design: a drive-root zone (e.g. `D:\`) means "files
/// dumped loose at the root of the drive", so it matches only the root itself
/// or a *direct* child (`D:\installer.exe`), never anything nested further down
/// — otherwise the entire drive would count as one giant inbox. Every other
/// zone (Downloads, Desktop, ...) matches at any depth, because a subfolder of
/// Downloads is still Downloads.
///
/// Comparisons are done on byte slices rather than `str` indices, so a zone
/// whose byte length happens to land mid-character in a non-ASCII `path`
/// cannot panic on a char-boundary violation.
pub fn is_in_zone(path: &str, zones: &[String]) -> bool {
    let path = path.as_bytes();
    zones.iter().any(|zone| {
        let zone_str = zone.trim_end_matches(['\\', '/']);
        let zone = zone_str.as_bytes();

        if path.len() == zone.len() {
            return path.eq_ignore_ascii_case(zone);
        }
        if path.len() < zone.len()
            || !path[..zone.len()].eq_ignore_ascii_case(zone)
            || !matches!(path[zone.len()], b'\\' | b'/')
        {
            return false;
        }

        if is_drive_root(zone_str) {
            // Direct child only: no further separator past the zone prefix.
            let remainder = &path[zone.len() + 1..];
            !remainder.contains(&b'\\') && !remainder.contains(&b'/')
        } else {
            true
        }
    })
}

/// Which zone this **folder** sits in, if any.
///
/// `is_in_zone` answers the question for a *file* path: under a drive-root zone it matches a
/// direct child, because `D:\installer.exe` really is loose at the root of D:. Handed a *folder*
/// path, that same rule admits `D:\Projects` — and since candidacy is decided per folder, every
/// file directly inside a folder the user deliberately made then becomes a relocation candidate.
///
/// A drive-root zone means "files dumped loose at the root of the drive". For folders that is the
/// root folder and nothing else. Every other zone (Downloads, Desktop) still nests, because a
/// subfolder of Downloads is still Downloads.
pub fn zone_for_folder<'z>(path: &str, zones: &'z [String]) -> Option<&'z String> {
    zones.iter().find(|zone| {
        let trimmed = zone.trim_end_matches(['\\', '/']);
        if is_drive_root(trimmed) {
            return path.trim_end_matches(['\\', '/']).eq_ignore_ascii_case(trimmed);
        }
        is_in_zone(path, std::slice::from_ref(*zone))
    })
}

/// The zones for this index: the user's Downloads and Desktop, plus any drive
/// root that is actually a scan root in this index.
///
/// Known limitation: Downloads and Desktop are resolved as `%USERPROFILE%\<name>`
/// rather than through `SHGetKnownFolderPath`, so a user who has relocated those
/// folders gets no candidates from them.
pub fn inbox_zones(conn: &Connection) -> Result<Vec<String>, OntologyError> {
    let mut zones = Vec::new();

    if let Some(home) = home_dir() {
        let home = home.trim_end_matches(['\\', '/']).to_string();
        zones.push(format!("{home}\\Downloads"));
        zones.push(format!("{home}\\Desktop"));
    }

    let mut stmt = conn.prepare("SELECT path FROM folders WHERE parent_id IS NULL")?;
    let roots = stmt.query_map([], |row| row.get::<_, String>(0))?;
    for root in roots {
        let root = root?;
        if is_drive_root(&root) {
            zones.push(root);
        }
    }

    Ok(zones)
}

fn home_dir() -> Option<String> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .filter(|value| !value.is_empty())
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

    /// A drive-root zone is an inbox for files dumped at the root, never a licence to relocate
    /// the contents of folders the user built. `is_in_zone` says yes to `D:\Projects` because its
    /// direct-child rule is written for file paths; candidacy is decided per *folder*, so that
    /// answer would make every file in `D:\Projects` movable.
    #[test]
    fn a_drive_root_zone_holds_loose_files_not_the_folders_beside_them() {
        let drive = vec!["D:\\".to_string()];

        // The file-path question and the folder-path question have different answers here.
        assert!(is_in_zone("D:\\Projects", &drive));
        assert!(zone_for_folder("D:\\Projects", &drive).is_none());
        assert!(zone_for_folder("D:\\Projects\\webshop", &drive).is_none());

        // The drive root itself is still the inbox, so loose files keep their suggestions.
        assert!(zone_for_folder("D:\\", &drive).is_some());

        // Every other zone still nests — a subfolder of Downloads is still Downloads.
        let downloads = vec!["C:\\Users\\a\\Downloads".to_string()];
        assert!(zone_for_folder("C:\\Users\\a\\Downloads", &downloads).is_some());
        assert!(zone_for_folder("C:\\Users\\a\\Downloads\\tax-2024", &downloads).is_some());
    }

    /// The blast radius of the folder rule, pinned. For every zone that is not a drive root,
    /// `zone_for_folder` must answer exactly what `is_in_zone` answers, so moving a call site
    /// from one to the other can only ever change behaviour on an index where a drive root is a
    /// scan root. Destination selection in `infer.rs` leans on this: an ordinary
    /// Downloads/Desktop setup is unaffected, bit for bit.
    #[test]
    fn the_two_predicates_only_diverge_on_a_drive_root_zone() {
        let zones = vec![
            "C:\\Users\\a\\Downloads".to_string(),
            "C:\\Users\\a\\Desktop".to_string(),
        ];
        for path in [
            "C:\\Users\\a\\Downloads",
            "C:\\Users\\a\\Downloads\\tax-2024",
            "C:\\Users\\a\\Downloads\\tax-2024\\receipts",
            "C:\\Users\\a\\Desktop",
            "C:\\Users\\a\\DownloadsOld",
            "C:\\Users\\a",
            "C:\\",
            "D:\\Projects",
        ] {
            assert_eq!(
                zone_for_folder(path, &zones).is_some(),
                is_in_zone(path, &zones),
                "{path}: a non-drive-root zone must answer the same either way"
            );
        }

        // The drive root is the one place they part company — the whole point of the split.
        let drive = vec!["D:\\".to_string()];
        assert!(is_in_zone("D:\\Projects", &drive));
        assert!(zone_for_folder("D:\\Projects", &drive).is_none());
    }

    #[test]
    fn recognises_drive_roots_only() {
        assert!(is_drive_root("C:\\"));
        assert!(is_drive_root("D:"));
        assert!(!is_drive_root("D:\\Projects"));
        assert!(!is_drive_root("C:\\Users\\a\\Downloads"));
    }

    #[test]
    fn zone_membership_needs_a_separator_boundary() {
        let zones = vec!["C:\\Users\\a\\Downloads".to_string()];
        assert!(is_in_zone("C:\\Users\\a\\Downloads\\x.exe", &zones));
        assert!(is_in_zone("C:\\Users\\a\\Downloads", &zones));
        // A sibling folder that merely shares the prefix is NOT in the zone.
        assert!(!is_in_zone("C:\\Users\\a\\DownloadsOld\\x.exe", &zones));
    }

    #[test]
    fn indexed_drive_root_becomes_a_zone_but_a_deep_scan_root_does_not() {
        let conn = migrated_conn();
        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
             VALUES (1, NULL, 'D:\\', 'D:', 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
             VALUES (2, NULL, 'D:\\Projects', 'Projects', 0, 0)",
            [],
        )
        .unwrap();
        let zones = inbox_zones(&conn).unwrap();
        assert!(zones.iter().any(|z| z == "D:\\"), "drive root is a zone: {zones:?}");
        assert!(
            !zones.iter().any(|z| z == "D:\\Projects"),
            "a deep scan root is not a drive root: {zones:?}"
        );
    }

    #[test]
    fn non_ascii_paths_do_not_panic() {
        // The exact case that used to panic: a zone byte length ("C:\ab", 5 bytes)
        // that lands mid-character in a non-ASCII path ('日' is 3 bytes, occupying
        // path bytes 3..6 of "C:\日x").
        let zones = vec!["C:\\ab".to_string()];
        assert!(!is_in_zone("C:\\日x", &zones));

        // Non-ASCII folder names still compare correctly when they do match.
        let zones = vec!["C:\\日".to_string()];
        assert!(is_in_zone("C:\\日", &zones));
        assert!(is_in_zone("C:\\日\\x.txt", &zones));
        // A sibling that merely shares the byte prefix is still excluded.
        assert!(!is_in_zone("C:\\日ese\\x.txt", &zones));
    }

    #[test]
    fn drive_root_zone_only_matches_root_and_direct_children() {
        let zones = vec!["D:\\".to_string()];
        assert!(is_in_zone("D:\\", &zones));
        assert!(is_in_zone("D:\\loose.exe", &zones));
        assert!(!is_in_zone("D:\\Projects\\x.txt", &zones));
    }

    #[test]
    fn non_drive_root_zone_matches_any_depth() {
        let zones = vec!["C:\\Users\\a\\Downloads".to_string()];
        assert!(is_in_zone("C:\\Users\\a\\Downloads\\sub\\x.pdf", &zones));
    }

    #[test]
    fn trailing_separator_on_zone_behaves_like_no_trailing_separator() {
        // Drive root, with and without a trailing separator.
        assert!(is_in_zone("D:\\loose.exe", &["D:\\".to_string()]));
        assert!(is_in_zone("D:\\loose.exe", &["D:".to_string()]));
        assert!(!is_in_zone("D:\\Projects\\x.txt", &["D:\\".to_string()]));
        assert!(!is_in_zone("D:\\Projects\\x.txt", &["D:".to_string()]));

        // A regular zone, with and without a trailing separator.
        let path = "C:\\Users\\a\\Downloads\\x.exe";
        assert!(is_in_zone(path, &["C:\\Users\\a\\Downloads".to_string()]));
        assert!(is_in_zone(path, &["C:\\Users\\a\\Downloads\\".to_string()]));
    }
}
