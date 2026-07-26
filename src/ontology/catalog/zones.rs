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
pub fn is_in_zone(path: &str, zones: &[String]) -> bool {
    zones.iter().any(|zone| {
        let zone = zone.trim_end_matches(['\\', '/']);
        if path.len() == zone.len() {
            return path.eq_ignore_ascii_case(zone);
        }
        path.len() > zone.len()
            && path[..zone.len()].eq_ignore_ascii_case(zone)
            && matches!(path.as_bytes()[zone.len()], b'\\' | b'/')
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
}
