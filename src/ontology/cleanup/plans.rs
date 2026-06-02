//! Cleanup-plan CRUD.
//!
//! A plan captures a *scope* (which reasons, optional size cap, optional path
//! prefix). The candidate set is always recomputed from the live predicate so a
//! plan never executes stale facts.

use crate::ontology::cleanup::predicate::{filter_candidates, list_all_candidates};
use crate::ontology::cleanup::{unix_now, CleanupCandidate};
use crate::ontology::OntologyError;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// What a cleanup plan targets. Serialized to `ontology_cleanup_plans.scope`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct CleanupScope {
    /// Reason buckets to include. Empty = all reasons.
    #[serde(default)]
    pub reasons: Vec<String>,
    /// Only files with `size <= max_size`. None = no cap.
    #[serde(default)]
    pub max_size: Option<i64>,
    /// Only files whose path starts with this prefix. None = any path.
    #[serde(default)]
    pub path_prefix: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CleanupPlanRow {
    pub id: i64,
    pub created_at: i64,
    pub executed_at: Option<i64>,
    pub scope: CleanupScope,
    pub status: String,
}

/// Insert a new draft plan, returning its id.
pub fn create_plan(conn: &Connection, scope: &CleanupScope) -> Result<i64, OntologyError> {
    let scope_json = serde_json::to_string(scope)?;
    conn.execute(
        "INSERT INTO ontology_cleanup_plans (created_at, executed_at, scope, status)
         VALUES (?1, NULL, ?2, 'draft')",
        params![unix_now(), scope_json],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn get_plan(conn: &Connection, plan_id: i64) -> Result<Option<CleanupPlanRow>, OntologyError> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, created_at, executed_at, scope, status
         FROM ontology_cleanup_plans WHERE id = ?1",
    )?;
    let row = stmt
        .query_row(params![plan_id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, Option<i64>>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
            ))
        })
        .optional()?;
    match row {
        None => Ok(None),
        Some((id, created_at, executed_at, scope_json, status)) => {
            let scope: CleanupScope = serde_json::from_str(&scope_json)?;
            Ok(Some(CleanupPlanRow {
                id,
                created_at,
                executed_at,
                scope,
                status,
            }))
        }
    }
}

/// Re-evaluate the live predicate through this plan's scope.
pub fn candidates_for_plan(
    conn: &Connection,
    plan_id: i64,
) -> Result<Vec<CleanupCandidate>, OntologyError> {
    let plan = get_plan(conn, plan_id)?
        .ok_or_else(|| OntologyError::Populator(format!("cleanup plan {plan_id} not found")))?;
    let all = list_all_candidates(conn)?;
    Ok(filter_candidates(
        all,
        &plan.scope.reasons,
        plan.scope.max_size,
        plan.scope.path_prefix.as_deref(),
    ))
}

pub fn set_plan_status(
    conn: &Connection,
    plan_id: i64,
    status: &str,
    executed_at: Option<i64>,
) -> Result<(), OntologyError> {
    conn.execute(
        "UPDATE ontology_cleanup_plans SET status = ?2, executed_at = ?3 WHERE id = ?1",
        params![plan_id, status, executed_at],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::schema::ALL_MIGRATIONS;
    use crate::ontology::attrs::{assert_attr, NewAssertion};
    use crate::ontology::entities::upsert_entity;
    use crate::ontology::vocabulary::{keys, EntityKind};
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

    fn add_scratch_file(conn: &Connection, id: i64, path: &str, size: i64) {
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, size, indexed_at)
             VALUES (?1, 1, ?2, ?2, ?3, 0)",
            rusqlite::params![id, path, size],
        )
        .unwrap();
        let eid = upsert_entity(conn, EntityKind::File, path, Some(id), None, None)
            .unwrap()
            .id;
        assert_attr(
            conn,
            eid,
            &NewAssertion {
                key: keys::ROLE,
                value: "scratch",
                source: "rule:test",
                confidence: 0.95,
                display_in_global_views: true,
            },
        )
        .unwrap();
    }

    #[test]
    fn create_get_plan_round_trips_scope() {
        let conn = migrated_conn();
        let scope = CleanupScope {
            reasons: vec!["scratch".to_string()],
            max_size: Some(1024),
            path_prefix: Some("/root/".to_string()),
        };
        let id = create_plan(&conn, &scope).unwrap();
        let plan = get_plan(&conn, id).unwrap().unwrap();
        assert_eq!(plan.status, "draft");
        assert_eq!(plan.scope, scope);
        assert!(plan.executed_at.is_none());
    }

    #[test]
    fn candidates_for_plan_respects_scope() {
        let conn = migrated_conn();
        add_scratch_file(&conn, 1, "/root/a/x.js", 100);
        add_scratch_file(&conn, 2, "/root/b/y.js", 9_000);

        let scope = CleanupScope {
            reasons: vec!["scratch".to_string()],
            max_size: Some(500),
            path_prefix: None,
        };
        let id = create_plan(&conn, &scope).unwrap();
        let cands = candidates_for_plan(&conn, id).unwrap();
        assert_eq!(cands.len(), 1, "size cap should drop the 9000-byte file");
        assert_eq!(cands[0].file_id, 1);
    }

    #[test]
    fn set_plan_status_transitions() {
        let conn = migrated_conn();
        let id = create_plan(&conn, &CleanupScope::default()).unwrap();
        set_plan_status(&conn, id, "executed", Some(12345)).unwrap();
        let plan = get_plan(&conn, id).unwrap().unwrap();
        assert_eq!(plan.status, "executed");
        assert_eq!(plan.executed_at, Some(12345));
    }

    #[test]
    fn candidates_for_missing_plan_errors() {
        let conn = migrated_conn();
        assert!(candidates_for_plan(&conn, 999).is_err());
    }
}
