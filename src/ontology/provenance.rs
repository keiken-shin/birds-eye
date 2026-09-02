//! Which version of which producer said this.
//!
//! Every fact in the ontology carries the name of what produced it -- an
//! extractor, a rule, a heuristic, or the person. That answers "where did this
//! come from". It does not answer the question that matters when a parser turns
//! out to be wrong: **which conclusions came from the old one?**
//!
//! Without that, there are two options and both are bad: trust everything
//! including the facts the broken parser wrote, or throw away every fact and
//! re-extract a multi-terabyte volume. So each fact records the version of the
//! code that wrote it, and [`facts_from_older_than`] asks the question directly.
//!
//! # Why only some producers have a version
//!
//! A rule is data. `rule:path-node-modules` changing its mind is a new rule
//! with a new name, and the name already tells them apart. An extractor is
//! code: `extractor:exif` reading a date wrong and then reading it right is the
//! same name twice, and only a number separates them. So extractors are
//! versioned and everything else is `UNVERSIONED`, which is a statement rather
//! than a gap.
//!
//! # Bumping one
//!
//! Change the parser, bump its number here, in the same commit. The old rows
//! keep the old number, which is the whole point -- they are now findable.

use rusqlite::{params, Connection};

use crate::ontology::OntologyError;

/// This producer is identified by its name and changes by getting a new one.
pub const UNVERSIONED: i32 = 0;

/// The version of each producer that has one, as of right now.
///
/// Matched on the full source string, not a prefix: two extractors are two
/// entries, because they change independently and a shared number would make
/// one bump invalidate the other's work.
const VERSIONS: &[(&str, i32)] = &[
    ("extractor:pdf", 1),
    ("extractor:exif", 1),
    ("extractor:zip-central-directory", 1),
    ("extractor:id3", 1),
];

/// What version of `source` is writing facts right now.
pub fn current_version(source: &str) -> i32 {
    VERSIONS
        .iter()
        .find(|(name, _)| *name == source)
        .map(|(_, version)| *version)
        .unwrap_or(UNVERSIONED)
}

/// Facts a named producer wrote before the version it is on now.
///
/// The question this module exists for. Returns `(attr id, key, value)` so a
/// caller can look at what it is about to throw away rather than deleting
/// blind.
pub fn facts_from_older_than(
    conn: &Connection,
    source: &str,
    version: i32,
) -> Result<Vec<(i64, String, String)>, OntologyError> {
    let mut statement = conn.prepare(
        "SELECT id, key, value
         FROM ontology_attrs
         WHERE source = ?1 AND source_version < ?2
         ORDER BY id",
    )?;
    let rows = statement.query_map(params![source, version], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::schema::ALL_MIGRATIONS;
    use crate::ontology::attrs::{assert_attr, NewAssertion};

    fn migrated() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        for (_, sql) in ALL_MIGRATIONS {
            conn.execute_batch(sql).unwrap();
        }
        conn.execute(
            "INSERT INTO ontology_entities (id, kind, canonical_id, created_at)
             VALUES (1, 'File', '/f', 0)",
            [],
        )
        .unwrap();
        conn
    }

    #[test]
    fn a_parser_is_versioned_and_a_rule_is_not() {
        assert_eq!(current_version("extractor:exif"), 1);
        assert_eq!(current_version("extractor:pdf"), 1);
        // A rule changing its mind is a new rule with a new name.
        assert_eq!(current_version("rule:path-node-modules"), UNVERSIONED);
        assert_eq!(current_version("user"), UNVERSIONED);
        assert_eq!(current_version("heuristic:sibling-name"), UNVERSIONED);
    }

    /// The version is taken from the source at write time, so no call site can
    /// forget to pass it and no fact can be written without one.
    #[test]
    fn a_fact_records_the_version_of_whatever_wrote_it() {
        let conn = migrated();
        for (source, key) in [("extractor:exif", "captured_at"), ("user", "role")] {
            assert_attr(
                &conn,
                1,
                &NewAssertion {
                    key,
                    value: "v",
                    source,
                    confidence: 1.0,
                    display_in_global_views: true,
                },
            )
            .unwrap();
        }

        let stored: Vec<(String, i32)> = conn
            .prepare("SELECT source, source_version FROM ontology_attrs ORDER BY id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(
            stored,
            vec![
                ("extractor:exif".to_owned(), 1),
                ("user".to_owned(), UNVERSIONED),
            ]
        );
    }

    /// The trap this module is one bump away from: someone adds a fifth
    /// extractor, ships it, and its facts silently record version 0 -- which
    /// reads as "unversioned by design" and is indistinguishable from the rules.
    /// A new parser is code, so it must appear here.
    #[test]
    fn every_extractor_in_the_tree_has_a_version() {
        let source = include_str!("populators/extractors.rs");
        let mut seen = 0;
        for (offset, _) in source.match_indices("\"extractor:") {
            let rest = &source[offset + 1..];
            let name = &rest[..rest.find('"').expect("closing quote")];
            assert_ne!(
                current_version(name),
                UNVERSIONED,
                "{name} writes facts but has no version in VERSIONS"
            );
            seen += 1;
        }
        assert!(seen >= 4, "found only {seen} extractor sources -- did the literals move?");
    }

    /// The question the module exists for: a parser was wrong, which facts came
    /// from it?
    #[test]
    fn the_facts_an_old_parser_wrote_can_be_found_without_touching_the_rest() {
        let conn = migrated();
        // What the shipped version writes today.
        assert_attr(
            &conn,
            1,
            &NewAssertion {
                key: "captured_at",
                value: "correct",
                source: "extractor:exif",
                confidence: 1.0,
                display_in_global_views: true,
            },
        )
        .unwrap();
        // A row an older build left behind, and a row from a producer that has
        // no version at all -- neither may be swept up by the other's answer.
        conn.execute(
            "INSERT INTO ontology_attrs
                (entity_id, key, value, source, confidence, asserted_at,
                 vocabulary_version, display_in_global_views, source_version)
             VALUES (1, 'captured_at', 'wrong', 'extractor:exif', 1.0, 0, 1, 1, 0),
                    (1, 'role', 'kept', 'user', 1.0, 0, 1, 1, 0)",
            [],
        )
        .unwrap();

        let stale = facts_from_older_than(&conn, "extractor:exif", 1).unwrap();
        assert_eq!(stale.len(), 1, "only the row the old parser wrote");
        assert_eq!(stale[0].2, "wrong");
    }
}
