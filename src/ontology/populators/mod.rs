//! Populator runtime contract and gated emit helpers.

pub mod heuristics;
pub mod rules;

use crate::ontology::attrs::{assert_attr, NewAssertion};
use crate::ontology::entities::{upsert_entity, Entity};
use crate::ontology::negative::{is_rejected_pair, is_rejected_property_value};
use crate::ontology::relations::{assert_relation, NewRelation};
use crate::ontology::vocabulary::EntityKind;
use crate::ontology::OntologyError;
use rusqlite::Connection;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CostTier {
    Cheap,
    Medium,
    Expensive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BudgetTier {
    CheapOnly,
    Standard,
    AllOptIn,
}

impl BudgetTier {
    pub fn allows(self, cost: CostTier) -> bool {
        match self {
            Self::CheapOnly => matches!(cost, CostTier::Cheap),
            Self::Standard => matches!(cost, CostTier::Cheap | CostTier::Medium),
            Self::AllOptIn => true,
        }
    }
}

#[derive(Debug, Clone)]
pub struct PopulatorContext {
    pub budget: BudgetTier,
    pub pause: Arc<AtomicBool>,
    counters: PopulatorReport,
}

impl PopulatorContext {
    pub fn new(budget: BudgetTier, pause: Arc<AtomicBool>) -> Self {
        Self {
            budget,
            pause,
            counters: PopulatorReport::default(),
        }
    }

    pub fn is_paused(&self) -> bool {
        self.pause.load(Ordering::Relaxed)
    }

    pub fn note_file(&mut self) {
        self.counters.files_visited += 1;
    }

    pub fn note_assertion(&mut self) {
        self.counters.assertions_emitted += 1;
    }

    pub fn note_discovery(&mut self) {
        self.counters.discoveries_emitted += 1;
    }

    pub fn note_skipped(&mut self) {
        self.counters.assertions_skipped_by_negative += 1;
    }

    pub fn snapshot(&self) -> PopulatorReport {
        self.counters.clone()
    }

    pub fn reset_counters(&mut self) {
        self.counters = PopulatorReport::default();
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PopulatorReport {
    pub files_visited: u64,
    pub assertions_emitted: u64,
    pub discoveries_emitted: u64,
    pub assertions_skipped_by_negative: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PopulatorOutcome {
    Completed(PopulatorReport),
    Paused {
        cursor: String,
        partial: PopulatorReport,
    },
}

#[derive(Debug)]
pub enum PopulatorError {
    Ontology(OntologyError),
    Aborted(String),
}

impl From<OntologyError> for PopulatorError {
    fn from(err: OntologyError) -> Self {
        Self::Ontology(err)
    }
}

impl From<rusqlite::Error> for PopulatorError {
    fn from(err: rusqlite::Error) -> Self {
        Self::Ontology(OntologyError::Sqlite(err))
    }
}

pub trait Populator: Send + Sync {
    fn name(&self) -> &'static str;
    fn cost_tier(&self) -> CostTier;
    fn run(
        &self,
        conn: &mut Connection,
        ctx: &mut PopulatorContext,
        resume_cursor: Option<&str>,
    ) -> Result<PopulatorOutcome, PopulatorError>;
}

pub fn emit_property(
    conn: &mut Connection,
    ctx: &mut PopulatorContext,
    entity_id: i64,
    key: &str,
    value: &str,
    source: &str,
    confidence: f32,
    display_in_global_views: bool,
) -> Result<bool, PopulatorError> {
    if is_rejected_property_value(conn, entity_id, key, value)? {
        ctx.note_skipped();
        return Ok(false);
    }

    assert_attr(
        conn,
        entity_id,
        &NewAssertion {
            key,
            value,
            source,
            confidence,
            display_in_global_views,
        },
    )?;
    ctx.note_assertion();
    Ok(true)
}

pub fn emit_relation(
    conn: &mut Connection,
    ctx: &mut PopulatorContext,
    subject_id: i64,
    predicate: &str,
    object_id: i64,
    source: &str,
    confidence: f32,
) -> Result<bool, PopulatorError> {
    if is_rejected_pair(conn, subject_id, predicate, object_id)? {
        ctx.note_skipped();
        return Ok(false);
    }

    assert_relation(
        conn,
        &NewRelation {
            subject_id,
            predicate,
            object_id,
            source,
            confidence,
        },
    )?;
    ctx.note_assertion();
    Ok(true)
}

pub fn ensure_file_entity(
    conn: &Connection,
    file_id: i64,
    path: &str,
) -> Result<Entity, OntologyError> {
    upsert_entity(conn, EntityKind::File, path, Some(file_id), None, None)
}

pub fn ensure_folder_entity(
    conn: &Connection,
    folder_id: i64,
    path: &str,
) -> Result<Entity, OntologyError> {
    upsert_entity(conn, EntityKind::Folder, path, None, Some(folder_id), None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::schema::ALL_MIGRATIONS;
    use crate::ontology::attrs::get_attrs;
    use crate::ontology::negative::{reject_pair, reject_property};
    use crate::ontology::relations::outbound;
    use crate::ontology::vocabulary::predicates;
    use rusqlite::Connection;

    fn dummy_ctx() -> PopulatorContext {
        PopulatorContext::new(BudgetTier::Standard, Arc::new(AtomicBool::new(false)))
    }

    fn migrated_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        for (_, sql) in ALL_MIGRATIONS {
            conn.execute_batch(sql).unwrap();
        }
        conn
    }

    fn seed_two_file_entities(conn: &Connection) -> (i64, i64) {
        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
             VALUES (1, NULL, '/root', 'root', 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, size, indexed_at)
             VALUES (1, 1, '/root/a.psd', 'a.psd', 100, 0),
                    (2, 1, '/root/a.png', 'a.png', 10, 0)",
            [],
        )
        .unwrap();

        let source = ensure_file_entity(conn, 1, "/root/a.psd").unwrap().id;
        let derivative = ensure_file_entity(conn, 2, "/root/a.png").unwrap().id;
        (source, derivative)
    }

    #[test]
    fn budget_tier_filtering() {
        assert!(BudgetTier::CheapOnly.allows(CostTier::Cheap));
        assert!(!BudgetTier::CheapOnly.allows(CostTier::Medium));
        assert!(!BudgetTier::CheapOnly.allows(CostTier::Expensive));

        assert!(BudgetTier::Standard.allows(CostTier::Cheap));
        assert!(BudgetTier::Standard.allows(CostTier::Medium));
        assert!(!BudgetTier::Standard.allows(CostTier::Expensive));

        assert!(BudgetTier::AllOptIn.allows(CostTier::Cheap));
        assert!(BudgetTier::AllOptIn.allows(CostTier::Medium));
        assert!(BudgetTier::AllOptIn.allows(CostTier::Expensive));
    }

    #[test]
    fn context_observes_externally_flipped_pause_flag() {
        let pause = Arc::new(AtomicBool::new(false));
        let ctx = PopulatorContext::new(BudgetTier::Standard, Arc::clone(&pause));

        assert!(!ctx.is_paused());
        pause.store(true, Ordering::Relaxed);
        assert!(ctx.is_paused());
    }

    #[test]
    fn emit_property_writes_when_not_rejected() {
        let mut conn = migrated_conn();
        let (entity_id, _) = seed_two_file_entities(&conn);
        let mut ctx = dummy_ctx();

        let emitted = emit_property(
            &mut conn,
            &mut ctx,
            entity_id,
            "role",
            "source",
            "rule:test",
            0.8,
            true,
        )
        .unwrap();

        assert!(emitted);
        assert_eq!(ctx.snapshot().assertions_emitted, 1);
        assert_eq!(ctx.snapshot().assertions_skipped_by_negative, 0);
        let attrs = get_attrs(&conn, entity_id, "role").unwrap();
        assert_eq!(attrs.len(), 1);
        assert_eq!(attrs[0].value, "source");
        assert!(attrs[0].display_in_global_views);
    }

    #[test]
    fn emit_property_skips_when_rejected() {
        let mut conn = migrated_conn();
        let (entity_id, _) = seed_two_file_entities(&conn);
        reject_property(&conn, entity_id, "role", "scratch", Some("wrong role")).unwrap();
        let mut ctx = dummy_ctx();

        let emitted = emit_property(
            &mut conn,
            &mut ctx,
            entity_id,
            "role",
            "scratch",
            "rule:test",
            0.8,
            true,
        )
        .unwrap();

        assert!(!emitted);
        assert_eq!(ctx.snapshot().assertions_emitted, 0);
        assert_eq!(ctx.snapshot().assertions_skipped_by_negative, 1);
        assert!(get_attrs(&conn, entity_id, "role").unwrap().is_empty());
    }

    #[test]
    fn emit_relation_writes_when_not_rejected() {
        let mut conn = migrated_conn();
        let (source, derivative) = seed_two_file_entities(&conn);
        let mut ctx = dummy_ctx();

        let emitted = emit_relation(
            &mut conn,
            &mut ctx,
            derivative,
            predicates::DERIVED_FROM,
            source,
            "heuristic:test",
            0.7,
        )
        .unwrap();

        assert!(emitted);
        assert_eq!(ctx.snapshot().assertions_emitted, 1);
        assert_eq!(ctx.snapshot().assertions_skipped_by_negative, 0);
        let relations = outbound(&conn, derivative, predicates::DERIVED_FROM).unwrap();
        assert_eq!(relations.len(), 1);
        assert_eq!(relations[0].object_id, source);
    }

    #[test]
    fn emit_relation_skips_when_rejected() {
        let mut conn = migrated_conn();
        let (source, derivative) = seed_two_file_entities(&conn);
        reject_pair(
            &conn,
            derivative,
            predicates::DERIVED_FROM,
            source,
            Some("unrelated"),
        )
        .unwrap();
        let mut ctx = dummy_ctx();

        let emitted = emit_relation(
            &mut conn,
            &mut ctx,
            derivative,
            predicates::DERIVED_FROM,
            source,
            "heuristic:test",
            0.7,
        )
        .unwrap();

        assert!(!emitted);
        assert_eq!(ctx.snapshot().assertions_emitted, 0);
        assert_eq!(ctx.snapshot().assertions_skipped_by_negative, 1);
        assert!(outbound(&conn, derivative, predicates::DERIVED_FROM)
            .unwrap()
            .is_empty());
    }
}
