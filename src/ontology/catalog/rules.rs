//! User-taught destinations. Saved after the user moves files by hand or edits a
//! suggestion — never authored in a rule-builder UI up front.

use crate::ontology::OntologyError;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RuleCriteria {
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub name_contains: Option<String>,
    #[serde(default)]
    pub zone: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CatalogRule {
    pub id: i64,
    pub name: String,
    pub criteria: RuleCriteria,
    pub destination: String,
    pub source: String,
    pub enabled: bool,
}

pub struct NewCatalogRule<'a> {
    pub name: &'a str,
    pub criteria: &'a RuleCriteria,
    pub destination: &'a str,
    /// "saved-after-move" | "saved-after-edit"
    pub source: &'a str,
}

pub fn create_rule(conn: &Connection, rule: &NewCatalogRule) -> Result<i64, OntologyError> {
    let criteria = serde_json::to_string(rule.criteria)?;
    conn.execute(
        "INSERT INTO catalog_rules (name, criteria, destination, source, enabled, created_at)
         VALUES (?1, ?2, ?3, ?4, 1, strftime('%s','now'))",
        params![rule.name, criteria, rule.destination, rule.source],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn list_rules(conn: &Connection) -> Result<Vec<CatalogRule>, OntologyError> {
    let mut stmt = conn.prepare(
        "SELECT id, name, criteria, destination, source, enabled
         FROM catalog_rules
         ORDER BY id ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, i64>(5)?,
        ))
    })?;

    let mut out = Vec::new();
    for row in rows {
        let (id, name, criteria, destination, source, enabled) = row?;
        // Fail closed: `RuleCriteria::default()` is all-`None`, which `matches()`
        // treats as a wildcard. Defaulting a corrupt row would turn it into a
        // rule that matches every cluster and (being a user rule) outranks
        // everything else. Skip the row instead of returning an error, so one
        // bad row can't abort the whole inference pass.
        let Ok(criteria) = serde_json::from_str(&criteria) else {
            continue;
        };
        out.push(CatalogRule {
            id,
            name,
            criteria,
            destination,
            source,
            enabled: enabled != 0,
        });
    }
    Ok(out)
}

pub fn delete_rule(conn: &Connection, id: i64) -> Result<(), OntologyError> {
    conn.execute("DELETE FROM catalog_rules WHERE id = ?1", params![id])?;
    Ok(())
}

/// Every criterion that is present must match; absent criteria are wildcards.
pub fn matches(rule: &CatalogRule, zone: &str, kind: &str, name: &str) -> bool {
    if !rule.enabled {
        return false;
    }
    if let Some(want) = &rule.criteria.kind {
        if !want.eq_ignore_ascii_case(kind) {
            return false;
        }
    }
    if let Some(want) = &rule.criteria.zone {
        if !want.eq_ignore_ascii_case(zone) {
            return false;
        }
    }
    if let Some(want) = &rule.criteria.name_contains {
        if !name.to_ascii_lowercase().contains(&want.to_ascii_lowercase()) {
            return false;
        }
    }
    true
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
    fn round_trips_a_rule() {
        let conn = migrated_conn();
        let id = create_rule(
            &conn,
            &NewCatalogRule {
                name: "Invoices",
                criteria: &RuleCriteria {
                    kind: Some("invoice".to_string()),
                    name_contains: None,
                    zone: None,
                },
                destination: "D:\\Finance\\Invoices",
                source: "saved-after-move",
            },
        )
        .unwrap();

        let rules = list_rules(&conn).unwrap();
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].id, id);
        assert_eq!(rules[0].destination, "D:\\Finance\\Invoices");
        assert_eq!(rules[0].criteria.kind.as_deref(), Some("invoice"));
        assert!(rules[0].enabled);

        delete_rule(&conn, id).unwrap();
        assert!(list_rules(&conn).unwrap().is_empty());
    }

    #[test]
    fn matching_requires_every_present_criterion() {
        let rule = CatalogRule {
            id: 1,
            name: "Inbox invoices".to_string(),
            criteria: RuleCriteria {
                kind: Some("invoice".to_string()),
                name_contains: Some("2026".to_string()),
                zone: Some("C:\\Inbox".to_string()),
            },
            destination: "D:\\Finance".to_string(),
            source: "saved-after-move".to_string(),
            enabled: true,
        };
        assert!(matches(&rule, "C:\\Inbox", "invoice", "invoice-2026.pdf"));
        assert!(!matches(&rule, "C:\\Other", "invoice", "invoice-2026.pdf"));
        assert!(!matches(&rule, "C:\\Inbox", "document", "invoice-2026.pdf"));
        assert!(!matches(&rule, "C:\\Inbox", "invoice", "invoice-2025.pdf"));

        // An empty criteria set matches everything.
        let broad = CatalogRule {
            criteria: RuleCriteria { kind: None, name_contains: None, zone: None },
            ..rule
        };
        assert!(matches(&broad, "anywhere", "anything", "any.txt"));
    }

    #[test]
    fn a_disabled_rule_never_matches() {
        // Even a rule whose criteria would otherwise match everything must not
        // fire once disabled.
        let rule = CatalogRule {
            id: 1,
            name: "Disabled".to_string(),
            criteria: RuleCriteria { kind: None, name_contains: None, zone: None },
            destination: "D:\\Anywhere".to_string(),
            source: "saved-after-move".to_string(),
            enabled: false,
        };
        assert!(!matches(&rule, "anywhere", "anything", "any.txt"));
    }

    #[test]
    fn malformed_criteria_row_is_skipped_not_wildcarded() {
        // A row whose `criteria` column fails to parse must fail closed: it is
        // dropped, not defaulted to `RuleCriteria::default()`. Defaulting would
        // produce an all-wildcard rule that matches every cluster and, being a
        // user rule, outranks both the learned home and the template.
        let conn = migrated_conn();
        conn.execute(
            "INSERT INTO catalog_rules (name, criteria, destination, source, enabled, created_at)
             VALUES ('Corrupt', 'not-json', 'D:\\Anywhere', 'saved-after-move', 1, 0)",
            [],
        )
        .unwrap();
        let id = create_rule(
            &conn,
            &NewCatalogRule {
                name: "Valid",
                criteria: &RuleCriteria { kind: Some("invoice".to_string()), name_contains: None, zone: None },
                destination: "D:\\Finance",
                source: "saved-after-move",
            },
        )
        .unwrap();

        let rules = list_rules(&conn).unwrap();
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].id, id);
        assert_eq!(rules[0].destination, "D:\\Finance");
    }
}
