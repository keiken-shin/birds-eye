//! Phase 2 orchestrator.
//!
//! Phase 2 runs ontology populators in deterministic cost-tier order and
//! persists each populator's cursor and emitted counters so interrupted work
//! can resume across process runs.

use crate::ontology::enabled::is_enabled;
use crate::ontology::populators::heuristics::StructuralHeuristicPopulator;
use crate::ontology::populators::rules::RulePopulator;
use crate::ontology::populators::{
    BudgetTier, CostTier, Populator, PopulatorContext, PopulatorError, PopulatorOutcome,
    PopulatorReport,
};
use crate::ontology::OntologyError;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PopulatorStatus {
    Idle,
    Running,
    Paused,
    Completed,
    Failed,
}

impl PopulatorStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Running => "running",
            Self::Paused => "paused",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }

    pub fn from_str(value: &str) -> Result<Self, OntologyError> {
        match value {
            "idle" => Ok(Self::Idle),
            "running" => Ok(Self::Running),
            "paused" => Ok(Self::Paused),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            other => Err(OntologyError::InvalidVocabulary(format!(
                "PopulatorStatus: {other}"
            ))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PopulatorState {
    pub populator_name: String,
    pub status: PopulatorStatus,
    pub cursor: Option<String>,
    pub files_visited: u64,
    pub assertions_emitted: u64,
    pub discoveries_emitted: u64,
    pub last_run_at: Option<i64>,
    pub last_error: Option<String>,
}

pub fn read_state(conn: &Connection, name: &str) -> Result<Option<PopulatorState>, OntologyError> {
    conn.query_row(
        "SELECT populator_name, status, cursor, files_visited, assertions_emitted,
                discoveries_emitted, last_run_at, last_error
         FROM ontology_populator_state
         WHERE populator_name = ?1",
        [name],
        |row| {
            let status: String = row.get(1)?;
            let files_visited: i64 = row.get(3)?;
            let assertions_emitted: i64 = row.get(4)?;
            let discoveries_emitted: i64 = row.get(5)?;

            Ok((
                row.get::<_, String>(0)?,
                status,
                row.get::<_, Option<String>>(2)?,
                files_visited,
                assertions_emitted,
                discoveries_emitted,
                row.get::<_, Option<i64>>(6)?,
                row.get::<_, Option<String>>(7)?,
            ))
        },
    )
    .optional()?
    .map(
        |(
            populator_name,
            status,
            cursor,
            files_visited,
            assertions_emitted,
            discoveries_emitted,
            last_run_at,
            last_error,
        )| {
            Ok(PopulatorState {
                populator_name,
                status: PopulatorStatus::from_str(&status)?,
                cursor,
                files_visited: read_counter("files_visited", files_visited)?,
                assertions_emitted: read_counter("assertions_emitted", assertions_emitted)?,
                discoveries_emitted: read_counter("discoveries_emitted", discoveries_emitted)?,
                last_run_at,
                last_error,
            })
        },
    )
    .transpose()
}

fn upsert_state(
    conn: &Connection,
    populator_name: &str,
    status: PopulatorStatus,
    cursor: Option<&str>,
    report: &PopulatorReport,
    last_error: Option<&str>,
) -> Result<(), OntologyError> {
    let files_visited = write_counter("files_visited", report.files_visited)?;
    let assertions_emitted = write_counter("assertions_emitted", report.assertions_emitted)?;
    let discoveries_emitted = write_counter("discoveries_emitted", report.discoveries_emitted)?;

    conn.execute(
        "INSERT INTO ontology_populator_state
         (populator_name, status, cursor, files_visited, assertions_emitted,
          discoveries_emitted, last_run_at, last_error)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(populator_name) DO UPDATE SET
           status = excluded.status,
           cursor = excluded.cursor,
           files_visited = excluded.files_visited,
           assertions_emitted = excluded.assertions_emitted,
           discoveries_emitted = excluded.discoveries_emitted,
           last_run_at = excluded.last_run_at,
           last_error = excluded.last_error",
        params![
            populator_name,
            status.as_str(),
            cursor,
            files_visited,
            assertions_emitted,
            discoveries_emitted,
            unix_now(),
            last_error
        ],
    )?;
    Ok(())
}

pub struct PopulatorOrchestrator {
    populators: Vec<Box<dyn Populator>>,
}

impl Default for PopulatorOrchestrator {
    fn default() -> Self {
        Self::new(vec![
            Box::new(RulePopulator::with_starter_bundle()),
            Box::new(StructuralHeuristicPopulator::new()),
        ])
    }
}

impl PopulatorOrchestrator {
    pub fn new(populators: Vec<Box<dyn Populator>>) -> Self {
        Self { populators }
    }

    fn ordered(&self) -> Vec<&dyn Populator> {
        let mut populators: Vec<&dyn Populator> =
            self.populators.iter().map(|p| p.as_ref()).collect();
        populators.sort_by_key(|p| cost_rank(p.cost_tier()));
        populators
    }

    pub fn run(
        &self,
        conn: &mut Connection,
        budget: BudgetTier,
        pause: Arc<AtomicBool>,
    ) -> Result<Vec<(String, PopulatorOutcome)>, OntologyError> {
        let mut outcomes = Vec::new();

        for populator in self.ordered() {
            if !budget.allows(populator.cost_tier()) {
                continue;
            }

            let prior = read_state(conn, populator.name())?;
            let resume_cursor = prior.as_ref().and_then(|state| {
                if state.status == PopulatorStatus::Completed {
                    None
                } else {
                    state.cursor.as_deref()
                }
            });
            let mut ctx = PopulatorContext::new(budget, Arc::clone(&pause));
            upsert_state(
                conn,
                populator.name(),
                PopulatorStatus::Running,
                resume_cursor,
                &PopulatorReport::default(),
                None,
            )?;

            match populator.run(conn, &mut ctx, resume_cursor) {
                Ok(PopulatorOutcome::Completed(report)) => {
                    let outcome = PopulatorOutcome::Completed(report.clone());
                    upsert_state(
                        conn,
                        populator.name(),
                        PopulatorStatus::Completed,
                        None,
                        &report,
                        None,
                    )?;
                    outcomes.push((populator.name().to_string(), outcome));
                }
                Ok(PopulatorOutcome::Paused { cursor, partial }) => {
                    let outcome = PopulatorOutcome::Paused {
                        cursor: cursor.clone(),
                        partial: partial.clone(),
                    };
                    upsert_state(
                        conn,
                        populator.name(),
                        PopulatorStatus::Paused,
                        Some(&cursor),
                        &partial,
                        None,
                    )?;
                    outcomes.push((populator.name().to_string(), outcome));
                    break;
                }
                Err(PopulatorError::Aborted(msg)) => {
                    upsert_state(
                        conn,
                        populator.name(),
                        PopulatorStatus::Failed,
                        resume_cursor,
                        &ctx.snapshot(),
                        Some(&msg),
                    )?;
                    return Err(OntologyError::Populator(msg));
                }
                Err(PopulatorError::Ontology(err)) => {
                    let last_error = err.to_string();
                    upsert_state(
                        conn,
                        populator.name(),
                        PopulatorStatus::Failed,
                        resume_cursor,
                        &ctx.snapshot(),
                        Some(&last_error),
                    )?;
                    return Err(err);
                }
            }
        }

        Ok(outcomes)
    }
}

pub fn run_phase2(
    index_path: &Path,
    budget: BudgetTier,
    pause: Arc<AtomicBool>,
) -> Result<bool, OntologyError> {
    let mut conn = Connection::open(index_path)?;
    if !is_enabled(&conn)? {
        return Ok(false);
    }

    PopulatorOrchestrator::default().run(&mut conn, budget, pause)?;
    Ok(true)
}

fn cost_rank(cost: CostTier) -> u8 {
    match cost {
        CostTier::Cheap => 0,
        CostTier::Medium => 1,
        CostTier::Expensive => 2,
    }
}

fn read_counter(name: &str, value: i64) -> Result<u64, OntologyError> {
    u64::try_from(value).map_err(|_| {
        OntologyError::InvalidVocabulary(format!("{name} counter must be non-negative: {value}"))
    })
}

fn write_counter(name: &str, value: u64) -> Result<i64, OntologyError> {
    i64::try_from(value).map_err(|_| {
        OntologyError::InvalidVocabulary(format!("{name} counter exceeds sqlite INTEGER: {value}"))
    })
}

fn unix_now() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::schema::ALL_MIGRATIONS;
    use crate::ontology::enabled::enable;
    use rusqlite::Connection;
    use std::sync::atomic::AtomicBool;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct DummyPopulator {
        name: &'static str,
        cost: CostTier,
        outcome: PopulatorOutcome,
        expected_resume: Option<&'static str>,
    }

    impl Populator for DummyPopulator {
        fn name(&self) -> &'static str {
            self.name
        }

        fn cost_tier(&self) -> CostTier {
            self.cost
        }

        fn run(
            &self,
            _conn: &mut Connection,
            ctx: &mut PopulatorContext,
            resume_cursor: Option<&str>,
        ) -> Result<PopulatorOutcome, PopulatorError> {
            assert_eq!(resume_cursor, self.expected_resume);
            ctx.note_file();
            Ok(self.outcome.clone())
        }
    }

    fn migrated_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        for (_, sql) in ALL_MIGRATIONS {
            conn.execute_batch(sql).unwrap();
        }
        conn
    }

    fn pause() -> Arc<AtomicBool> {
        Arc::new(AtomicBool::new(false))
    }

    #[test]
    fn status_roundtrip_and_invalid_status() {
        for status in [
            PopulatorStatus::Idle,
            PopulatorStatus::Running,
            PopulatorStatus::Paused,
            PopulatorStatus::Completed,
            PopulatorStatus::Failed,
        ] {
            assert_eq!(PopulatorStatus::from_str(status.as_str()).unwrap(), status);
        }

        assert!(matches!(
            PopulatorStatus::from_str("mystery"),
            Err(OntologyError::InvalidVocabulary(_))
        ));
    }

    #[test]
    fn orchestrator_runs_cheap_populators_and_records_state() {
        let mut conn = migrated_conn();
        let orchestrator = PopulatorOrchestrator::new(vec![Box::new(DummyPopulator {
            name: "cheap",
            cost: CostTier::Cheap,
            outcome: PopulatorOutcome::Completed(PopulatorReport {
                files_visited: 2,
                assertions_emitted: 3,
                discoveries_emitted: 4,
                assertions_skipped_by_negative: 0,
            }),
            expected_resume: None,
        })]);

        let outcomes = orchestrator
            .run(&mut conn, BudgetTier::CheapOnly, pause())
            .unwrap();

        assert_eq!(outcomes.len(), 1);
        let state = read_state(&conn, "cheap").unwrap().unwrap();
        assert_eq!(state.status, PopulatorStatus::Completed);
        assert_eq!(state.cursor, None);
        assert_eq!(state.files_visited, 2);
        assert_eq!(state.assertions_emitted, 3);
        assert_eq!(state.discoveries_emitted, 4);
        assert!(state.last_run_at.is_some());
        assert_eq!(state.last_error, None);
    }

    #[test]
    fn orchestrator_reruns_completed_populators_safely() {
        let mut conn = migrated_conn();
        let orchestrator = PopulatorOrchestrator::new(vec![Box::new(DummyPopulator {
            name: "cheap",
            cost: CostTier::Cheap,
            outcome: PopulatorOutcome::Completed(PopulatorReport::default()),
            expected_resume: None,
        })]);

        assert_eq!(
            orchestrator
                .run(&mut conn, BudgetTier::CheapOnly, pause())
                .unwrap()
                .len(),
            1
        );
        let outcomes = orchestrator
            .run(&mut conn, BudgetTier::CheapOnly, pause())
            .unwrap();

        assert_eq!(outcomes.len(), 1);
    }

    #[test]
    fn orchestrator_persists_paused_cursor_and_resumes() {
        let mut conn = migrated_conn();
        let paused = PopulatorOrchestrator::new(vec![
            Box::new(DummyPopulator {
                name: "resume",
                cost: CostTier::Cheap,
                outcome: PopulatorOutcome::Paused {
                    cursor: "cursor-1".to_string(),
                    partial: PopulatorReport {
                        files_visited: 5,
                        assertions_emitted: 6,
                        discoveries_emitted: 7,
                        assertions_skipped_by_negative: 0,
                    },
                },
                expected_resume: None,
            }),
            Box::new(DummyPopulator {
                name: "later",
                cost: CostTier::Cheap,
                outcome: PopulatorOutcome::Completed(PopulatorReport::default()),
                expected_resume: None,
            }),
        ]);

        let outcomes = paused
            .run(&mut conn, BudgetTier::CheapOnly, pause())
            .unwrap();
        assert_eq!(outcomes.len(), 1);
        let state = read_state(&conn, "resume").unwrap().unwrap();
        assert_eq!(state.status, PopulatorStatus::Paused);
        assert_eq!(state.cursor.as_deref(), Some("cursor-1"));
        assert!(read_state(&conn, "later").unwrap().is_none());

        let resumed = PopulatorOrchestrator::new(vec![Box::new(DummyPopulator {
            name: "resume",
            cost: CostTier::Cheap,
            outcome: PopulatorOutcome::Completed(PopulatorReport {
                files_visited: 1,
                assertions_emitted: 0,
                discoveries_emitted: 0,
                assertions_skipped_by_negative: 0,
            }),
            expected_resume: Some("cursor-1"),
        })]);
        resumed
            .run(&mut conn, BudgetTier::CheapOnly, pause())
            .unwrap();

        let state = read_state(&conn, "resume").unwrap().unwrap();
        assert_eq!(state.status, PopulatorStatus::Completed);
        assert_eq!(state.cursor, None);
    }

    #[test]
    fn read_state_rejects_negative_counters() {
        let conn = migrated_conn();
        conn.execute(
            "INSERT INTO ontology_populator_state
             (populator_name, status, files_visited, assertions_emitted, discoveries_emitted)
             VALUES ('bad', 'idle', -1, 0, 0)",
            [],
        )
        .unwrap();

        assert!(matches!(
            read_state(&conn, "bad"),
            Err(OntologyError::InvalidVocabulary(_))
        ));
    }

    #[test]
    fn budget_gates_populators_by_cost_tier() {
        let mut conn = migrated_conn();
        let orchestrator = PopulatorOrchestrator::new(vec![
            Box::new(DummyPopulator {
                name: "expensive",
                cost: CostTier::Expensive,
                outcome: PopulatorOutcome::Completed(PopulatorReport::default()),
                expected_resume: None,
            }),
            Box::new(DummyPopulator {
                name: "medium",
                cost: CostTier::Medium,
                outcome: PopulatorOutcome::Completed(PopulatorReport::default()),
                expected_resume: None,
            }),
            Box::new(DummyPopulator {
                name: "cheap",
                cost: CostTier::Cheap,
                outcome: PopulatorOutcome::Completed(PopulatorReport::default()),
                expected_resume: None,
            }),
        ]);

        let outcomes = orchestrator
            .run(&mut conn, BudgetTier::Standard, pause())
            .unwrap();

        assert_eq!(
            outcomes
                .iter()
                .map(|(name, _)| name.as_str())
                .collect::<Vec<_>>(),
            vec!["cheap", "medium"]
        );
        assert!(read_state(&conn, "expensive").unwrap().is_none());
    }

    #[test]
    fn run_phase2_returns_false_when_disabled() {
        let path = temp_db_path("phase2-disabled");
        let conn = Connection::open(&path).unwrap();
        for (_, sql) in ALL_MIGRATIONS {
            conn.execute_batch(sql).unwrap();
        }
        drop(conn);

        assert!(!run_phase2(&path, BudgetTier::CheapOnly, pause()).unwrap());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn run_phase2_executes_when_enabled() {
        let path = temp_db_path("phase2-enabled");
        let conn = Connection::open(&path).unwrap();
        for (_, sql) in ALL_MIGRATIONS {
            conn.execute_batch(sql).unwrap();
        }
        enable(&conn).unwrap();
        seed_index(&conn);
        drop(conn);

        assert!(run_phase2(&path, BudgetTier::CheapOnly, pause()).unwrap());

        let conn = Connection::open(&path).unwrap();
        assert!(read_state(&conn, "RulePopulator").unwrap().is_some());
        assert!(read_state(&conn, "StructuralHeuristicPopulator")
            .unwrap()
            .is_some());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn default_orchestrator_rerun_enriches_new_files_without_duplicate_rule_attrs() {
        let mut conn = migrated_conn();
        seed_root_folder(&conn);
        insert_file(&conn, 1, "/root/one.psd", "one.psd", Some("psd"));
        let orchestrator = PopulatorOrchestrator::default();

        orchestrator
            .run(&mut conn, BudgetTier::CheapOnly, pause())
            .unwrap();
        assert_eq!(source_role_count(&conn), 1);

        insert_file(&conn, 2, "/root/two.psd", "two.psd", Some("psd"));
        let outcomes = orchestrator
            .run(&mut conn, BudgetTier::CheapOnly, pause())
            .unwrap();

        assert!(!outcomes.is_empty());
        assert_eq!(source_role_count(&conn), 2);
    }

    fn seed_index(conn: &Connection) {
        seed_root_folder(conn);
        insert_file(conn, 1, "/root/node_modules/a.js", "a.js", Some("js"));
    }

    fn seed_root_folder(conn: &Connection) {
        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
             VALUES (1, NULL, '/root', 'root', 0, 0)",
            [],
        )
        .unwrap();
    }

    fn insert_file(conn: &Connection, id: i64, path: &str, name: &str, extension: Option<&str>) {
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, extension, size, indexed_at)
             VALUES (?1, 1, ?2, ?3, ?4, 10, 0)",
            (id, path, name, extension),
        )
        .unwrap();
    }

    fn source_role_count(conn: &Connection) -> i64 {
        conn.query_row(
            "SELECT COUNT(*)
             FROM ontology_attrs
             WHERE key = 'role'
               AND value = 'source'
               AND source = 'rule:ext-design-source'",
            [],
            |row| row.get(0),
        )
        .unwrap()
    }

    fn temp_db_path(label: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "birds-eye-{label}-{}-{nanos}.sqlite",
            std::process::id()
        ))
    }
}
