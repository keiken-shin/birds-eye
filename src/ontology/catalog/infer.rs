//! Destination inference: user rule, then learned home, then template.

use crate::ontology::catalog::rules::{list_rules, matches};
use crate::ontology::catalog::zones::is_in_zone;
use crate::ontology::OntologyError;
use rusqlite::Connection;

/// A learned home must hold at least this many same-kind files.
const MIN_LEARNED_FILES: i64 = 10;
/// ...and at least this share of them, counted outside the inbox zones.
const MIN_LEARNED_SHARE: f64 = 0.60;

#[derive(Debug, Clone, PartialEq)]
pub struct Destination {
    pub path: String,
    /// "rule" | "learned" | "template"
    pub source: &'static str,
    pub reason: String,
    pub confidence: f32,
}

pub fn infer(
    conn: &Connection,
    zones: &[String],
    zone: &str,
    kind: &str,
    sample_name: &str,
    media_kind: &str,
) -> Result<Option<Destination>, OntologyError> {
    for rule in list_rules(conn)? {
        if matches(&rule, zone, kind, sample_name) {
            return Ok(Some(Destination {
                path: rule.destination.clone(),
                source: "rule",
                reason: format!("your rule \"{}\" sends these here", rule.name),
                confidence: 0.99,
            }));
        }
    }

    if let Some(learned) = learned_home(conn, zones, media_kind)? {
        return Ok(Some(learned));
    }

    Ok(template_for(kind, media_kind))
}

/// The folder outside every inbox zone already holding the dominant share of
/// this `media_kind`. The denominator is same-kind files OUTSIDE the zones —
/// for a downloads-heavy user, counting the inbox in the denominator would
/// suppress the very suggestion we want.
fn learned_home(
    conn: &Connection,
    zones: &[String],
    media_kind: &str,
) -> Result<Option<Destination>, OntologyError> {
    let mut stmt = conn.prepare(
        "SELECT fo.path, COUNT(*) AS n
         FROM files f
         JOIN folders fo ON fo.id = f.folder_id
         WHERE f.deleted_at IS NULL AND f.media_kind = ?1
         GROUP BY f.folder_id
         ORDER BY n DESC",
    )?;
    let rows = stmt.query_map([media_kind], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;

    let mut outside: Vec<(String, i64)> = Vec::new();
    for row in rows {
        let (path, count) = row?;
        if !is_in_zone(&path, zones) {
            outside.push((path, count));
        }
    }

    let total: i64 = outside.iter().map(|(_, n)| *n).sum();
    if total == 0 {
        return Ok(None);
    }
    let Some((path, count)) = outside.into_iter().max_by_key(|(_, n)| *n) else {
        return Ok(None);
    };
    if count < MIN_LEARNED_FILES {
        return Ok(None);
    }
    let share = count as f64 / total as f64;
    if share < MIN_LEARNED_SHARE {
        return Ok(None);
    }

    Ok(Some(Destination {
        path,
        source: "learned",
        reason: format!(
            "{:.0}% of your {media_kind} files already live here",
            share * 100.0
        ),
        confidence: (0.6 + share as f32 * 0.35).min(0.95),
    }))
}

/// Cold-start conventions, relative to the user's home. Returns None when there
/// is no sensible convention for the kind — an unclassifiable pile is left alone
/// rather than swept somewhere arbitrary.
fn template_for(kind: &str, media_kind: &str) -> Option<Destination> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .filter(|value| !value.is_empty())?;
    let home = home.trim_end_matches(['\\', '/']).to_string();

    let (suffix, why) = match (kind, media_kind) {
        ("screenshot", _) => ("Pictures\\Screenshots", "screenshots usually belong together"),
        ("camera-photo", _) => ("Pictures\\Camera", "camera files usually belong together"),
        ("invoice", _) => ("Documents\\Invoices", "invoices usually belong together"),
        ("resume", _) => ("Documents\\Resume", "resumes usually belong together"),
        (_, "installer") => ("Downloads\\Installers", "installers pile up in one place"),
        (_, "photo") => ("Pictures", "the conventional home for photos"),
        (_, "video") => ("Videos", "the conventional home for video"),
        (_, "music") => ("Music", "the conventional home for audio"),
        (_, "document") => ("Documents", "the conventional home for documents"),
        _ => return None,
    };

    Some(Destination {
        path: format!("{home}\\{suffix}"),
        source: "template",
        reason: why.to_string(),
        confidence: 0.5,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::schema::ALL_MIGRATIONS;
    use crate::ontology::catalog::rules::{create_rule, NewCatalogRule, RuleCriteria};
    use rusqlite::Connection;

    fn migrated_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        for (_, sql) in ALL_MIGRATIONS {
            conn.execute_batch(sql).unwrap();
        }
        conn
    }

    fn add_folder(conn: &Connection, id: i64, path: &str) {
        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
             VALUES (?1, NULL, ?2, 'f', 0, 0)",
            rusqlite::params![id, path],
        )
        .unwrap();
    }

    fn add_files(conn: &Connection, folder_id: i64, folder_path: &str, kind: &str, count: i64, base: i64) {
        for n in 0..count {
            let id = base + n;
            conn.execute(
                "INSERT INTO files (id, folder_id, path, name, size, media_kind, indexed_at)
                 VALUES (?1, ?2, ?3, 'f.bin', 10, ?4, 0)",
                rusqlite::params![id, folder_id, format!("{folder_path}\\f{id}.bin"), kind],
            )
            .unwrap();
        }
    }

    #[test]
    fn a_user_rule_outranks_a_learned_home() {
        let conn = migrated_conn();
        add_folder(&conn, 1, "D:\\Docs");
        add_files(&conn, 1, "D:\\Docs", "document", 20, 100);
        create_rule(
            &conn,
            &NewCatalogRule {
                name: "Docs go here",
                criteria: &RuleCriteria { kind: Some("document".to_string()), name_contains: None, zone: None },
                destination: "D:\\Ruled",
                source: "saved-after-move",
            },
        )
        .unwrap();

        let zones = vec!["C:\\Inbox".to_string()];
        let got = infer(&conn, &zones, "C:\\Inbox", "document", "a.pdf", "document")
            .unwrap()
            .expect("a destination");
        assert_eq!(got.path, "D:\\Ruled");
        assert_eq!(got.source, "rule");
    }

    #[test]
    fn learns_the_dominant_home_outside_zones() {
        let conn = migrated_conn();
        add_folder(&conn, 1, "D:\\Docs");
        add_folder(&conn, 2, "D:\\Stray");
        add_files(&conn, 1, "D:\\Docs", "document", 18, 100);
        add_files(&conn, 2, "D:\\Stray", "document", 2, 300);

        let zones = vec!["C:\\Inbox".to_string()];
        let got = infer(&conn, &zones, "C:\\Inbox", "document", "a.pdf", "document")
            .unwrap()
            .expect("a destination");
        assert_eq!(got.path, "D:\\Docs");
        assert_eq!(got.source, "learned");
        assert!(got.reason.contains("90%"), "reason states the evidence: {}", got.reason);
    }

    #[test]
    fn ignores_a_home_that_is_itself_inside_a_zone() {
        let conn = migrated_conn();
        add_folder(&conn, 1, "C:\\Inbox");
        add_files(&conn, 1, "C:\\Inbox", "document", 50, 100);

        let zones = vec!["C:\\Inbox".to_string()];
        let got = infer(&conn, &zones, "C:\\Inbox", "document", "a.pdf", "document").unwrap();
        // Falls through to the template, never proposes the inbox itself.
        assert!(got.is_none() || got.as_ref().unwrap().source == "template");
    }

    #[test]
    fn below_threshold_share_falls_through_to_template() {
        let conn = migrated_conn();
        add_folder(&conn, 1, "D:\\A");
        add_folder(&conn, 2, "D:\\B");
        add_files(&conn, 1, "D:\\A", "photo", 10, 100);
        add_files(&conn, 2, "D:\\B", "photo", 10, 300);

        let zones = vec!["C:\\Inbox".to_string()];
        let got = infer(&conn, &zones, "C:\\Inbox", "screenshot", "Screenshot 1.png", "photo")
            .unwrap()
            .expect("template fallback");
        assert_eq!(got.source, "template");
        assert!(got.path.ends_with("Screenshots"), "{}", got.path);
    }

    #[test]
    fn too_few_files_is_not_a_learned_home() {
        let conn = migrated_conn();
        add_folder(&conn, 1, "D:\\Docs");
        add_files(&conn, 1, "D:\\Docs", "model", 9, 100);

        let zones = vec!["C:\\Inbox".to_string()];
        let got = infer(&conn, &zones, "C:\\Inbox", "model", "m.gguf", "model").unwrap();
        assert!(
            got.is_none() || got.as_ref().unwrap().source != "learned",
            "9 files is under the 10-file floor"
        );
    }
}
