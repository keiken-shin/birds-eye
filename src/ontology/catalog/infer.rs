//! Destination inference: user rule, then learned home, then template.

use crate::ontology::catalog::rules::{list_rules, matches};
use crate::ontology::catalog::zones::zone_for_folder;
use crate::ontology::OntologyError;
use rusqlite::Connection;

/// A learned home must hold at least this many same-kind files.
/// Also read by `cluster::settled_folders` — "settled" means one thing in this
/// engine, whether the folder is being adopted as a destination or protected as
/// a source.
pub(crate) const MIN_LEARNED_FILES: i64 = 10;
/// ...and at least this share of them, counted outside the inbox zones.
pub(crate) const MIN_LEARNED_SHARE: f64 = 0.60;

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

    Ok(template_for(zones, kind, media_kind))
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
        // `fo.path` is a folder, so this is the folder question: under a `D:\` zone
        // `D:\Photos` is a folder the user built, not the loose-file inbox, and it stays
        // eligible as a home. The file-path rule would call it a direct child of the zone
        // and drop the folder the photos already live in.
        if zone_for_folder(&path, zones).is_none() {
            outside.push((path, count));
        }
    }

    let total: i64 = outside.iter().map(|(_, n)| *n).sum();
    if total == 0 {
        return Ok(None);
    }
    let Some((path, count)) = pick_dominant(outside) else {
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

/// Picks the dominant `(path, count)` pair: highest count wins, ties broken on
/// the path. `GROUP BY`'s row order is unspecified for equal counts, so a
/// tie-agnostic pick (e.g. `max_by_key`) could hand back a different folder on
/// a later run with the exact same data — and since the destination feeds the
/// cluster fingerprint, that churns a card's identity and defeats rejection
/// suppression. Sorting on path for ties makes the winner a pure function of
/// the data, not of `GROUP BY`'s iteration order.
fn pick_dominant(mut candidates: Vec<(String, i64)>) -> Option<(String, i64)> {
    candidates.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    candidates.into_iter().next()
}

/// Cold-start conventions, relative to the user's home. Returns None when there
/// is no sensible convention for the kind — an unclassifiable pile is left alone
/// rather than swept somewhere arbitrary — or when the conventional destination
/// itself falls inside an inbox zone.
///
/// That last check matters: `learned_home` already refuses to adopt a folder
/// inside a zone (see `ignores_a_home_that_is_itself_inside_a_zone` above), and
/// this enforces the same invariant for templates. Without it, a template
/// destination inside e.g. Downloads would immediately become a candidate
/// again on the next scan, `learned_home` could never adopt it (it's in a
/// zone), and the same template would fire forever — a suggestion that can
/// never be actioned or permanently dismissed.
fn template_for(zones: &[String], kind: &str, media_kind: &str) -> Option<Destination> {
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
        // NOT Downloads\Installers: Downloads is an inbox zone (zones.rs), so a
        // destination there would be indistinguishable from the mess it's meant
        // to clear. Software\Installers, alongside the other conventional
        // per-kind homes below, keeps installers out of the zone entirely.
        (_, "installer") => ("Software\\Installers", "installers pile up in one place"),
        (_, "photo") => ("Pictures", "the conventional home for photos"),
        (_, "video") => ("Videos", "the conventional home for video"),
        (_, "music") => ("Music", "the conventional home for audio"),
        (_, "document") => ("Documents", "the conventional home for documents"),
        _ => return None,
    };

    let destination = Destination {
        path: format!("{home}\\{suffix}"),
        source: "template",
        reason: why.to_string(),
        confidence: 0.5,
    };
    // Same folder question `cluster::candidates` asks, so "would this destination come
    // straight back as a candidate?" gets the same answer here as it does there.
    if zone_for_folder(&destination.path, zones).is_some() {
        return None;
    }
    Some(destination)
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
    fn a_folder_on_a_drive_root_zone_can_still_be_the_learned_home() {
        // `D:\` is a scan root and therefore an inbox zone. Asking the file-path question
        // about the *folder* `D:\Photos` calls it a direct child of that zone, so the
        // folder the user's photos already live in was struck out as zone-resident and the
        // suggestion fell through to a template. The drive root itself must still be
        // excluded, however many files are loose on it.
        let conn = migrated_conn();
        add_folder(&conn, 1, "D:\\Photos");
        add_files(&conn, 1, "D:\\Photos", "photo", 20, 100);
        add_folder(&conn, 2, "D:\\");
        add_files(&conn, 2, "D:", "photo", 50, 300);

        let zones = vec!["D:\\".to_string()];
        let got = infer(&conn, &zones, "D:\\", "photo", "a.jpg", "photo")
            .unwrap()
            .expect("a destination");
        assert_eq!(got.path, "D:\\Photos");
        assert_eq!(got.source, "learned");
        // 20/20 outside the zone — the 50 loose files never enter the denominator.
        assert!(got.reason.contains("100%"), "reason states the evidence: {}", got.reason);
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

    #[test]
    fn learned_home_threshold_is_inclusive_at_exactly_10_files() {
        // MIN_LEARNED_FILES rejects on `<`, so exactly 10 files must still
        // qualify (the floor is inclusive, not exclusive).
        let conn = migrated_conn();
        add_folder(&conn, 1, "D:\\Docs");
        add_files(&conn, 1, "D:\\Docs", "model", 10, 100);

        let zones = vec!["C:\\Inbox".to_string()];
        let got = infer(&conn, &zones, "C:\\Inbox", "model", "m.gguf", "model")
            .unwrap()
            .expect("a destination");
        assert_eq!(got.path, "D:\\Docs");
        assert_eq!(got.source, "learned");
    }

    #[test]
    fn learned_home_threshold_is_inclusive_at_exactly_60_percent_share() {
        // MIN_LEARNED_SHARE rejects on `<`, so a share of exactly 60% must
        // still qualify (30 of 50 outside files = 0.6 exactly).
        let conn = migrated_conn();
        add_folder(&conn, 1, "D:\\Docs");
        add_folder(&conn, 2, "D:\\Stray");
        add_files(&conn, 1, "D:\\Docs", "document", 30, 100);
        add_files(&conn, 2, "D:\\Stray", "document", 20, 300);

        let zones = vec!["C:\\Inbox".to_string()];
        let got = infer(&conn, &zones, "C:\\Inbox", "document", "a.pdf", "document")
            .unwrap()
            .expect("a destination");
        assert_eq!(got.path, "D:\\Docs");
        assert_eq!(got.source, "learned");
        assert!(got.reason.contains("60%"), "reason states the evidence: {}", got.reason);
    }

    #[test]
    fn learned_home_denominator_excludes_zone_resident_files() {
        // Pins the outside-only denominator. `C:\Inbox` holds 30 zone-resident
        // `document` files that must NOT count toward the share: with them
        // folded in, share would be 18 / (18 + 2 + 30) = 36%, below the 60%
        // floor, and this would return a template instead of `D:\Docs`. Only
        // the correct (outside-only) denominator of 18/20 = 90% passes.
        let conn = migrated_conn();
        add_folder(&conn, 1, "C:\\Inbox");
        add_folder(&conn, 2, "D:\\Docs");
        add_folder(&conn, 3, "D:\\Stray");
        add_files(&conn, 1, "C:\\Inbox", "document", 30, 100);
        add_files(&conn, 2, "D:\\Docs", "document", 18, 200);
        add_files(&conn, 3, "D:\\Stray", "document", 2, 300);

        let zones = vec!["C:\\Inbox".to_string()];
        let got = infer(&conn, &zones, "C:\\Inbox", "document", "a.pdf", "document")
            .unwrap()
            .expect("a destination");
        assert_eq!(got.path, "D:\\Docs");
        assert_eq!(got.source, "learned");
        assert!(got.reason.contains("90%"), "reason states the evidence: {}", got.reason);
    }

    #[test]
    fn malformed_rule_row_does_not_hijack_inference() {
        // A corrupt `catalog_rules` row (unparseable `criteria`) must not fail
        // open into a wildcard rule. If it did, being a user rule it would
        // outrank the learned home below and hijack every suggestion with
        // `D:\Hijacked`. It must be skipped so inference falls through to
        // whatever the valid inference would have been.
        let conn = migrated_conn();
        conn.execute(
            "INSERT INTO catalog_rules (name, criteria, destination, source, enabled, created_at)
             VALUES ('Corrupt', 'not-json', 'D:\\Hijacked', 'saved-after-move', 1, 0)",
            [],
        )
        .unwrap();

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
    }

    #[test]
    fn pick_dominant_breaks_ties_on_path_deterministically() {
        let winner = |order: Vec<(&str, i64)>| {
            pick_dominant(order.into_iter().map(|(p, n)| (p.to_string(), n)).collect())
                .unwrap()
                .0
        };
        // Same data, opposite input order: the winner must not depend on which
        // row `GROUP BY` happened to emit first for the tied count.
        assert_eq!(winner(vec![("D:\\B", 10), ("D:\\A", 10)]), "D:\\A");
        assert_eq!(winner(vec![("D:\\A", 10), ("D:\\B", 10)]), "D:\\A");
        // A clear (non-tied) winner still wins regardless of tie-break.
        assert_eq!(winner(vec![("D:\\A", 5), ("D:\\B", 9)]), "D:\\B");
    }

    #[test]
    fn no_template_destination_ever_lands_inside_an_inbox_zone() {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .expect("USERPROFILE/HOME must be set to run this test");
        let home = home.trim_end_matches(['\\', '/']).to_string();
        let zones = vec![format!("{home}\\Downloads"), format!("{home}\\Desktop")];

        // Every (kind, media_kind) combination `template_for` knows a convention
        // for — installers specifically used to point inside Downloads.
        let cases = [
            ("screenshot", "photo"),
            ("camera-photo", "photo"),
            ("invoice", "document"),
            ("resume", "document"),
            ("x", "installer"),
            ("x", "photo"),
            ("x", "video"),
            ("x", "music"),
            ("x", "document"),
        ];
        for (kind, media_kind) in cases {
            if let Some(dest) = template_for(&zones, kind, media_kind) {
                assert!(
                    zone_for_folder(&dest.path, &zones).is_none(),
                    "{media_kind}/{kind} template destination {} is inside an inbox zone",
                    dest.path
                );
            }
        }

        let installer = template_for(&zones, "x", "installer").expect("installer destination");
        assert!(installer.path.ends_with("Software\\Installers"), "{}", installer.path);
        assert!(zone_for_folder(&installer.path, &zones).is_none());
    }

    #[test]
    fn a_zone_swallowing_the_template_destination_falls_through_to_none() {
        // A pathological but possible configuration: the user's whole home
        // drive is itself a scan root and thus a zone (e.g. `C:\` with no
        // Downloads/Desktop split out). Every template destination lives under
        // home, so all of them are swallowed — `template_for` must return None
        // rather than propose a destination it just proved is inside a zone.
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .expect("USERPROFILE/HOME must be set to run this test");
        let zones = vec![home];
        assert!(template_for(&zones, "x", "installer").is_none());
        assert!(template_for(&zones, "screenshot", "photo").is_none());
    }
}
