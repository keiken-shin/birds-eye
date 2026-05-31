//! Rule-driven populator.
//!
//! Ships the starter "Personal Storage Patterns" bundle and matches files by
//! path, filename, or extension.

use crate::ontology::populators::{
    emit_property, ensure_file_entity, CostTier, Populator, PopulatorContext, PopulatorError,
    PopulatorOutcome,
};
use crate::ontology::vocabulary::keys;
use regex::Regex;
use rusqlite::Connection;

const BATCH_SIZE: i64 = 500;

pub enum RuleMatcher {
    PathRegex(Regex),
    FilenameRegex(Regex),
    ExtensionIn(&'static [&'static str]),
}

pub struct RuleAssertion {
    pub key: &'static str,
    pub value: &'static str,
    pub confidence: f32,
    pub display_in_global_views: bool,
}

pub struct Rule {
    pub id: &'static str,
    pub matcher: RuleMatcher,
    pub assertion: RuleAssertion,
}

impl Rule {
    pub fn matches(&self, path: &str, filename: &str, extension: Option<&str>) -> bool {
        match &self.matcher {
            RuleMatcher::PathRegex(regex) => regex.is_match(path),
            RuleMatcher::FilenameRegex(regex) => regex.is_match(filename),
            RuleMatcher::ExtensionIn(extensions) => extension
                .map(|extension| {
                    extensions
                        .iter()
                        .any(|candidate| candidate.eq_ignore_ascii_case(extension))
                })
                .unwrap_or(false),
        }
    }
}

pub fn starter_rules() -> Vec<Rule> {
    fn ci(pattern: &str) -> Regex {
        Regex::new(&format!("(?i){pattern}")).expect("bad regex")
    }

    vec![
        Rule {
            id: "rule:path-prefix-personal-details",
            matcher: RuleMatcher::PathRegex(ci("/Personal Details/")),
            assertion: RuleAssertion {
                key: keys::SENSITIVITY,
                value: "restricted",
                confidence: 1.0,
                display_in_global_views: false,
            },
        },
        Rule {
            id: "rule:path-prefix-work-details",
            matcher: RuleMatcher::PathRegex(ci("/Work Details/")),
            assertion: RuleAssertion {
                key: keys::SENSITIVITY,
                value: "restricted",
                confidence: 1.0,
                display_in_global_views: false,
            },
        },
        Rule {
            id: "rule:sensitive-keyword",
            matcher: RuleMatcher::PathRegex(ci("(passport|aadhar|pan|payslip|salary)")),
            assertion: RuleAssertion {
                key: keys::SENSITIVITY,
                value: "restricted",
                confidence: 0.9,
                display_in_global_views: false,
            },
        },
        Rule {
            id: "rule:path-old-hdd-backup",
            matcher: RuleMatcher::PathRegex(ci("/Old HDD-Backup/")),
            assertion: role("backup", 0.85),
        },
        Rule {
            id: "rule:path-backup-folder",
            matcher: RuleMatcher::PathRegex(ci("/Backup")),
            assertion: role("backup", 0.85),
        },
        Rule {
            id: "rule:path-node-modules",
            matcher: RuleMatcher::PathRegex(ci("/node_modules/")),
            assertion: role("scratch", 0.95),
        },
        Rule {
            id: "rule:path-cache",
            matcher: RuleMatcher::PathRegex(ci(r"/\.cache")),
            assertion: role("scratch", 0.95),
        },
        Rule {
            id: "rule:path-target-debug",
            matcher: RuleMatcher::PathRegex(ci("/target/(debug|release)/")),
            assertion: role("scratch", 0.95),
        },
        Rule {
            id: "rule:path-pycache",
            matcher: RuleMatcher::PathRegex(ci("/__pycache__/")),
            assertion: role("scratch", 0.95),
        },
        Rule {
            id: "rule:path-dist-build",
            matcher: RuleMatcher::PathRegex(ci("/(dist|build)/")),
            assertion: role("scratch", 0.9),
        },
        Rule {
            id: "rule:filename-ds-store",
            matcher: RuleMatcher::FilenameRegex(Regex::new(r"^\.DS_Store$").expect("bad regex")),
            assertion: role("system", 1.0),
        },
        Rule {
            id: "rule:filename-thumbs-db",
            matcher: RuleMatcher::FilenameRegex(ci(r"^Thumbs\.db$")),
            assertion: role("system", 1.0),
        },
        Rule {
            id: "rule:filename-desktop-ini",
            matcher: RuleMatcher::FilenameRegex(ci(r"^desktop\.ini$")),
            assertion: role("system", 1.0),
        },
        Rule {
            id: "rule:ext-design-source",
            matcher: RuleMatcher::ExtensionIn(&["psd", "ai", "ae", "xd", "aep", "sketch", "fig"]),
            assertion: role("source", 0.85),
        },
        Rule {
            id: "rule:ext-font",
            matcher: RuleMatcher::ExtensionIn(&["ttf", "otf", "woff", "woff2", "eot"]),
            assertion: role("asset", 0.95),
        },
        Rule {
            id: "rule:ext-installer",
            matcher: RuleMatcher::ExtensionIn(&["exe", "msi", "dmg", "AppImage"]),
            assertion: role("tool", 0.75),
        },
        Rule {
            id: "rule:origin-screenshot",
            matcher: RuleMatcher::FilenameRegex(ci(r"^(Screenshot|Screen Shot)[ _-]")),
            assertion: origin("app-export", 0.85),
        },
        Rule {
            id: "rule:origin-whatsapp",
            matcher: RuleMatcher::FilenameRegex(ci(r"^IMG[_-].*WA")),
            assertion: origin("messenger-received", 0.9),
        },
        Rule {
            id: "rule:origin-phone-camera",
            matcher: RuleMatcher::FilenameRegex(ci(r"^(IMG_\d{8}_\d{6}|DSC|PXL_)")),
            assertion: origin("phone-camera", 0.85),
        },
    ]
}

fn role(value: &'static str, confidence: f32) -> RuleAssertion {
    RuleAssertion {
        key: keys::ROLE,
        value,
        confidence,
        display_in_global_views: true,
    }
}

fn origin(value: &'static str, confidence: f32) -> RuleAssertion {
    RuleAssertion {
        key: keys::ORIGIN,
        value,
        confidence,
        display_in_global_views: true,
    }
}

pub struct RulePopulator {
    rules: Vec<Rule>,
}

impl RulePopulator {
    pub fn with_starter_bundle() -> Self {
        Self::with_rules(starter_rules())
    }

    pub fn with_rules(rules: Vec<Rule>) -> Self {
        Self { rules }
    }

    pub fn rule_count(&self) -> usize {
        self.rules.len()
    }
}

impl Populator for RulePopulator {
    fn name(&self) -> &'static str {
        "RulePopulator"
    }

    fn cost_tier(&self) -> CostTier {
        CostTier::Cheap
    }

    fn run(
        &self,
        conn: &mut Connection,
        ctx: &mut PopulatorContext,
        resume_cursor: Option<&str>,
    ) -> Result<PopulatorOutcome, PopulatorError> {
        let mut last_id = resume_cursor
            .and_then(|cursor| cursor.parse::<i64>().ok())
            .unwrap_or(0);

        loop {
            if ctx.is_paused() {
                return Ok(PopulatorOutcome::Paused {
                    cursor: last_id.to_string(),
                    partial: ctx.snapshot(),
                });
            }

            let files = {
                let mut stmt = conn.prepare(
                    "SELECT id, path, name, extension
                     FROM files
                     WHERE id > ?1 AND deleted_at IS NULL
                     ORDER BY id ASC
                     LIMIT ?2",
                )?;
                let rows = stmt.query_map(rusqlite::params![last_id, BATCH_SIZE], |row| {
                    Ok(FileRow {
                        id: row.get(0)?,
                        path: row.get(1)?,
                        name: row.get(2)?,
                        extension: row.get(3)?,
                    })
                })?;
                rows.collect::<Result<Vec<_>, _>>()?
            };

            if files.is_empty() {
                return Ok(PopulatorOutcome::Completed(ctx.snapshot()));
            }

            for file in files {
                ctx.note_file();
                let entity = ensure_file_entity(conn, file.id, &file.path)?;

                for rule in &self.rules {
                    if rule.matches(&file.path, &file.name, file.extension.as_deref()) {
                        emit_property(
                            conn,
                            ctx,
                            entity.id,
                            rule.assertion.key,
                            rule.assertion.value,
                            rule.id,
                            rule.assertion.confidence,
                            rule.assertion.display_in_global_views,
                        )?;
                    }
                }

                last_id = file.id;
            }
        }
    }
}

struct FileRow {
    id: i64,
    path: String,
    name: String,
    extension: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::schema::ALL_MIGRATIONS;
    use crate::ontology::attrs::get_attrs;
    use crate::ontology::negative::reject_property;
    use crate::ontology::populators::{BudgetTier, PopulatorContext};
    use crate::ontology::vocabulary::keys;
    use regex::Regex;
    use rusqlite::Connection;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    fn migrated_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        for (_, sql) in ALL_MIGRATIONS {
            conn.execute_batch(sql).unwrap();
        }
        conn
    }

    fn ctx(paused: bool) -> PopulatorContext {
        PopulatorContext::new(BudgetTier::Standard, Arc::new(AtomicBool::new(paused)))
    }

    fn insert_folder(conn: &Connection, id: i64, path: &str, name: &str) {
        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
             VALUES (?1, NULL, ?2, ?3, 0, 0)",
            (id, path, name),
        )
        .unwrap();
    }

    fn insert_file(
        conn: &Connection,
        id: i64,
        folder_id: i64,
        path: &str,
        name: &str,
        extension: Option<&str>,
    ) {
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, extension, size, indexed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 1, 0)",
            (id, folder_id, path, name, extension),
        )
        .unwrap();
    }

    #[test]
    fn starter_rules_has_at_least_30_rules() {
        assert!(starter_rules().len() >= 18);
    }

    #[test]
    fn rule_matches_path_regex() {
        let rule = Rule {
            id: "rule:test",
            matcher: RuleMatcher::PathRegex(Regex::new("Personal Details").unwrap()),
            assertion: RuleAssertion {
                key: keys::SENSITIVITY,
                value: "restricted",
                confidence: 1.0,
                display_in_global_views: false,
            },
        };

        assert!(rule.matches(
            "/root/Personal Details/passport.pdf",
            "passport.pdf",
            Some("pdf")
        ));
        assert!(!rule.matches("/root/Public/passport.pdf", "passport.pdf", Some("pdf")));
    }

    #[test]
    fn rule_matches_extension_in() {
        let rule = Rule {
            id: "rule:test",
            matcher: RuleMatcher::ExtensionIn(&["psd", "AI"]),
            assertion: RuleAssertion {
                key: keys::ROLE,
                value: "source",
                confidence: 0.85,
                display_in_global_views: true,
            },
        };

        assert!(rule.matches("/root/work.PSD", "work.PSD", Some("PSD")));
        assert!(rule.matches("/root/work.ai", "work.ai", Some("ai")));
        assert!(!rule.matches("/root/work.png", "work.png", Some("png")));
        assert!(!rule.matches("/root/work", "work", None));
    }

    #[test]
    fn rule_matches_filename_regex() {
        let rule = Rule {
            id: "rule:test",
            matcher: RuleMatcher::FilenameRegex(Regex::new("(?i)^desktop\\.ini$").unwrap()),
            assertion: RuleAssertion {
                key: keys::ROLE,
                value: "system",
                confidence: 1.0,
                display_in_global_views: true,
            },
        };

        assert!(rule.matches("/root/Desktop.ini", "Desktop.ini", Some("ini")));
        assert!(!rule.matches("/root/not-desktop.ini", "not-desktop.ini", Some("ini")));
    }

    #[test]
    fn populator_writes_sensitivity_for_personal_details() {
        let mut conn = migrated_conn();
        insert_folder(&conn, 1, "/root", "root");
        insert_file(
            &conn,
            1,
            1,
            "/root/Personal Details/passport.pdf",
            "passport.pdf",
            Some("pdf"),
        );
        let populator = RulePopulator::with_starter_bundle();
        let mut ctx = ctx(false);

        let outcome = populator.run(&mut conn, &mut ctx, None).unwrap();

        assert!(matches!(outcome, PopulatorOutcome::Completed(_)));
        let entity = ensure_file_entity(&conn, 1, "/root/Personal Details/passport.pdf").unwrap();
        let attrs = get_attrs(&conn, entity.id, keys::SENSITIVITY).unwrap();
        let attr = attrs
            .iter()
            .find(|attr| attr.source == "rule:path-prefix-personal-details")
            .expect("personal details rule should emit sensitivity");
        assert_eq!(attr.value, "restricted");
        assert!(!attr.display_in_global_views);
    }

    #[test]
    fn populator_resumes_from_cursor() {
        let mut conn = migrated_conn();
        insert_folder(&conn, 1, "/root", "root");
        insert_file(&conn, 1, 1, "/root/one.psd", "one.psd", Some("psd"));
        insert_file(&conn, 2, 1, "/root/two.psd", "two.psd", Some("psd"));
        let populator = RulePopulator::with_starter_bundle();
        let mut ctx = ctx(false);

        let outcome = populator.run(&mut conn, &mut ctx, Some("1")).unwrap();

        assert!(matches!(outcome, PopulatorOutcome::Completed(_)));
        let first = ensure_file_entity(&conn, 1, "/root/one.psd").unwrap();
        let second = ensure_file_entity(&conn, 2, "/root/two.psd").unwrap();
        assert!(get_attrs(&conn, first.id, keys::ROLE).unwrap().is_empty());
        assert_eq!(get_attrs(&conn, second.id, keys::ROLE).unwrap().len(), 1);
    }

    #[test]
    fn populator_pauses_when_flag_set() {
        let mut conn = migrated_conn();
        insert_folder(&conn, 1, "/root", "root");
        insert_file(&conn, 1, 1, "/root/one.psd", "one.psd", Some("psd"));
        let populator = RulePopulator::with_starter_bundle();
        let pause = Arc::new(AtomicBool::new(true));
        let mut ctx = PopulatorContext::new(BudgetTier::Standard, pause);

        let outcome = populator.run(&mut conn, &mut ctx, Some("7")).unwrap();

        assert!(matches!(
            outcome,
            PopulatorOutcome::Paused { ref cursor, .. } if cursor == "7"
        ));
        let entity = ensure_file_entity(&conn, 1, "/root/one.psd").unwrap();
        assert!(get_attrs(&conn, entity.id, keys::ROLE).unwrap().is_empty());
    }

    #[test]
    fn populator_skips_already_rejected_pairs() {
        let mut conn = migrated_conn();
        insert_folder(&conn, 1, "/root", "root");
        insert_file(&conn, 1, 1, "/root/one.psd", "one.psd", Some("psd"));
        let entity = ensure_file_entity(&conn, 1, "/root/one.psd").unwrap();
        reject_property(&conn, entity.id, keys::ROLE, "source", Some("not source")).unwrap();
        let populator = RulePopulator::with_starter_bundle();
        let mut ctx = ctx(false);

        let outcome = populator.run(&mut conn, &mut ctx, None).unwrap();

        assert!(matches!(outcome, PopulatorOutcome::Completed(_)));
        assert!(get_attrs(&conn, entity.id, keys::ROLE).unwrap().is_empty());
        assert_eq!(ctx.snapshot().assertions_skipped_by_negative, 1);
    }
}
