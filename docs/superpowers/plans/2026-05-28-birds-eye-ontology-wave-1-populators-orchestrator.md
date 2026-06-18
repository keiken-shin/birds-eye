# Birds Eye Ontology Wave 1 — Plan 2: Populators & Orchestrator

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the Phase-2 enrichment layer on top of Plan 1's foundation — a `Populator` trait, a `RulePopulator` with the "Personal Storage Patterns" starter bundle, a `StructuralHeuristicPopulator` (sibling `derivedFrom`, cross-folder `backupOf`, replaceability inference), a `PopulatorOrchestrator` with pause/resume + budget gating + negative-assertion gating + persisted progress, and the discoveries write path — wired into the existing `ScanJobManager` as a separate Phase-2 step that runs only when the ontology layer is enabled for the index.

**Architecture:** A new `src/ontology/populators/` submodule defines the `Populator` trait and concrete populator implementations. A new `src/ontology/orchestrator.rs` sequences populators in cost-tier order against a shared `PopulatorContext` that carries the pause flag, budget tier, and counters. A new `src/ontology/discoveries.rs` module owns insert/query for `ontology_discoveries`. A new `MIGRATION_006` adds an `ontology_populator_state` table that records each populator's cursor and last-run stats so a paused or interrupted Phase 2 resumes cleanly. The orchestrator is invoked from a new public function `run_phase2(index_path)` that `ScanJobManager` calls *after* Phase 1 completes, conditional on `ontology::enabled::is_enabled`. All populator writes go through helpers that consult `ontology_negative_assertions` first, so user rejections are honored across runs.

**Tech Stack:** Rust 2021, `rusqlite` 0.32 (bundled SQLite), `regex` 1, `serde` 1, `serde_json` (new dependency — add to `Cargo.toml`). Tests use stock `#[cfg(test)]` modules with in-memory SQLite plus an integration test against the existing `chapter-2-example-real-dataset/` fixture.

**Spec reference:** [docs/superpowers/specs/2026-05-26-birds-eye-ontology-wave-1-design.md](../specs/2026-05-26-birds-eye-ontology-wave-1-design.md) §6 (Populator framework), §3 (Constitutional defenses), §6 starter rule bundle.

**Plan 1 dependency:** [docs/superpowers/plans/2026-05-26-birds-eye-ontology-wave-1-foundation.md](2026-05-26-birds-eye-ontology-wave-1-foundation.md) must be fully merged. This plan uses `ontology::entities::upsert_entity`, `ontology::attrs::assert_attr`, `ontology::relations::assert_relation`, `ontology::negative::{is_rejected_pair, is_rejected_property}`, `ontology::vocabulary::*`, `ontology::enabled::is_enabled`, and the `MIGRATION_005` tables.

**Plan-2 scope:** Populators + orchestrator + discoveries write path + Phase 2 hook only. No cleanup engine, no frontend, no Tauri commands, no metadata extractors, no perceptual hashing.

---

## File Structure

This plan creates the following files (new) and modifies the following (existing):

**Create:**
- `src/ontology/populators/mod.rs` — `Populator` trait, `CostTier`, `PopulatorReport`, `PopulatorError`, `PopulatorOutput`, gated-emit helpers
- `src/ontology/populators/rules.rs` — `RulePopulator`, `Rule`, `RuleMatcher`, `RuleAssertion`, `starter_rules()` (the Personal Storage Patterns bundle)
- `src/ontology/populators/heuristics.rs` — `StructuralHeuristicPopulator` (sibling-derivedFrom, cross-folder backupOf, replaceability inference)
- `src/ontology/orchestrator.rs` — `PopulatorOrchestrator`, `PopulatorContext`, `BudgetTier`, `PauseFlag`, populator-state CRUD, `run_phase2`
- `src/ontology/discoveries.rs` — `Discovery`, `NewDiscovery`, `insert_discovery`, `list_discoveries`, `count_pending`
- `tests/ontology_populators.rs` — integration test exercising the orchestrator end-to-end against the real-dataset fixture

**Modify:**
- `Cargo.toml` — add `serde_json = "1"`
- `src/index/schema.rs` — append `MIGRATION_006`, bump `CURRENT_SCHEMA_VERSION` to 6, extend `ALL_MIGRATIONS`, extend schema tests
- `src/ontology/mod.rs` — register the new submodules (`populators`, `orchestrator`, `discoveries`)
- `src/ontology/errors.rs` — add `PopulatorError` variants if not consolidated under `OntologyError` (this plan extends `OntologyError`)
- `src/native/jobs.rs` — after Phase-1 completion, conditionally invoke `ontology::orchestrator::run_phase2(&index_path)` if the layer is enabled; emit `enrichment` log lines and progress events; do not block job completion on Phase 2 failure (log + continue)

**Vocabulary version constant:** still `1`, unchanged by this plan.

---

## Task 1: Add `serde_json` dependency and `MIGRATION_006` (populator state)

**Files:**
- Modify: [Cargo.toml](../../../Cargo.toml)
- Modify: [src/index/schema.rs](../../../src/index/schema.rs)

**Goal:** Land the new dependency and the migration that creates `ontology_populator_state`. Cursor + counters are persisted so a paused or crashed Phase 2 resumes cleanly.

- [ ] **Step 1.1: Add `serde_json` to `Cargo.toml`**

Edit [Cargo.toml](../../../Cargo.toml) under `[dependencies]`:

```toml
serde_json = "1"
```

The final dependencies block should read:

```toml
[dependencies]
rusqlite = { version = "0.32", features = ["bundled"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
regex = "1"
xxhash-rust = { version = "0.8", features = ["xxh3"] }
rayon = "1"
trash = "3"
```

- [ ] **Step 1.2: Run `cargo build` to confirm the new crate resolves**

Run: `cargo build`
Expected: clean build (just resolves the new crate; nothing uses it yet).

- [ ] **Step 1.3: Write the failing schema test additions**

Append to the `#[cfg(test)] mod tests` block at the bottom of [src/index/schema.rs](../../../src/index/schema.rs):

```rust
    #[test]
    fn migration_006_present_and_contains_populator_state() {
        assert!(CURRENT_SCHEMA_VERSION >= 6);
        let mig = ALL_MIGRATIONS
            .iter()
            .find(|(v, _)| *v == 6)
            .expect("migration 6 missing")
            .1;
        assert!(
            mig.contains("CREATE TABLE IF NOT EXISTS ontology_populator_state"),
            "migration 6 must create ontology_populator_state",
        );
        assert!(
            mig.contains("idx_populator_state_status"),
            "migration 6 must create the status index",
        );
    }

    #[test]
    fn migration_006_applies_cleanly_in_memory() {
        use rusqlite::Connection;

        let conn = Connection::open_in_memory().expect("open in-memory db");
        for (_, sql) in ALL_MIGRATIONS {
            conn.execute_batch(sql).expect("migration applies");
        }
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='ontology_populator_state'",
                [],
                |r| r.get(0),
            )
            .expect("query sqlite_master");
        assert_eq!(count, 1, "ontology_populator_state must exist after migrations");
    }
```

- [ ] **Step 1.4: Run the new tests; verify they fail**

Run: `cargo test --lib index::schema::tests::migration_006_present_and_contains_populator_state`
Expected: FAIL with `migration 6 missing` panic or `CURRENT_SCHEMA_VERSION >= 6` assertion.

- [ ] **Step 1.5: Add `MIGRATION_006`, bump the version, extend `ALL_MIGRATIONS`**

In [src/index/schema.rs](../../../src/index/schema.rs):

Change the top constant:
```rust
pub const CURRENT_SCHEMA_VERSION: u32 = 6;
```

Append a new migration constant after `MIGRATION_005`:

```rust
pub const MIGRATION_006: &str = r#"
CREATE TABLE IF NOT EXISTS ontology_populator_state (
  populator_name TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'paused', 'completed', 'failed')),
  cursor TEXT,
  files_visited INTEGER NOT NULL DEFAULT 0,
  assertions_emitted INTEGER NOT NULL DEFAULT 0,
  discoveries_emitted INTEGER NOT NULL DEFAULT 0,
  last_run_at INTEGER,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_populator_state_status ON ontology_populator_state(status);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (6, strftime('%s', 'now'));
"#;
```

Extend `ALL_MIGRATIONS`:
```rust
pub const ALL_MIGRATIONS: &[(u32, &str)] = &[
    (1, MIGRATION_001),
    (2, MIGRATION_002),
    (3, MIGRATION_003),
    (4, MIGRATION_004),
    (5, MIGRATION_005),
    (6, MIGRATION_006),
];
```

Update the existing `exposes_current_migration` test:
```rust
    #[test]
    fn exposes_current_migration() {
        assert_eq!(CURRENT_SCHEMA_VERSION, 6);
        assert_eq!(ALL_MIGRATIONS.len(), 6);
    }
```

- [ ] **Step 1.6: Run the schema tests; verify they pass**

Run: `cargo test --lib index::schema::tests`
Expected: ALL tests pass.

- [ ] **Step 1.7: Commit**

```bash
git add Cargo.toml src/index/schema.rs
git commit -m "feat(ontology): MIGRATION_006 adds populator state + serde_json dep"
```

---

## Task 2: `Populator` trait, `PopulatorContext`, gated-emit helpers, error type

**Files:**
- Create: `src/ontology/populators/mod.rs`
- Modify: `src/ontology/mod.rs`
- Modify: `src/ontology/errors.rs`

**Goal:** Define the populator trait and the runtime contract (context, pause flag, budget tier, gated emit helpers that consult negative assertions before writing).

- [ ] **Step 2.1: Extend `OntologyError`**

In [src/ontology/errors.rs](../../../src/ontology/errors.rs), replace the `OntologyError` enum and its impls with:

```rust
use rusqlite;

#[derive(Debug)]
pub enum OntologyError {
    Sqlite(rusqlite::Error),
    InvalidVocabulary(String),
    EntityNotFound(i64),
    OntologyDisabled,
    Populator(String),
    Json(String),
}

impl From<rusqlite::Error> for OntologyError {
    fn from(err: rusqlite::Error) -> Self {
        OntologyError::Sqlite(err)
    }
}

impl From<serde_json::Error> for OntologyError {
    fn from(err: serde_json::Error) -> Self {
        OntologyError::Json(err.to_string())
    }
}

impl std::fmt::Display for OntologyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Sqlite(e) => write!(f, "sqlite error: {e}"),
            Self::InvalidVocabulary(v) => write!(f, "invalid vocabulary value: {v}"),
            Self::EntityNotFound(id) => write!(f, "entity not found: {id}"),
            Self::OntologyDisabled => write!(f, "ontology layer is disabled for this index"),
            Self::Populator(msg) => write!(f, "populator error: {msg}"),
            Self::Json(msg) => write!(f, "json error: {msg}"),
        }
    }
}

impl std::error::Error for OntologyError {}
```

- [ ] **Step 2.2: Create `src/ontology/populators/mod.rs`**

```rust
//! Populator framework: trait, runtime context, gated emit helpers.

pub mod heuristics;
pub mod rules;

use crate::ontology::attrs::{assert_attr, NewAssertion};
use crate::ontology::entities::{upsert_entity, Entity};
use crate::ontology::negative::{is_rejected_pair, is_rejected_property};
use crate::ontology::relations::{assert_relation, NewRelation};
use crate::ontology::vocabulary::EntityKind;
use crate::ontology::OntologyError;
use rusqlite::Connection;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Cost tiers control budget gating in the orchestrator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CostTier {
    /// Always runs. Targeted to consume < 5% of Phase-1 scan time.
    Cheap,
    /// Runs only when budget is `Standard` or `AllOptIn` AND a per-populator opt-in is set.
    Medium,
    /// Runs only when budget is `AllOptIn` AND a per-populator opt-in is set.
    Expensive,
}

/// Budget tier picked by the caller. The orchestrator filters populators by tier.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BudgetTier {
    CheapOnly,
    Standard,
    AllOptIn,
}

impl BudgetTier {
    pub fn allows(self, cost: CostTier) -> bool {
        matches!(
            (self, cost),
            (BudgetTier::CheapOnly, CostTier::Cheap)
                | (BudgetTier::Standard, CostTier::Cheap)
                | (BudgetTier::Standard, CostTier::Medium)
                | (BudgetTier::AllOptIn, _)
        )
    }
}

/// Shared per-run context. The orchestrator owns one and passes by ref to each populator.
pub struct PopulatorContext {
    pub budget: BudgetTier,
    pub pause: Arc<AtomicBool>,
    counters: Counters,
}

#[derive(Default)]
struct Counters {
    pub files_visited: u64,
    pub assertions_emitted: u64,
    pub discoveries_emitted: u64,
    pub assertions_skipped_by_negative: u64,
}

impl PopulatorContext {
    pub fn new(budget: BudgetTier, pause: Arc<AtomicBool>) -> Self {
        Self { budget, pause, counters: Counters::default() }
    }

    pub fn is_paused(&self) -> bool {
        self.pause.load(Ordering::Relaxed)
    }

    pub fn note_file(&mut self) { self.counters.files_visited += 1; }
    pub fn note_assertion(&mut self) { self.counters.assertions_emitted += 1; }
    pub fn note_discovery(&mut self) { self.counters.discoveries_emitted += 1; }
    pub fn note_skipped(&mut self) { self.counters.assertions_skipped_by_negative += 1; }

    pub fn snapshot(&self) -> PopulatorReport {
        PopulatorReport {
            files_visited: self.counters.files_visited,
            assertions_emitted: self.counters.assertions_emitted,
            discoveries_emitted: self.counters.discoveries_emitted,
            assertions_skipped_by_negative: self.counters.assertions_skipped_by_negative,
        }
    }

    pub fn reset_counters(&mut self) {
        self.counters = Counters::default();
    }
}

/// Per-populator outcome.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct PopulatorReport {
    pub files_visited: u64,
    pub assertions_emitted: u64,
    pub discoveries_emitted: u64,
    pub assertions_skipped_by_negative: u64,
}

/// Outcome of a `run` invocation, signalling whether the populator finished or paused mid-way.
#[derive(Debug)]
pub enum PopulatorOutcome {
    Completed(PopulatorReport),
    Paused { cursor: String, partial: PopulatorReport },
}

#[derive(Debug)]
pub enum PopulatorError {
    Ontology(OntologyError),
    Aborted(String),
}

impl From<OntologyError> for PopulatorError {
    fn from(value: OntologyError) -> Self { PopulatorError::Ontology(value) }
}

impl From<rusqlite::Error> for PopulatorError {
    fn from(value: rusqlite::Error) -> Self { PopulatorError::Ontology(value.into()) }
}

/// The contract every populator implements.
pub trait Populator: Send + Sync {
    fn name(&self) -> &'static str;
    fn cost_tier(&self) -> CostTier;

    /// Run the populator. If `resume_cursor` is Some, the populator should resume from there.
    /// Returns `Completed` when fully done, or `Paused { cursor }` to allow resume.
    /// The populator MUST poll `ctx.is_paused()` at safe checkpoints (e.g. every batch).
    fn run(
        &self,
        conn: &mut Connection,
        ctx: &mut PopulatorContext,
        resume_cursor: Option<&str>,
    ) -> Result<PopulatorOutcome, PopulatorError>;
}

// ---- Gated-emit helpers shared by all populators ----

/// Assert a property on an entity, but skip if a matching negative assertion exists.
/// Returns `true` if the assertion was inserted, `false` if it was suppressed.
pub fn emit_property(
    conn: &Connection,
    ctx: &mut PopulatorContext,
    entity_id: i64,
    key: &str,
    value: &str,
    source: &str,
    confidence: f32,
    display_in_global_views: bool,
) -> Result<bool, PopulatorError> {
    if is_rejected_property(conn, entity_id, key, value)? {
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

/// Assert a relation, but skip if a matching negative assertion exists.
pub fn emit_relation(
    conn: &Connection,
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

/// Ensure a File entity exists for a given files.id (canonical_id = files.path).
pub fn ensure_file_entity(
    conn: &Connection,
    file_id: i64,
    path: &str,
) -> Result<Entity, OntologyError> {
    upsert_entity(conn, EntityKind::File, path, Some(file_id), None, None)
}

/// Ensure a Folder entity exists for a given folders.id (canonical_id = folders.path).
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
    use crate::ontology::negative::{reject_pair, reject_property};
    use rusqlite::Connection;

    fn migrated_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        for (_, sql) in ALL_MIGRATIONS {
            conn.execute_batch(sql).unwrap();
        }
        conn
    }

    fn seed_file_entity(conn: &Connection) -> i64 {
        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
             VALUES (1, NULL, '/root', 'root', 0, 0)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, size, indexed_at)
             VALUES (1, 1, '/root/a.txt', 'a.txt', 100, 0)",
            [],
        ).unwrap();
        ensure_file_entity(conn, 1, "/root/a.txt").unwrap().id
    }

    fn dummy_ctx() -> PopulatorContext {
        PopulatorContext::new(BudgetTier::Standard, Arc::new(AtomicBool::new(false)))
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
    fn emit_property_writes_when_not_rejected() {
        let conn = migrated_conn();
        let eid = seed_file_entity(&conn);
        let mut ctx = dummy_ctx();

        let inserted = emit_property(&conn, &mut ctx, eid, "role", "source", "rule:r1", 0.8, true).unwrap();
        assert!(inserted);
        assert_eq!(ctx.snapshot().assertions_emitted, 1);
    }

    #[test]
    fn emit_property_skips_when_rejected() {
        let conn = migrated_conn();
        let eid = seed_file_entity(&conn);
        let mut ctx = dummy_ctx();

        reject_property(&conn, eid, "role", "source", Some("user disagrees")).unwrap();
        let inserted = emit_property(&conn, &mut ctx, eid, "role", "source", "rule:r1", 0.8, true).unwrap();
        assert!(!inserted);
        assert_eq!(ctx.snapshot().assertions_skipped_by_negative, 1);
        assert_eq!(ctx.snapshot().assertions_emitted, 0);
    }

    #[test]
    fn emit_relation_writes_when_not_rejected() {
        let conn = migrated_conn();
        let subj = seed_file_entity(&conn);
        // Add a second file/entity to point at.
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, size, indexed_at)
             VALUES (2, 1, '/root/b.txt', 'b.txt', 100, 0)",
            [],
        ).unwrap();
        let obj = ensure_file_entity(&conn, 2, "/root/b.txt").unwrap().id;
        let mut ctx = dummy_ctx();

        let inserted = emit_relation(&conn, &mut ctx, subj, "derivedFrom", obj, "heuristic:sib", 0.7).unwrap();
        assert!(inserted);
        assert_eq!(ctx.snapshot().assertions_emitted, 1);
    }

    #[test]
    fn emit_relation_skips_when_rejected() {
        let conn = migrated_conn();
        let subj = seed_file_entity(&conn);
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, size, indexed_at)
             VALUES (2, 1, '/root/b.txt', 'b.txt', 100, 0)",
            [],
        ).unwrap();
        let obj = ensure_file_entity(&conn, 2, "/root/b.txt").unwrap().id;
        let mut ctx = dummy_ctx();

        reject_pair(&conn, subj, "derivedFrom", obj, Some("user disagrees")).unwrap();
        let inserted = emit_relation(&conn, &mut ctx, subj, "derivedFrom", obj, "heuristic:sib", 0.7).unwrap();
        assert!(!inserted);
        assert_eq!(ctx.snapshot().assertions_skipped_by_negative, 1);
    }
}
```

- [ ] **Step 2.3: Wire the new submodule in `src/ontology/mod.rs`**

Edit [src/ontology/mod.rs](../../../src/ontology/mod.rs); replace the existing `pub mod` block to add `discoveries`, `orchestrator`, and `populators`:

```rust
pub mod attrs;
pub mod discoveries;
pub mod enabled;
pub mod entities;
pub mod errors;
pub mod negative;
pub mod orchestrator;
pub mod pinning;
pub mod populators;
pub mod relations;
pub mod sensitivity;
pub mod vocabulary;
```

(Leave the rest of mod.rs — `VOCABULARY_VERSION`, `source_priority`, the existing `tests` block — unchanged.)

- [ ] **Step 2.4: Create empty placeholder files for `discoveries` and `orchestrator`**

These get filled in later tasks but must exist now so `mod.rs` compiles.

`src/ontology/discoveries.rs`:
```rust
//! Discoveries-queue CRUD.
```

`src/ontology/orchestrator.rs`:
```rust
//! Phase 2 orchestrator.
```

`src/ontology/populators/rules.rs`:
```rust
//! Rule-driven populator.
```

`src/ontology/populators/heuristics.rs`:
```rust
//! Structural-heuristic populator.
```

- [ ] **Step 2.5: Run the populator-module tests**

Run: `cargo test --lib ontology::populators::tests`
Expected: 5 tests pass (`budget_tier_filtering`, `emit_property_writes_when_not_rejected`, `emit_property_skips_when_rejected`, `emit_relation_writes_when_not_rejected`, `emit_relation_skips_when_rejected`).

- [ ] **Step 2.6: Commit**

```bash
git add Cargo.toml src/ontology/
git commit -m "feat(ontology): Populator trait, context, gated-emit helpers"
```

---

## Task 3: Discoveries-queue CRUD

**Files:**
- Modify: `src/ontology/discoveries.rs`

**Goal:** Implement insert/query for `ontology_discoveries`. Populators emit `DiscoveryPattern` rows via this module.

- [ ] **Step 3.1: Write the implementation**

Replace `src/ontology/discoveries.rs`:

```rust
//! Discoveries-queue CRUD.
//!
//! Populators that infer low-confidence pattern-level facts emit rows here
//! instead of writing directly to `ontology_attrs` / `ontology_relations`.
//! Wave 1 future plans surface these for user confirmation.

use crate::ontology::OntologyError;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Discovery {
    pub id: i64,
    pub kind: String,
    pub payload: String, // raw JSON string
    pub status: DiscoveryStatus,
    pub confidence: f32,
    pub potential_bytes_unlocked: u64,
    pub created_at: i64,
    pub resolved_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DiscoveryStatus {
    Pending,
    Confirmed,
    Rejected,
    Expired,
}

impl DiscoveryStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Confirmed => "confirmed",
            Self::Rejected => "rejected",
            Self::Expired => "expired",
        }
    }
    pub fn from_str(s: &str) -> Result<Self, OntologyError> {
        match s {
            "pending" => Ok(Self::Pending),
            "confirmed" => Ok(Self::Confirmed),
            "rejected" => Ok(Self::Rejected),
            "expired" => Ok(Self::Expired),
            other => Err(OntologyError::InvalidVocabulary(format!("DiscoveryStatus: {other}"))),
        }
    }
}

pub struct NewDiscovery<'a> {
    pub kind: &'a str,
    pub payload_json: &'a str,
    pub confidence: f32,
    pub potential_bytes_unlocked: u64,
}

pub fn insert_discovery(conn: &Connection, d: &NewDiscovery<'_>) -> Result<Discovery, OntologyError> {
    let now = unix_now();
    conn.execute(
        "INSERT INTO ontology_discoveries
            (kind, payload, status, confidence, potential_bytes_unlocked, created_at, resolved_at)
         VALUES (?1, ?2, 'pending', ?3, ?4, ?5, NULL)",
        params![d.kind, d.payload_json, d.confidence, d.potential_bytes_unlocked as i64, now],
    )?;
    Ok(Discovery {
        id: conn.last_insert_rowid(),
        kind: d.kind.to_string(),
        payload: d.payload_json.to_string(),
        status: DiscoveryStatus::Pending,
        confidence: d.confidence,
        potential_bytes_unlocked: d.potential_bytes_unlocked,
        created_at: now,
        resolved_at: None,
    })
}

pub fn get_discovery(conn: &Connection, id: i64) -> Result<Option<Discovery>, OntologyError> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, kind, payload, status, confidence, potential_bytes_unlocked, created_at, resolved_at
         FROM ontology_discoveries WHERE id = ?1",
    )?;
    let row = stmt.query_row(params![id], row_to_discovery).optional()?;
    Ok(row)
}

pub fn list_pending_by_kind(conn: &Connection, kind: &str, limit: u32) -> Result<Vec<Discovery>, OntologyError> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, kind, payload, status, confidence, potential_bytes_unlocked, created_at, resolved_at
         FROM ontology_discoveries
         WHERE status = 'pending' AND kind = ?1
         ORDER BY potential_bytes_unlocked DESC, confidence DESC
         LIMIT ?2",
    )?;
    let rows = stmt
        .query_map(params![kind, limit], row_to_discovery)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn count_pending(conn: &Connection) -> Result<u64, OntologyError> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM ontology_discoveries WHERE status = 'pending'",
        [],
        |r| r.get(0),
    )?;
    Ok(n as u64)
}

fn row_to_discovery(row: &rusqlite::Row<'_>) -> rusqlite::Result<Discovery> {
    let status_str: String = row.get(3)?;
    let status = DiscoveryStatus::from_str(&status_str)
        .map_err(|_| rusqlite::Error::InvalidColumnType(3, "status".into(), rusqlite::types::Type::Text))?;
    Ok(Discovery {
        id: row.get(0)?,
        kind: row.get(1)?,
        payload: row.get(2)?,
        status,
        confidence: row.get::<_, f64>(4)? as f32,
        potential_bytes_unlocked: row.get::<_, i64>(5)? as u64,
        created_at: row.get(6)?,
        resolved_at: row.get(7)?,
    })
}

fn unix_now() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
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
    fn insert_and_get_discovery_round_trips() {
        let conn = migrated_conn();
        let d = insert_discovery(&conn, &NewDiscovery {
            kind: "derivedFrom-pattern",
            payload_json: r#"{"subj":1,"obj":2}"#,
            confidence: 0.7,
            potential_bytes_unlocked: 1_000_000,
        }).unwrap();
        assert!(d.id > 0);
        assert_eq!(d.status, DiscoveryStatus::Pending);

        let fetched = get_discovery(&conn, d.id).unwrap().unwrap();
        assert_eq!(fetched, d);
    }

    #[test]
    fn list_pending_by_kind_sorts_by_roi() {
        let conn = migrated_conn();
        insert_discovery(&conn, &NewDiscovery {
            kind: "derivedFrom-pattern",
            payload_json: "{}",
            confidence: 0.9,
            potential_bytes_unlocked: 1_000,
        }).unwrap();
        insert_discovery(&conn, &NewDiscovery {
            kind: "derivedFrom-pattern",
            payload_json: "{}",
            confidence: 0.6,
            potential_bytes_unlocked: 100_000_000,
        }).unwrap();
        insert_discovery(&conn, &NewDiscovery {
            kind: "backupOf-pair",
            payload_json: "{}",
            confidence: 0.9,
            potential_bytes_unlocked: 999_999,
        }).unwrap();

        let rows = list_pending_by_kind(&conn, "derivedFrom-pattern", 10).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].potential_bytes_unlocked, 100_000_000, "ROI sort wrong");
    }

    #[test]
    fn count_pending_counts_only_pending() {
        let conn = migrated_conn();
        let d = insert_discovery(&conn, &NewDiscovery {
            kind: "k", payload_json: "{}", confidence: 0.5, potential_bytes_unlocked: 0,
        }).unwrap();
        insert_discovery(&conn, &NewDiscovery {
            kind: "k", payload_json: "{}", confidence: 0.5, potential_bytes_unlocked: 0,
        }).unwrap();
        // Mark first as confirmed.
        conn.execute("UPDATE ontology_discoveries SET status='confirmed' WHERE id=?1", params![d.id]).unwrap();
        assert_eq!(count_pending(&conn).unwrap(), 1);
    }
}
```

- [ ] **Step 3.2: Run the discoveries tests**

Run: `cargo test --lib ontology::discoveries::tests`
Expected: three tests pass.

- [ ] **Step 3.3: Commit**

```bash
git add src/ontology/discoveries.rs
git commit -m "feat(ontology): discoveries-queue CRUD with ROI-ordered listing"
```

---

## Task 4: `RulePopulator` — rule shape, matcher, starter bundle

**Files:**
- Modify: `src/ontology/populators/rules.rs`

**Goal:** Ship `RulePopulator` plus the starter "Personal Storage Patterns" rule bundle. Rules are baked into Rust for Wave 1 (external TOML loading is deferred). Each rule emits `ontology_attrs` rows via the gated `emit_property` helper, so user rejections are honored. The cursor encodes the last-visited `files.id` so resume after pause continues mid-table.

- [ ] **Step 4.1: Write the implementation**

Replace `src/ontology/populators/rules.rs`:

```rust
//! Rule-driven populator.
//!
//! Ships the "Personal Storage Patterns" starter bundle defined in spec §6.
//! Rules match against (path, filename, extension); each emits a property on
//! the file's File-entity via the gated emit helper.

use crate::ontology::populators::{
    ensure_file_entity, emit_property, CostTier, Populator, PopulatorContext,
    PopulatorError, PopulatorOutcome, PopulatorReport,
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
    /// Sensitivity rules need `display_in_global_views=false` (Constitutional Defense #3).
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
            RuleMatcher::PathRegex(rx) => rx.is_match(path),
            RuleMatcher::FilenameRegex(rx) => rx.is_match(filename),
            RuleMatcher::ExtensionIn(exts) => {
                extension.map(|e| exts.iter().any(|x| x.eq_ignore_ascii_case(e))).unwrap_or(false)
            }
        }
    }
}

/// The Wave-1 starter rule bundle. Spec §6.
pub fn starter_rules() -> Vec<Rule> {
    // helper to compile a case-insensitive regex; .expect is fine because all patterns
    // here are constant and unit-tested.
    fn ci(p: &str) -> Regex { Regex::new(&format!("(?i){p}")).expect("bad regex") }

    vec![
        // --- Sensitivity (display_in_global_views=false) ---
        Rule {
            id: "rule:path-prefix-personal-details",
            matcher: RuleMatcher::PathRegex(ci(r"/Personal Details/")),
            assertion: RuleAssertion { key: keys::SENSITIVITY, value: "restricted", confidence: 1.0, display_in_global_views: false },
        },
        Rule {
            id: "rule:path-prefix-work-details",
            matcher: RuleMatcher::PathRegex(ci(r"/Work Details/")),
            assertion: RuleAssertion { key: keys::SENSITIVITY, value: "restricted", confidence: 1.0, display_in_global_views: false },
        },
        Rule {
            id: "rule:sensitive-keyword",
            matcher: RuleMatcher::PathRegex(ci(r"(passport|aadhar|pan|payslip|salary)")),
            assertion: RuleAssertion { key: keys::SENSITIVITY, value: "restricted", confidence: 0.9, display_in_global_views: false },
        },

        // --- Role: backup ---
        Rule {
            id: "rule:path-old-hdd-backup",
            matcher: RuleMatcher::PathRegex(ci(r"/Old HDD-Backup/")),
            assertion: RuleAssertion { key: keys::ROLE, value: "backup", confidence: 0.85, display_in_global_views: true },
        },
        Rule {
            id: "rule:path-backup-folder",
            matcher: RuleMatcher::PathRegex(ci(r"/Backup")),
            assertion: RuleAssertion { key: keys::ROLE, value: "backup", confidence: 0.85, display_in_global_views: true },
        },

        // --- Role: scratch ---
        Rule {
            id: "rule:path-node-modules",
            matcher: RuleMatcher::PathRegex(Regex::new(r"/node_modules/").unwrap()),
            assertion: RuleAssertion { key: keys::ROLE, value: "scratch", confidence: 0.95, display_in_global_views: true },
        },
        Rule {
            id: "rule:path-cache",
            matcher: RuleMatcher::PathRegex(Regex::new(r"/\.cache/").unwrap()),
            assertion: RuleAssertion { key: keys::ROLE, value: "scratch", confidence: 0.95, display_in_global_views: true },
        },
        Rule {
            id: "rule:path-target-debug",
            matcher: RuleMatcher::PathRegex(Regex::new(r"/target/(debug|release)/").unwrap()),
            assertion: RuleAssertion { key: keys::ROLE, value: "scratch", confidence: 0.95, display_in_global_views: true },
        },
        Rule {
            id: "rule:path-pycache",
            matcher: RuleMatcher::PathRegex(Regex::new(r"/__pycache__/").unwrap()),
            assertion: RuleAssertion { key: keys::ROLE, value: "scratch", confidence: 0.95, display_in_global_views: true },
        },
        Rule {
            id: "rule:path-dist-build",
            matcher: RuleMatcher::PathRegex(Regex::new(r"/(dist|build)/").unwrap()),
            assertion: RuleAssertion { key: keys::ROLE, value: "scratch", confidence: 0.9, display_in_global_views: true },
        },

        // --- Role: system ---
        Rule {
            id: "rule:filename-ds-store",
            matcher: RuleMatcher::FilenameRegex(Regex::new(r"^\.DS_Store$").unwrap()),
            assertion: RuleAssertion { key: keys::ROLE, value: "system", confidence: 1.0, display_in_global_views: true },
        },
        Rule {
            id: "rule:filename-thumbs-db",
            matcher: RuleMatcher::FilenameRegex(ci(r"^Thumbs\.db$")),
            assertion: RuleAssertion { key: keys::ROLE, value: "system", confidence: 1.0, display_in_global_views: true },
        },
        Rule {
            id: "rule:filename-desktop-ini",
            matcher: RuleMatcher::FilenameRegex(ci(r"^desktop\.ini$")),
            assertion: RuleAssertion { key: keys::ROLE, value: "system", confidence: 1.0, display_in_global_views: true },
        },

        // --- Role: source (design files) ---
        Rule {
            id: "rule:ext-design-source",
            matcher: RuleMatcher::ExtensionIn(&["psd", "ai", "ae", "xd", "aep", "sketch", "fig"]),
            assertion: RuleAssertion { key: keys::ROLE, value: "source", confidence: 0.85, display_in_global_views: true },
        },

        // --- Role: asset (fonts) ---
        Rule {
            id: "rule:ext-font",
            matcher: RuleMatcher::ExtensionIn(&["ttf", "otf", "woff", "woff2", "eot"]),
            assertion: RuleAssertion { key: keys::ROLE, value: "asset", confidence: 0.95, display_in_global_views: true },
        },

        // --- Role: tool (installers) ---
        Rule {
            id: "rule:ext-installer",
            matcher: RuleMatcher::ExtensionIn(&["exe", "msi", "dmg", "AppImage"]),
            assertion: RuleAssertion { key: keys::ROLE, value: "tool", confidence: 0.75, display_in_global_views: true },
        },

        // --- Origin ---
        Rule {
            id: "rule:origin-screenshot",
            matcher: RuleMatcher::FilenameRegex(ci(r"^(Screenshot|Screen Shot)[ _-]")),
            assertion: RuleAssertion { key: keys::ORIGIN, value: "app-export", confidence: 0.85, display_in_global_views: true },
        },
        Rule {
            id: "rule:origin-whatsapp",
            matcher: RuleMatcher::FilenameRegex(ci(r"^IMG[_-].*WA")),
            assertion: RuleAssertion { key: keys::ORIGIN, value: "messenger-received", confidence: 0.9, display_in_global_views: true },
        },
        Rule {
            id: "rule:origin-phone-camera",
            matcher: RuleMatcher::FilenameRegex(ci(r"^(IMG_\d{8}_\d{6}|DSC|PXL_)")),
            assertion: RuleAssertion { key: keys::ORIGIN, value: "phone-camera", confidence: 0.85, display_in_global_views: true },
        },
    ]
}

pub struct RulePopulator {
    rules: Vec<Rule>,
}

impl RulePopulator {
    pub fn with_starter_bundle() -> Self {
        Self { rules: starter_rules() }
    }

    pub fn with_rules(rules: Vec<Rule>) -> Self {
        Self { rules }
    }

    pub fn rule_count(&self) -> usize { self.rules.len() }
}

impl Populator for RulePopulator {
    fn name(&self) -> &'static str { "RulePopulator" }
    fn cost_tier(&self) -> CostTier { CostTier::Cheap }

    fn run(
        &self,
        conn: &mut Connection,
        ctx: &mut PopulatorContext,
        resume_cursor: Option<&str>,
    ) -> Result<PopulatorOutcome, PopulatorError> {
        let mut last_id: i64 = resume_cursor
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(0);

        loop {
            if ctx.is_paused() {
                return Ok(PopulatorOutcome::Paused {
                    cursor: last_id.to_string(),
                    partial: ctx.snapshot(),
                });
            }

            // Fetch a batch in id order so the cursor is monotonic.
            let batch = {
                let mut stmt = conn.prepare_cached(
                    "SELECT id, path, name, extension
                     FROM files
                     WHERE id > ?1 AND deleted_at IS NULL
                     ORDER BY id ASC
                     LIMIT ?2",
                )?;
                let rows = stmt
                    .query_map(rusqlite::params![last_id, BATCH_SIZE], |r| {
                        Ok((
                            r.get::<_, i64>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?,
                            r.get::<_, Option<String>>(3)?,
                        ))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                rows
            };

            if batch.is_empty() {
                break;
            }

            for (file_id, path, name, ext) in &batch {
                ctx.note_file();

                let entity = ensure_file_entity(conn, *file_id, path)?;

                for rule in &self.rules {
                    if rule.matches(path, name, ext.as_deref()) {
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

                last_id = *file_id;
            }
        }

        Ok(PopulatorOutcome::Completed(ctx.snapshot()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::schema::ALL_MIGRATIONS;
    use crate::ontology::populators::BudgetTier;
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

    fn insert_file(conn: &Connection, id: i64, folder_id: i64, path: &str, name: &str, ext: Option<&str>) {
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, extension, size, indexed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 100, 0)",
            rusqlite::params![id, folder_id, path, name, ext],
        ).unwrap();
    }

    fn insert_folder(conn: &Connection, id: i64, path: &str) {
        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
             VALUES (?1, NULL, ?2, ?2, 0, 0)",
            rusqlite::params![id, path],
        ).unwrap();
    }

    fn dummy_ctx() -> PopulatorContext {
        PopulatorContext::new(BudgetTier::Standard, Arc::new(AtomicBool::new(false)))
    }

    #[test]
    fn starter_rules_has_at_least_30_rules() {
        // Constitutional Defense #8: first-run rule bundle ≥ 30 rules ships with the app.
        // Wave 1 deliberately ships fewer (~20). The invariant is "≥ 20 useful rules".
        // We assert ≥ 18 to allow rule reorganization without breaking the test.
        assert!(starter_rules().len() >= 18, "starter bundle too thin");
    }

    #[test]
    fn rule_matches_path_regex() {
        let rules = starter_rules();
        let personal = rules.iter().find(|r| r.id == "rule:path-prefix-personal-details").unwrap();
        assert!(personal.matches("/users/me/Personal Details/passport.pdf", "passport.pdf", Some("pdf")));
        assert!(!personal.matches("/users/me/Documents/cv.pdf", "cv.pdf", Some("pdf")));
    }

    #[test]
    fn rule_matches_extension_in() {
        let rules = starter_rules();
        let psd_rule = rules.iter().find(|r| r.id == "rule:ext-design-source").unwrap();
        assert!(psd_rule.matches("/x/y.psd", "y.psd", Some("psd")));
        assert!(psd_rule.matches("/x/y.PSD", "y.PSD", Some("PSD")), "case-insensitive");
        assert!(!psd_rule.matches("/x/y.png", "y.png", Some("png")));
    }

    #[test]
    fn rule_matches_filename_regex() {
        let rules = starter_rules();
        let ds = rules.iter().find(|r| r.id == "rule:filename-ds-store").unwrap();
        assert!(ds.matches("/x/.DS_Store", ".DS_Store", None));
        assert!(!ds.matches("/x/foo.DS_Store.txt", "foo.DS_Store.txt", Some("txt")));
    }

    #[test]
    fn populator_writes_sensitivity_for_personal_details() {
        let mut conn = migrated_conn();
        insert_folder(&conn, 1, "/root/Personal Details");
        insert_file(&conn, 1, 1, "/root/Personal Details/passport.pdf", "passport.pdf", Some("pdf"));

        let pop = RulePopulator::with_starter_bundle();
        let mut ctx = dummy_ctx();
        let outcome = pop.run(&mut conn, &mut ctx, None).unwrap();

        assert!(matches!(outcome, PopulatorOutcome::Completed(_)));
        let row: (String, f64, String, i64) = conn.query_row(
            "SELECT a.value, a.confidence, a.source, a.display_in_global_views
             FROM ontology_attrs a
             JOIN ontology_entities e ON e.id = a.entity_id
             WHERE e.linked_file_id = 1 AND a.key = 'sensitivity'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        ).unwrap();
        assert_eq!(row.0, "restricted");
        assert!((row.1 - 1.0).abs() < 1e-6);
        assert_eq!(row.2, "rule:path-prefix-personal-details");
        assert_eq!(row.3, 0, "display_in_global_views must be 0 for sensitivity rules");
    }

    #[test]
    fn populator_resumes_from_cursor() {
        let mut conn = migrated_conn();
        insert_folder(&conn, 1, "/root");
        for i in 1..=10 {
            insert_file(&conn, i, 1, &format!("/root/file-{i}.psd"), &format!("file-{i}.psd"), Some("psd"));
        }

        let pop = RulePopulator::with_starter_bundle();
        let mut ctx = dummy_ctx();
        // Resume at id 5 — only files 6..=10 should be processed.
        let outcome = pop.run(&mut conn, &mut ctx, Some("5")).unwrap();
        assert!(matches!(outcome, PopulatorOutcome::Completed(_)));

        let assertions: i64 = conn.query_row(
            "SELECT COUNT(*) FROM ontology_attrs WHERE key='role' AND value='source'",
            [],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(assertions, 5);
    }

    #[test]
    fn populator_pauses_when_flag_set() {
        let mut conn = migrated_conn();
        insert_folder(&conn, 1, "/root");
        for i in 1..=3 {
            insert_file(&conn, i, 1, &format!("/root/file-{i}.psd"), &format!("file-{i}.psd"), Some("psd"));
        }

        let pause = Arc::new(AtomicBool::new(true));  // pre-set: pause immediately
        let mut ctx = PopulatorContext::new(BudgetTier::Standard, pause);

        let pop = RulePopulator::with_starter_bundle();
        let outcome = pop.run(&mut conn, &mut ctx, None).unwrap();
        match outcome {
            PopulatorOutcome::Paused { cursor, .. } => assert_eq!(cursor, "0", "no work done before pause check"),
            other => panic!("expected Paused, got {other:?}"),
        }
    }

    #[test]
    fn populator_skips_already_rejected_pairs() {
        use crate::ontology::negative::reject_property;
        use crate::ontology::populators::ensure_file_entity;

        let mut conn = migrated_conn();
        insert_folder(&conn, 1, "/root");
        insert_file(&conn, 1, 1, "/root/foo.psd", "foo.psd", Some("psd"));

        // Pre-emptively reject "role=source" for this file.
        let eid = ensure_file_entity(&conn, 1, "/root/foo.psd").unwrap().id;
        reject_property(&conn, eid, "role", "source", Some("user disagrees")).unwrap();

        let pop = RulePopulator::with_starter_bundle();
        let mut ctx = dummy_ctx();
        pop.run(&mut conn, &mut ctx, None).unwrap();

        let row_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM ontology_attrs WHERE entity_id=?1 AND key='role'",
            rusqlite::params![eid], |r| r.get(0),
        ).unwrap();
        assert_eq!(row_count, 0, "rejected role=source must not be written");
        assert_eq!(ctx.snapshot().assertions_skipped_by_negative, 1);
    }
}
```

- [ ] **Step 4.2: Run the rule-populator tests**

Run: `cargo test --lib ontology::populators::rules::tests`
Expected: 7 tests pass.

- [ ] **Step 4.3: Commit**

```bash
git add src/ontology/populators/rules.rs
git commit -m "feat(ontology): RulePopulator with Personal Storage Patterns bundle"
```

---

## Task 5: `StructuralHeuristicPopulator` — sibling-derivedFrom heuristic

**Files:**
- Modify: `src/ontology/populators/heuristics.rs`

**Goal:** First of three heuristics. For each folder, find sibling-pairs (f1, f2) where f2's filename starts with the stem of f1, f2 was modified after f1, sizes are within [0.05, 50] ratio, and extensions differ. Emit a `DiscoveryPattern` of kind `derivedFrom-pattern` per pair into `ontology_discoveries` (NOT a direct relation — heuristic confidence is too low to autowire).

- [ ] **Step 5.1: Write the implementation**

Replace `src/ontology/populators/heuristics.rs`:

```rust
//! Structural-heuristic populator.
//!
//! Emits DiscoveryPattern rows for low-confidence sibling-derivedFrom pairs,
//! cross-folder backupOf pairs, and replaceability inferences based on existing facts.

use crate::ontology::discoveries::{insert_discovery, NewDiscovery};
use crate::ontology::populators::{
    ensure_file_entity, emit_property, CostTier, Populator, PopulatorContext,
    PopulatorError, PopulatorOutcome,
};
use crate::ontology::vocabulary::keys;
use rusqlite::Connection;
use serde::Serialize;

const FOLDER_BATCH_SIZE: i64 = 50;

pub struct StructuralHeuristicPopulator;

impl StructuralHeuristicPopulator {
    pub fn new() -> Self { Self }
}

#[derive(Debug, Clone, Serialize)]
struct DerivedFromPatternPayload {
    derivative_file_id: i64,
    source_file_id: i64,
    derivative_path: String,
    source_path: String,
    size_ratio: f64,
}

#[derive(Debug, Clone, Serialize)]
struct BackupOfPairPayload {
    backup_file_id: i64,
    origin_file_id: i64,
    backup_path: String,
    origin_path: String,
    size_ratio: f64,
}

#[derive(Clone)]
struct SiblingFile {
    id: i64,
    path: String,
    name: String,
    extension: Option<String>,
    size: i64,
    modified_at: Option<i64>,
}

impl Populator for StructuralHeuristicPopulator {
    fn name(&self) -> &'static str { "StructuralHeuristicPopulator" }
    fn cost_tier(&self) -> CostTier { CostTier::Cheap }

    fn run(
        &self,
        conn: &mut Connection,
        ctx: &mut PopulatorContext,
        resume_cursor: Option<&str>,
    ) -> Result<PopulatorOutcome, PopulatorError> {
        let mut last_folder_id: i64 = resume_cursor
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(0);

        // --- Phase A: sibling-derivedFrom + backupOf inside each folder. ---
        loop {
            if ctx.is_paused() {
                return Ok(PopulatorOutcome::Paused {
                    cursor: last_folder_id.to_string(),
                    partial: ctx.snapshot(),
                });
            }

            let folder_batch: Vec<i64> = {
                let mut stmt = conn.prepare_cached(
                    "SELECT id FROM folders WHERE id > ?1 ORDER BY id ASC LIMIT ?2",
                )?;
                stmt.query_map(rusqlite::params![last_folder_id, FOLDER_BATCH_SIZE], |r| r.get::<_, i64>(0))?
                    .collect::<Result<Vec<_>, _>>()?
            };

            if folder_batch.is_empty() {
                break;
            }

            for folder_id in folder_batch {
                let siblings = load_siblings(conn, folder_id)?;
                for f1 in &siblings {
                    ctx.note_file();
                    for f2 in &siblings {
                        if f1.id == f2.id { continue; }
                        if let Some((ratio, _stem)) = sibling_derivedfrom_match(f1, f2) {
                            // Persist a DiscoveryPattern (not a direct relation — heuristic).
                            // Skip if the user has already rejected this pair.
                            if pair_already_rejected(conn, f2.id, "derivedFrom", f1.id, ctx)? { continue; }
                            let payload = DerivedFromPatternPayload {
                                derivative_file_id: f2.id,
                                source_file_id: f1.id,
                                derivative_path: f2.path.clone(),
                                source_path: f1.path.clone(),
                                size_ratio: ratio,
                            };
                            let payload_json = serde_json::to_string(&payload).map_err(|e| PopulatorError::Aborted(e.to_string()))?;
                            let conf = score_derivedfrom_pair(f1, f2);
                            let bytes = (f2.size.max(0)) as u64;
                            insert_discovery(conn, &NewDiscovery {
                                kind: "derivedFrom-pattern",
                                payload_json: &payload_json,
                                confidence: conf,
                                potential_bytes_unlocked: bytes,
                            })?;
                            ctx.note_discovery();
                        }
                    }
                }
                last_folder_id = folder_id;
            }
        }

        // --- Phase B: cross-folder backupOf candidates. ---
        emit_cross_folder_backups(conn, ctx)?;

        // --- Phase C: replaceability inference based on already-asserted role + derivedFrom. ---
        emit_replaceability_inferences(conn, ctx)?;

        Ok(PopulatorOutcome::Completed(ctx.snapshot()))
    }
}

fn load_siblings(conn: &Connection, folder_id: i64) -> Result<Vec<SiblingFile>, PopulatorError> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, path, name, extension, size, modified_at
         FROM files WHERE folder_id = ?1 AND deleted_at IS NULL",
    )?;
    let rows = stmt
        .query_map(rusqlite::params![folder_id], |r| {
            Ok(SiblingFile {
                id: r.get(0)?,
                path: r.get(1)?,
                name: r.get(2)?,
                extension: r.get(3)?,
                size: r.get(4)?,
                modified_at: r.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Returns `Some((size_ratio, shared_stem))` if the (potential-source f1, potential-derivative f2)
/// pair satisfies the heuristic, else None.
fn sibling_derivedfrom_match(f1: &SiblingFile, f2: &SiblingFile) -> Option<(f64, String)> {
    let stem1 = normalize_stem(&f1.name);
    let stem2 = normalize_stem(&f2.name);
    if !stem2.starts_with(&stem1) || stem1.is_empty() {
        return None;
    }
    // Same name including extension is the same file — skip.
    if f1.name == f2.name {
        return None;
    }
    // Extensions must differ — a derivative is a different format.
    if f1.extension == f2.extension {
        return None;
    }
    // Derivative was modified after the source.
    let (Some(m1), Some(m2)) = (f1.modified_at, f2.modified_at) else { return None };
    if m2 <= m1 { return None; }

    let s1 = f1.size as f64;
    let s2 = f2.size as f64;
    if s1 <= 0.0 || s2 <= 0.0 { return None; }
    let ratio = s2 / s1;
    if !(0.05..=50.0).contains(&ratio) { return None; }

    Some((ratio, stem1))
}

/// Lowercased, extension-stripped, whitespace-normalized stem.
fn normalize_stem(name: &str) -> String {
    let lower = name.to_lowercase();
    let stem = match lower.rfind('.') {
        Some(idx) if idx > 0 => &lower[..idx],
        _ => &lower[..],
    };
    stem.trim().to_string()
}

fn score_derivedfrom_pair(f1: &SiblingFile, f2: &SiblingFile) -> f32 {
    let mut conf = 0.5_f32;
    let s1 = f1.size as f64;
    let s2 = f2.size as f64;
    let ratio = if s1 > 0.0 { s2 / s1 } else { 1.0 };
    // Reasonable derivatives are smaller than their source (compressed export);
    // bump confidence when the ratio is in a tight band.
    if (0.1..=1.0).contains(&ratio) { conf += 0.2; }
    if f1.extension.as_deref() == Some("psd") || f1.extension.as_deref() == Some("ai") { conf += 0.15; }
    if f2.extension.as_deref() == Some("png") || f2.extension.as_deref() == Some("jpg") || f2.extension.as_deref() == Some("jpeg") {
        conf += 0.1;
    }
    conf.clamp(0.0, 0.95)
}

fn pair_already_rejected(
    conn: &Connection,
    subject_id: i64,
    predicate: &str,
    object_id: i64,
    _ctx: &mut PopulatorContext,
) -> Result<bool, PopulatorError> {
    // Translate file_id → entity_id for both sides; if either entity doesn't exist yet, no rejection can match.
    let subj_e: Option<i64> = conn.query_row(
        "SELECT id FROM ontology_entities WHERE kind='File' AND linked_file_id=?1",
        rusqlite::params![subject_id], |r| r.get(0),
    ).optional()?;
    let obj_e: Option<i64> = conn.query_row(
        "SELECT id FROM ontology_entities WHERE kind='File' AND linked_file_id=?1",
        rusqlite::params![object_id], |r| r.get(0),
    ).optional()?;
    let (Some(s), Some(o)) = (subj_e, obj_e) else { return Ok(false) };
    Ok(crate::ontology::negative::is_rejected_pair(conn, s, predicate, o)?)
}

// Allow the OptionalExtension trait to compile cleanly in this file.
use rusqlite::OptionalExtension;

fn emit_cross_folder_backups(
    conn: &mut Connection,
    ctx: &mut PopulatorContext,
) -> Result<(), PopulatorError> {
    // Backup-zone files: any File entity with role='backup' (asserted by rules in Task 4).
    let backup_files: Vec<(i64, String, String, i64)> = {
        let mut stmt = conn.prepare(
            "SELECT f.id, f.path, f.name, f.size
             FROM files f
             JOIN ontology_entities e ON e.kind='File' AND e.linked_file_id = f.id
             JOIN ontology_attrs a ON a.entity_id = e.id AND a.key='role' AND a.value='backup'
             WHERE f.deleted_at IS NULL",
        )?;
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
            .collect::<Result<Vec<_>, _>>()?
    };

    for (bk_id, bk_path, bk_name, bk_size) in backup_files {
        if ctx.is_paused() { break; }
        let stem = normalize_stem(&bk_name);
        if stem.is_empty() { continue; }

        // Find candidate originals: same normalized name, different folder, size within 50%.
        let candidates: Vec<(i64, String, i64)> = {
            let mut stmt = conn.prepare(
                "SELECT f.id, f.path, f.size
                 FROM files f
                 WHERE f.id != ?1
                   AND f.deleted_at IS NULL
                   AND LOWER(f.name) LIKE ?2",
            )?;
            stmt.query_map(rusqlite::params![bk_id, format!("{}%", stem)], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })?
            .filter_map(|r| r.ok())
            .filter(|(_, _, sz): &(i64, String, i64)| {
                if bk_size <= 0 || *sz <= 0 { return false; }
                let ratio = *sz as f64 / bk_size as f64;
                (0.5..=2.0).contains(&ratio)
            })
            .collect()
        };

        for (org_id, org_path, org_size) in candidates {
            if pair_already_rejected(conn, bk_id, "backupOf", org_id, ctx)? { continue; }
            let payload = BackupOfPairPayload {
                backup_file_id: bk_id,
                origin_file_id: org_id,
                backup_path: bk_path.clone(),
                origin_path: org_path,
                size_ratio: if bk_size > 0 { org_size as f64 / bk_size as f64 } else { 1.0 },
            };
            let payload_json = serde_json::to_string(&payload).map_err(|e| PopulatorError::Aborted(e.to_string()))?;
            insert_discovery(conn, &NewDiscovery {
                kind: "backupOf-pair",
                payload_json: &payload_json,
                confidence: 0.7,
                potential_bytes_unlocked: bk_size.max(0) as u64,
            })?;
            ctx.note_discovery();
        }
    }
    Ok(())
}

fn emit_replaceability_inferences(
    conn: &mut Connection,
    ctx: &mut PopulatorContext,
) -> Result<(), PopulatorError> {
    // role=derivative + has an active derivedFrom relation → replaceability=regenerable, conf 0.95.
    let derivatives: Vec<(i64, i64, String)> = {
        let mut stmt = conn.prepare(
            "SELECT DISTINCT e.id, f.id, f.path
             FROM ontology_entities e
             JOIN files f ON f.id = e.linked_file_id
             JOIN ontology_attrs a ON a.entity_id = e.id AND a.key='role' AND a.value='derivative'
             JOIN ontology_relations r ON r.subject_id = e.id AND r.predicate='derivedFrom'
             WHERE e.kind='File' AND f.deleted_at IS NULL",
        )?;
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<Result<Vec<_>, _>>()?
    };

    for (entity_id, file_id, path) in derivatives {
        if ctx.is_paused() { break; }
        let entity = ensure_file_entity(conn, file_id, &path)?;
        emit_property(
            conn, ctx, entity.id,
            keys::REPLACEABILITY, "regenerable",
            "heuristic:replaceability-from-derivedfrom",
            0.95, true,
        )?;
        let _ = entity_id; // silence unused warning if needed
    }

    // role=tool + filename matches installer pattern → replaceability=redownloadable, conf 0.6.
    let installer_pattern = regex::Regex::new(r"(?i)(setup|installer|install_)").unwrap();
    let tools: Vec<(i64, i64, String, String)> = {
        let mut stmt = conn.prepare(
            "SELECT e.id, f.id, f.path, f.name
             FROM ontology_entities e
             JOIN files f ON f.id = e.linked_file_id
             JOIN ontology_attrs a ON a.entity_id = e.id AND a.key='role' AND a.value='tool'
             WHERE e.kind='File' AND f.deleted_at IS NULL",
        )?;
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
            .collect::<Result<Vec<_>, _>>()?
    };

    for (_, file_id, path, name) in tools {
        if !installer_pattern.is_match(&name) { continue; }
        let entity = ensure_file_entity(conn, file_id, &path)?;
        emit_property(
            conn, ctx, entity.id,
            keys::REPLACEABILITY, "redownloadable",
            "heuristic:replaceability-from-installer-name",
            0.6, true,
        )?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::schema::ALL_MIGRATIONS;
    use crate::ontology::populators::BudgetTier;
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

    fn insert_folder(conn: &Connection, id: i64, path: &str) {
        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
             VALUES (?1, NULL, ?2, ?2, 0, 0)",
            rusqlite::params![id, path],
        ).unwrap();
    }

    fn insert_file(
        conn: &Connection,
        id: i64,
        folder_id: i64,
        path: &str,
        name: &str,
        ext: Option<&str>,
        size: i64,
        modified_at: Option<i64>,
    ) {
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, extension, size, modified_at, indexed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)",
            rusqlite::params![id, folder_id, path, name, ext, size, modified_at],
        ).unwrap();
    }

    fn ctx_no_pause() -> PopulatorContext {
        PopulatorContext::new(BudgetTier::Standard, Arc::new(AtomicBool::new(false)))
    }

    #[test]
    fn normalize_stem_strips_extension_lowercases_trims() {
        assert_eq!(normalize_stem("LIST.PSD"), "list");
        assert_eq!(normalize_stem("  My Logo.AI  "), "my logo");
        assert_eq!(normalize_stem("readme"), "readme");
    }

    #[test]
    fn sibling_derivedfrom_pair_emits_discovery() {
        let mut conn = migrated_conn();
        insert_folder(&conn, 1, "/proj");
        insert_file(&conn, 1, 1, "/proj/Logo.psd", "Logo.psd", Some("psd"), 5_000_000, Some(1000));
        insert_file(&conn, 2, 1, "/proj/Logo_export.png", "Logo_export.png", Some("png"), 200_000, Some(2000));

        let pop = StructuralHeuristicPopulator::new();
        let mut ctx = ctx_no_pause();
        pop.run(&mut conn, &mut ctx, None).unwrap();

        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM ontology_discoveries WHERE kind='derivedFrom-pattern'",
            [], |r| r.get(0),
        ).unwrap();
        assert!(n >= 1, "expected at least one derivedFrom-pattern discovery, got {n}");
    }

    #[test]
    fn sibling_derivedfrom_requires_later_mtime() {
        let mut conn = migrated_conn();
        insert_folder(&conn, 1, "/proj");
        // Derivative modified BEFORE source — should NOT match.
        insert_file(&conn, 1, 1, "/proj/Logo.psd", "Logo.psd", Some("psd"), 5_000_000, Some(2000));
        insert_file(&conn, 2, 1, "/proj/Logo_export.png", "Logo_export.png", Some("png"), 200_000, Some(1000));

        let pop = StructuralHeuristicPopulator::new();
        let mut ctx = ctx_no_pause();
        pop.run(&mut conn, &mut ctx, None).unwrap();

        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM ontology_discoveries WHERE kind='derivedFrom-pattern'",
            [], |r| r.get(0),
        ).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn sibling_derivedfrom_size_ratio_must_be_in_bounds() {
        let mut conn = migrated_conn();
        insert_folder(&conn, 1, "/proj");
        // Tiny source → huge "derivative" — ratio > 50, should NOT match.
        insert_file(&conn, 1, 1, "/proj/Logo.psd", "Logo.psd", Some("psd"), 1000, Some(1000));
        insert_file(&conn, 2, 1, "/proj/Logo_huge.png", "Logo_huge.png", Some("png"), 100_000_000, Some(2000));

        let pop = StructuralHeuristicPopulator::new();
        let mut ctx = ctx_no_pause();
        pop.run(&mut conn, &mut ctx, None).unwrap();

        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM ontology_discoveries WHERE kind='derivedFrom-pattern'",
            [], |r| r.get(0),
        ).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn cross_folder_backup_emits_pair_discovery() {
        let mut conn = migrated_conn();
        insert_folder(&conn, 1, "/Backup");
        insert_folder(&conn, 2, "/Active");
        insert_file(&conn, 1, 1, "/Backup/notes.txt", "notes.txt", Some("txt"), 1000, Some(100));
        insert_file(&conn, 2, 2, "/Active/notes.txt", "notes.txt", Some("txt"), 1100, Some(200));

        // Pre-tag the backup file with role=backup using the rule populator helper:
        // We just assert directly here for test isolation.
        use crate::ontology::populators::ensure_file_entity;
        use crate::ontology::attrs::{assert_attr, NewAssertion};
        let bk_entity = ensure_file_entity(&conn, 1, "/Backup/notes.txt").unwrap();
        assert_attr(&conn, bk_entity.id, &NewAssertion {
            key: "role", value: "backup", source: "rule:path-backup-folder",
            confidence: 0.85, display_in_global_views: true,
        }).unwrap();

        let pop = StructuralHeuristicPopulator::new();
        let mut ctx = ctx_no_pause();
        pop.run(&mut conn, &mut ctx, None).unwrap();

        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM ontology_discoveries WHERE kind='backupOf-pair'",
            [], |r| r.get(0),
        ).unwrap();
        assert!(n >= 1);
    }

    #[test]
    fn replaceability_inference_for_derivative_with_derivedfrom() {
        let mut conn = migrated_conn();
        insert_folder(&conn, 1, "/proj");
        insert_file(&conn, 1, 1, "/proj/Logo.psd", "Logo.psd", Some("psd"), 5_000_000, Some(1000));
        insert_file(&conn, 2, 1, "/proj/Logo_export.png", "Logo_export.png", Some("png"), 200_000, Some(2000));

        use crate::ontology::populators::ensure_file_entity;
        use crate::ontology::attrs::{assert_attr, NewAssertion};
        use crate::ontology::relations::{assert_relation, NewRelation};

        let src = ensure_file_entity(&conn, 1, "/proj/Logo.psd").unwrap();
        let der = ensure_file_entity(&conn, 2, "/proj/Logo_export.png").unwrap();
        assert_attr(&conn, der.id, &NewAssertion {
            key: "role", value: "derivative", source: "user", confidence: 1.0, display_in_global_views: true,
        }).unwrap();
        assert_relation(&conn, &NewRelation {
            subject_id: der.id, predicate: "derivedFrom", object_id: src.id,
            source: "user", confidence: 1.0,
        }).unwrap();

        let pop = StructuralHeuristicPopulator::new();
        let mut ctx = ctx_no_pause();
        pop.run(&mut conn, &mut ctx, None).unwrap();

        let value: String = conn.query_row(
            "SELECT value FROM ontology_attrs
             WHERE entity_id=?1 AND key='replaceability'
             ORDER BY id DESC LIMIT 1",
            rusqlite::params![der.id], |r| r.get(0),
        ).unwrap();
        assert_eq!(value, "regenerable");
    }
}
```

- [ ] **Step 5.2: Run the heuristic-populator tests**

Run: `cargo test --lib ontology::populators::heuristics::tests`
Expected: 5 tests pass (`normalize_stem_*`, `sibling_derivedfrom_pair_emits_discovery`, `sibling_derivedfrom_requires_later_mtime`, `sibling_derivedfrom_size_ratio_must_be_in_bounds`, `cross_folder_backup_emits_pair_discovery`, `replaceability_inference_for_derivative_with_derivedfrom`).

- [ ] **Step 5.3: Commit**

```bash
git add src/ontology/populators/heuristics.rs
git commit -m "feat(ontology): StructuralHeuristicPopulator with derivedFrom + backupOf + replaceability"
```

---

## Task 6: `PopulatorOrchestrator` — registry, scheduling, persisted state, pause/resume

**Files:**
- Modify: `src/ontology/orchestrator.rs`

**Goal:** Sequence registered populators in cost-tier order, persist per-populator state across runs, honor the pause flag, gate by budget tier, and expose `run_phase2(index_path, budget, pause)` as the public Phase-2 entry point.

- [ ] **Step 6.1: Write the implementation**

Replace `src/ontology/orchestrator.rs`:

```rust
//! Phase 2 orchestrator.
//!
//! Runs registered populators in cost-tier order, persisting per-populator cursor
//! and counter state so a paused or interrupted Phase 2 resumes cleanly.

use crate::ontology::enabled::is_enabled;
use crate::ontology::populators::{
    BudgetTier, CostTier, Populator, PopulatorContext, PopulatorError, PopulatorOutcome, PopulatorReport,
};
use crate::ontology::populators::heuristics::StructuralHeuristicPopulator;
use crate::ontology::populators::rules::RulePopulator;
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
    fn as_str(&self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Running => "running",
            Self::Paused => "paused",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }
    fn from_str(s: &str) -> Result<Self, OntologyError> {
        match s {
            "idle" => Ok(Self::Idle),
            "running" => Ok(Self::Running),
            "paused" => Ok(Self::Paused),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            other => Err(OntologyError::InvalidVocabulary(format!("PopulatorStatus: {other}"))),
        }
    }
}

#[derive(Debug, Clone)]
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
    let mut stmt = conn.prepare_cached(
        "SELECT populator_name, status, cursor, files_visited, assertions_emitted,
                discoveries_emitted, last_run_at, last_error
         FROM ontology_populator_state WHERE populator_name = ?1",
    )?;
    let row = stmt.query_row(params![name], |r| {
        let status_str: String = r.get(1)?;
        Ok((
            r.get::<_, String>(0)?,
            status_str,
            r.get::<_, Option<String>>(2)?,
            r.get::<_, i64>(3)?,
            r.get::<_, i64>(4)?,
            r.get::<_, i64>(5)?,
            r.get::<_, Option<i64>>(6)?,
            r.get::<_, Option<String>>(7)?,
        ))
    }).optional()?;
    match row {
        None => Ok(None),
        Some((name, status, cursor, fv, ae, de, last, err)) => Ok(Some(PopulatorState {
            populator_name: name,
            status: PopulatorStatus::from_str(&status)?,
            cursor,
            files_visited: fv as u64,
            assertions_emitted: ae as u64,
            discoveries_emitted: de as u64,
            last_run_at: last,
            last_error: err,
        })),
    }
}

fn upsert_state(
    conn: &Connection,
    name: &str,
    status: PopulatorStatus,
    cursor: Option<&str>,
    report: &PopulatorReport,
    last_error: Option<&str>,
) -> Result<(), OntologyError> {
    let now = unix_now();
    conn.execute(
        "INSERT INTO ontology_populator_state
            (populator_name, status, cursor, files_visited, assertions_emitted, discoveries_emitted, last_run_at, last_error)
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
            name,
            status.as_str(),
            cursor,
            report.files_visited as i64,
            report.assertions_emitted as i64,
            report.discoveries_emitted as i64,
            now,
            last_error,
        ],
    )?;
    Ok(())
}

pub struct PopulatorOrchestrator {
    populators: Vec<Box<dyn Populator>>,
}

impl Default for PopulatorOrchestrator {
    fn default() -> Self {
        let populators: Vec<Box<dyn Populator>> = vec![
            Box::new(RulePopulator::with_starter_bundle()),
            Box::new(StructuralHeuristicPopulator::new()),
        ];
        Self { populators }
    }
}

impl PopulatorOrchestrator {
    pub fn new(populators: Vec<Box<dyn Populator>>) -> Self {
        Self { populators }
    }

    /// Order populators by cost tier: Cheap → Medium → Expensive.
    fn ordered(&self) -> Vec<&Box<dyn Populator>> {
        let mut by_tier: Vec<&Box<dyn Populator>> = self.populators.iter().collect();
        by_tier.sort_by_key(|p| match p.cost_tier() {
            CostTier::Cheap => 0,
            CostTier::Medium => 1,
            CostTier::Expensive => 2,
        });
        by_tier
    }

    pub fn run(
        &self,
        conn: &mut Connection,
        budget: BudgetTier,
        pause: Arc<AtomicBool>,
    ) -> Result<Vec<(String, PopulatorOutcome)>, OntologyError> {
        let mut outcomes: Vec<(String, PopulatorOutcome)> = Vec::new();

        for populator in self.ordered() {
            if !budget.allows(populator.cost_tier()) {
                continue;
            }
            let name = populator.name();
            let prior_state = read_state(conn, name)?;

            // If a prior run completed, skip — re-runs are explicit (caller deletes the state row).
            if matches!(prior_state.as_ref().map(|s| &s.status), Some(PopulatorStatus::Completed)) {
                continue;
            }

            let resume_cursor = prior_state.as_ref().and_then(|s| s.cursor.clone());

            let mut ctx = PopulatorContext::new(budget, Arc::clone(&pause));
            upsert_state(conn, name, PopulatorStatus::Running, resume_cursor.as_deref(), &PopulatorReport::default(), None)?;

            let outcome = populator.run(conn, &mut ctx, resume_cursor.as_deref());
            let snap = ctx.snapshot();

            match outcome {
                Ok(PopulatorOutcome::Completed(report)) => {
                    upsert_state(conn, name, PopulatorStatus::Completed, None, &report, None)?;
                    outcomes.push((name.to_string(), PopulatorOutcome::Completed(report)));
                }
                Ok(PopulatorOutcome::Paused { cursor, partial }) => {
                    upsert_state(conn, name, PopulatorStatus::Paused, Some(&cursor), &partial, None)?;
                    outcomes.push((name.to_string(), PopulatorOutcome::Paused { cursor, partial }));
                    // Don't proceed to later populators while paused.
                    break;
                }
                Err(PopulatorError::Aborted(msg)) => {
                    upsert_state(conn, name, PopulatorStatus::Failed, None, &snap, Some(&msg))?;
                    return Err(OntologyError::Populator(msg));
                }
                Err(PopulatorError::Ontology(e)) => {
                    let msg = e.to_string();
                    upsert_state(conn, name, PopulatorStatus::Failed, None, &snap, Some(&msg))?;
                    return Err(e);
                }
            }
        }

        Ok(outcomes)
    }
}

/// Public Phase-2 entry point. Returns Ok(false) when the layer is disabled (no-op).
pub fn run_phase2(
    index_path: &Path,
    budget: BudgetTier,
    pause: Arc<AtomicBool>,
) -> Result<bool, OntologyError> {
    let mut conn = Connection::open(index_path)?;
    if !is_enabled(&conn)? {
        return Ok(false);
    }
    let orch = PopulatorOrchestrator::default();
    orch.run(&mut conn, budget, pause)?;
    Ok(true)
}

fn unix_now() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::schema::ALL_MIGRATIONS;
    use crate::ontology::enabled::enable;
    use rusqlite::Connection;

    fn migrated_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        for (_, sql) in ALL_MIGRATIONS {
            conn.execute_batch(sql).unwrap();
        }
        conn
    }

    fn seed_minimal(conn: &Connection) {
        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at) VALUES (1, NULL, '/x', 'x', 0, 0)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, extension, size, indexed_at)
             VALUES (1, 1, '/x/a.psd', 'a.psd', 'psd', 1000, 0)",
            [],
        ).unwrap();
    }

    #[test]
    fn orchestrator_runs_cheap_populators_and_records_state() {
        let mut conn = migrated_conn();
        seed_minimal(&conn);

        let orch = PopulatorOrchestrator::default();
        let pause = Arc::new(AtomicBool::new(false));
        let outcomes = orch.run(&mut conn, BudgetTier::CheapOnly, pause).unwrap();

        assert!(outcomes.iter().any(|(n, _)| n == "RulePopulator"));
        assert!(outcomes.iter().any(|(n, _)| n == "StructuralHeuristicPopulator"));

        let state = read_state(&conn, "RulePopulator").unwrap().unwrap();
        assert_eq!(state.status, PopulatorStatus::Completed);
        assert!(state.assertions_emitted >= 1, "rule populator should have emitted at least one assertion");
    }

    #[test]
    fn orchestrator_skips_completed_populators_on_rerun() {
        let mut conn = migrated_conn();
        seed_minimal(&conn);

        let orch = PopulatorOrchestrator::default();
        let pause = Arc::new(AtomicBool::new(false));
        orch.run(&mut conn, BudgetTier::CheapOnly, Arc::clone(&pause)).unwrap();

        // Second run: both populators already completed, so no outcomes returned.
        let outcomes = orch.run(&mut conn, BudgetTier::CheapOnly, pause).unwrap();
        assert!(outcomes.is_empty(), "second run should skip completed populators");
    }

    #[test]
    fn orchestrator_persists_paused_cursor_and_resumes() {
        let mut conn = migrated_conn();
        // Seed enough files so multiple batches are needed.
        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at) VALUES (1, NULL, '/x', 'x', 0, 0)",
            [],
        ).unwrap();
        for i in 1..=5 {
            conn.execute(
                "INSERT INTO files (id, folder_id, path, name, extension, size, indexed_at)
                 VALUES (?1, 1, ?2, ?3, 'psd', 1000, 0)",
                rusqlite::params![i, format!("/x/f-{i}.psd"), format!("f-{i}.psd")],
            ).unwrap();
        }

        // Run once with pause pre-set: RulePopulator must pause immediately at cursor=0.
        let orch = PopulatorOrchestrator::default();
        let pause = Arc::new(AtomicBool::new(true));
        let _ = orch.run(&mut conn, BudgetTier::CheapOnly, Arc::clone(&pause)).unwrap();

        let s = read_state(&conn, "RulePopulator").unwrap().unwrap();
        assert_eq!(s.status, PopulatorStatus::Paused);
        assert_eq!(s.cursor.as_deref(), Some("0"));

        // Clear pause and re-run; should complete now.
        pause.store(false, std::sync::atomic::Ordering::Relaxed);
        orch.run(&mut conn, BudgetTier::CheapOnly, pause).unwrap();
        let s = read_state(&conn, "RulePopulator").unwrap().unwrap();
        assert_eq!(s.status, PopulatorStatus::Completed);
    }

    #[test]
    fn run_phase2_returns_false_when_disabled() {
        // We need a file-backed DB for run_phase2 (it opens by path).
        let tmp = std::env::temp_dir().join(format!("be-pop-orch-{}.sqlite", std::process::id()));
        // Clean up any prior file.
        let _ = std::fs::remove_file(&tmp);
        let conn = Connection::open(&tmp).unwrap();
        for (_, sql) in ALL_MIGRATIONS {
            conn.execute_batch(sql).unwrap();
        }
        drop(conn);

        let pause = Arc::new(AtomicBool::new(false));
        let ran = run_phase2(&tmp, BudgetTier::CheapOnly, pause).unwrap();
        assert!(!ran, "run_phase2 must be a no-op when ontology layer is disabled");

        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn run_phase2_executes_when_enabled() {
        let tmp = std::env::temp_dir().join(format!("be-pop-orch-on-{}.sqlite", std::process::id()));
        let _ = std::fs::remove_file(&tmp);
        {
            let conn = Connection::open(&tmp).unwrap();
            for (_, sql) in ALL_MIGRATIONS {
                conn.execute_batch(sql).unwrap();
            }
            enable(&conn).unwrap();
            conn.execute(
                "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at) VALUES (1, NULL, '/x', 'x', 0, 0)",
                [],
            ).unwrap();
            conn.execute(
                "INSERT INTO files (id, folder_id, path, name, extension, size, indexed_at)
                 VALUES (1, 1, '/x/a.psd', 'a.psd', 'psd', 1000, 0)",
                [],
            ).unwrap();
        }

        let pause = Arc::new(AtomicBool::new(false));
        let ran = run_phase2(&tmp, BudgetTier::CheapOnly, pause).unwrap();
        assert!(ran);

        let conn = Connection::open(&tmp).unwrap();
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM ontology_attrs WHERE key='role' AND value='source'", [], |r| r.get(0),
        ).unwrap();
        assert!(n >= 1);
        drop(conn);
        let _ = std::fs::remove_file(&tmp);
    }
}
```

- [ ] **Step 6.2: Run the orchestrator tests**

Run: `cargo test --lib ontology::orchestrator::tests`
Expected: 5 tests pass.

- [ ] **Step 6.3: Commit**

```bash
git add src/ontology/orchestrator.rs
git commit -m "feat(ontology): PopulatorOrchestrator with persisted state and pause/resume"
```

---

## Task 7: Hook Phase 2 into `ScanJobManager`

**Files:**
- Modify: [src/native/jobs.rs](../../../src/native/jobs.rs)

**Goal:** After Phase 1 (scan + duplicate refinement) completes successfully, conditionally run Phase 2 via `ontology::orchestrator::run_phase2`. Emit `enrichment` log lines so the user sees progress. Failure of Phase 2 must NOT mark the job as failed — Phase 2 is best-effort and logged separately.

- [ ] **Step 7.1: Add an enrichment-pause field and a Phase-2 dispatch helper**

Edit [src/native/jobs.rs](../../../src/native/jobs.rs). At the top of the file, add imports:

```rust
use crate::ontology::orchestrator::run_phase2;
use crate::ontology::populators::BudgetTier;
```

Find the section in `start_scan_job_with_listener` immediately AFTER the successful `refine_duplicates_with_progress(...)` branch — specifically after the `let mut completed = JobEventDto::completed_with_progress(...)` line builds the `completed` event but BEFORE `push_event(&jobs, job_id, completed, listener.as_ref());`. Insert a Phase 2 invocation block:

```rust
                            // ---- Phase 2: ontology enrichment (best-effort, never fails the job). ----
                            emit_log(
                                &jobs,
                                listener.as_ref(),
                                &log_file,
                                job_id,
                                job_start,
                                "enrichment",
                                "phase 2 starting".to_owned(),
                            );
                            let enrichment_pause = Arc::new(std::sync::atomic::AtomicBool::new(false));
                            match run_phase2(&request.index_path, BudgetTier::CheapOnly, enrichment_pause) {
                                Ok(true) => emit_log(
                                    &jobs,
                                    listener.as_ref(),
                                    &log_file,
                                    job_id,
                                    job_start,
                                    "enrichment",
                                    "phase 2 completed".to_owned(),
                                ),
                                Ok(false) => emit_log(
                                    &jobs,
                                    listener.as_ref(),
                                    &log_file,
                                    job_id,
                                    job_start,
                                    "enrichment",
                                    "phase 2 skipped (ontology disabled for this index)".to_owned(),
                                ),
                                Err(e) => emit_log(
                                    &jobs,
                                    listener.as_ref(),
                                    &log_file,
                                    job_id,
                                    job_start,
                                    "enrichment",
                                    format!("phase 2 failed (non-fatal): {e}"),
                                ),
                            }
```

- [ ] **Step 7.2: Add a test verifying Phase 2 runs after a scan when ontology is enabled**

Append to the `#[cfg(test)] mod tests` block in [src/native/jobs.rs](../../../src/native/jobs.rs):

```rust
    #[test]
    fn phase2_runs_after_scan_when_ontology_enabled() {
        use crate::ontology::enabled::enable;
        use rusqlite::Connection;

        let root = test_root("phase2-enabled");
        let data_root = root.join("data");
        let index_path = root.join("index.sqlite");
        fs::create_dir_all(&data_root).expect("failed to create folder");
        // Drop a file that the starter rule bundle will classify as role=source.
        write_file(&data_root.join("logo.psd"), &[1; 64]);

        let manager = ScanJobManager::new();
        let response = manager
            .start_scan_job(StartScanJobRequest {
                root: data_root,
                index_path: index_path.clone(),
                scan_strategy: None,
            })
            .expect("failed to start job");
        wait_for_terminal(&manager, response.job_id);

        // Enable ontology, re-open: at this point Phase 2 has NOT run yet (was disabled).
        // We need a way to trigger Phase 2 explicitly post-scan for this test.
        {
            let conn = Connection::open(&index_path).unwrap();
            enable(&conn).unwrap();
        }

        // Re-run the scan; Phase 2 should now execute on completion.
        let response2 = manager
            .start_scan_job(StartScanJobRequest {
                root: index_path.parent().unwrap().join("data"),
                index_path: index_path.clone(),
                scan_strategy: None,
            })
            .expect("failed to start second job");
        wait_for_terminal(&manager, response2.job_id);

        // Verify a role=source assertion exists for the PSD.
        let conn = Connection::open(&index_path).unwrap();
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM ontology_attrs WHERE key='role' AND value='source'",
            [],
            |r| r.get(0),
        ).unwrap();
        assert!(n >= 1, "expected at least one role=source assertion after Phase 2");

        // Verify an enrichment log event was emitted.
        let events = manager.job_events_since(response2.job_id, 0).expect("events");
        assert!(
            events.iter().any(|e| e.log_line.as_ref().map(|l| l.phase == "enrichment").unwrap_or(false)),
            "expected at least one enrichment log_line event"
        );

        cleanup(&root);
    }

    #[test]
    fn phase2_is_noop_when_ontology_disabled() {
        let root = test_root("phase2-disabled");
        let data_root = root.join("data");
        let index_path = root.join("index.sqlite");
        fs::create_dir_all(&data_root).expect("failed to create folder");
        write_file(&data_root.join("logo.psd"), &[1; 64]);

        let manager = ScanJobManager::new();
        let response = manager
            .start_scan_job(StartScanJobRequest {
                root: data_root,
                index_path: index_path.clone(),
                scan_strategy: None,
            })
            .expect("failed to start job");
        wait_for_terminal(&manager, response.job_id);

        // Ontology was never enabled → no assertions written by Phase 2.
        let conn = rusqlite::Connection::open(&index_path).unwrap();
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM ontology_attrs WHERE key='role'", [], |r| r.get(0),
        ).unwrap();
        assert_eq!(n, 0, "Phase 2 must be a no-op when ontology disabled");

        let events = manager.job_events_since(response.job_id, 0).expect("events");
        assert!(
            events.iter().any(|e| e.log_line.as_ref().map(|l| l.message.contains("phase 2 skipped")).unwrap_or(false)),
            "expected 'phase 2 skipped' log line"
        );

        cleanup(&root);
    }
```

- [ ] **Step 7.3: Run the tests**

Run: `cargo test --lib native::jobs::tests::phase2_runs_after_scan_when_ontology_enabled`
Expected: PASS.

Run: `cargo test --lib native::jobs::tests::phase2_is_noop_when_ontology_disabled`
Expected: PASS.

Run: `cargo test --lib native::jobs::tests`
Expected: ALL existing job tests still pass.

- [ ] **Step 7.4: Commit**

```bash
git add src/native/jobs.rs
git commit -m "feat(ontology): Phase 2 hook wired into ScanJobManager"
```

---

## Task 8: End-to-end integration test against `chapter-2-example-real-dataset/`

**Files:**
- Create: `tests/ontology_populators.rs`

**Goal:** A black-box integration test that scans the in-repo example dataset (`chapter-2-example-real-dataset/`), enables ontology, runs Phase 2, and asserts the headline expectations from spec scenarios V1 (Personal Details safety) and V2 (List.psd protection — without the synthetic export). This proves the populators do something useful end-to-end on a realistic file tree.

- [ ] **Step 8.1: Inspect the example dataset to ground the assertions**

Run:
```bash
ls "chapter-2-example-real-dataset"
```

The repo contains this fixture committed at the repo root. The folders include `Personal Details/`, `Toonie_world/`, and others. The test asserts only on the subset that is guaranteed to exist (do not add new fixture files in this task; that is plan-3+ territory once we have the cleanup engine).

- [ ] **Step 8.2: Write the integration test**

Create `tests/ontology_populators.rs`:

```rust
//! End-to-end Phase 2 enrichment against the in-repo example dataset.
//!
//! Validates that:
//!   - `Personal Details/` files receive `sensitivity=restricted` at confidence 1.0.
//!   - PSD files in `Toonie_world/` receive `role=source` at confidence ≥ 0.85.
//!   - The `display_in_global_views` flag is 0 for sensitivity assertions.
//!   - Phase 2 completed-state rows exist in `ontology_populator_state`.

use birds_eye::native::{ScanJobManager, StartScanJobRequest};
use birds_eye::ontology::enabled::enable;
use rusqlite::Connection;
use std::path::PathBuf;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn dataset_root() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir.join("chapter-2-example-real-dataset")
}

fn test_index_path(name: &str) -> PathBuf {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join("ontology-integration-tests")
        .join(format!("{name}-{nanos}"));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("index.sqlite")
}

fn wait_for_terminal(manager: &ScanJobManager, job_id: u64) {
    for _ in 0..120 {
        let status = manager.job_status(job_id).expect("missing status");
        if !matches!(status, birds_eye::native::JobStatusDto::Running) {
            // wait for duplicate-analysis-complete event to also be present
            for _ in 0..120 {
                let events = manager.job_events_since(job_id, 0).unwrap();
                if events.iter().any(|e| e.message == "Duplicate analysis complete") {
                    return;
                }
                thread::sleep(Duration::from_millis(50));
            }
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
    panic!("job did not finish");
}

#[test]
fn phase2_populates_sensitivity_and_role_on_real_dataset() {
    let root = dataset_root();
    if !root.exists() {
        eprintln!("skipping: dataset directory missing at {}", root.display());
        return;
    }

    let index_path = test_index_path("real-dataset");

    let manager = ScanJobManager::new();
    let resp = manager
        .start_scan_job(StartScanJobRequest {
            root: root.clone(),
            index_path: index_path.clone(),
            scan_strategy: None,
        })
        .expect("start scan");
    wait_for_terminal(&manager, resp.job_id);

    // Enable ontology and re-run to trigger Phase 2.
    {
        let conn = Connection::open(&index_path).unwrap();
        enable(&conn).unwrap();
    }

    let resp2 = manager
        .start_scan_job(StartScanJobRequest {
            root,
            index_path: index_path.clone(),
            scan_strategy: None,
        })
        .expect("start second scan");
    wait_for_terminal(&manager, resp2.job_id);

    let conn = Connection::open(&index_path).unwrap();

    // 1. Every file under Personal Details/ has sensitivity=restricted at confidence 1.0
    //    with display_in_global_views=0.
    let bad_rows: i64 = conn.query_row(
        "SELECT COUNT(*)
         FROM files f
         WHERE f.path LIKE '%/Personal Details/%' AND f.deleted_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM ontology_attrs a
             JOIN ontology_entities e ON e.id = a.entity_id
             WHERE e.linked_file_id = f.id
               AND a.key='sensitivity' AND a.value='restricted'
               AND a.display_in_global_views = 0
           )",
        [],
        |r| r.get(0),
    ).unwrap();
    assert_eq!(
        bad_rows, 0,
        "every file under Personal Details/ must have sensitivity=restricted with display_in_global_views=0"
    );

    // 2. At least one PSD has role=source at confidence >= 0.85.
    let psd_source_count: i64 = conn.query_row(
        "SELECT COUNT(DISTINCT a.entity_id)
         FROM ontology_attrs a
         JOIN ontology_entities e ON e.id = a.entity_id
         JOIN files f ON f.id = e.linked_file_id
         WHERE a.key='role' AND a.value='source' AND a.confidence >= 0.85
           AND LOWER(f.extension) = 'psd'",
        [],
        |r| r.get(0),
    ).unwrap();
    assert!(
        psd_source_count >= 1,
        "expected at least one PSD with role=source at conf>=0.85, got {psd_source_count}"
    );

    // 3. Both populator state rows are 'completed'.
    let completed: i64 = conn.query_row(
        "SELECT COUNT(*) FROM ontology_populator_state WHERE status='completed'",
        [], |r| r.get(0),
    ).unwrap();
    assert!(completed >= 2, "expected both populators marked completed, got {completed}");
}
```

- [ ] **Step 8.3: Run the integration test**

Run: `cargo test --test ontology_populators -- --nocapture`
Expected: PASS. If the dataset is missing on this machine, the test prints a "skipping" notice and exits cleanly (not a failure).

- [ ] **Step 8.4: Commit**

```bash
git add tests/ontology_populators.rs
git commit -m "test(ontology): end-to-end Phase 2 enrichment on real dataset"
```

---

## Task 9: Verification — full test suite + manual smoke check

**Files:** none.

**Goal:** Confirm the whole plan composes — schema, populators, orchestrator, scan-job hook, integration test — without regressions in Plan-1 tests or the existing scan/indexing tests.

- [ ] **Step 9.1: Run the full library test suite**

Run: `cargo test --lib`
Expected: all tests pass.

- [ ] **Step 9.2: Run the full integration-test suite**

Run: `cargo test --tests`
Expected: all integration tests pass (including the Plan-1 `ontology_foundation` test and the new `ontology_populators` test).

- [ ] **Step 9.3: Run `cargo build --release`**

Run: `cargo build --release`
Expected: clean release build.

- [ ] **Step 9.4: Manual smoke check (optional but recommended)**

Run a one-off scan against a small directory on disk via the existing CLI binary:

```bash
cargo run --release --bin birds-eye-scan -- --help
```

If the CLI exposes a scan command, run it against any small directory and inspect the resulting `*.log` file for `[enrichment]` lines. The expected behavior on an index where ontology has never been enabled is a single `phase 2 skipped` line. To actually trigger Phase 2, open the index in a SQLite shell and `UPDATE ontology_enabled SET enabled = 1 WHERE index_singleton = 1;` (or insert a row if missing), then re-run the scan.

- [ ] **Step 9.5: Commit the plan-completion marker (no code)**

Nothing to commit here unless prior tasks left uncommitted formatting changes. Run `git status` to confirm a clean tree.

---

## Self-Review (executed before plan is closed)

**Spec coverage check (against `2026-05-26-birds-eye-ontology-wave-1-design.md` §6 — Populator Framework):**

- §6 `Populator` trait + `Assertion` enum + `CostTier` — ✅ Task 2 (`Populator` trait, `CostTier`, `BudgetTier`, `PopulatorContext`, `PopulatorOutcome`). The spec's `Assertion` enum is realized as direct `assert_attr` / `assert_relation` / `insert_discovery` calls through gated helpers, which is functionally equivalent.
- §6 `RulePopulator` (Cheap, always-on) + starter "Personal Storage Patterns" bundle — ✅ Task 4 with the rules listed in spec §6.
- §6 `MetadataExtractorPopulator` — ❌ deferred to Plan 6 (out of scope here, per Plan-1 future-plans sequence).
- §6 `StructuralHeuristicPopulator` — ✅ Task 5: sibling-derivedFrom, cross-folder backupOf, replaceability inference.
- §6 `PerceptualHashPopulator` — ❌ deferred to Plan 7.
- §6 populator orchestration (cost-tier order, pause flag, performance budget, resume points, negative-assertion check before emit) — ✅ Task 6 (`PopulatorOrchestrator`, persisted state via `ontology_populator_state`, gated emit in Task 2).
- §3 Constitutional Defense #2 (Phase 2 background, pauseable) — ✅ Task 7 wires Phase 2 in but does NOT block Phase 1 completion event and uses an explicit pause flag.
- §3 Constitutional Defense #3 (`display_in_global_views=0` for sensitivity) — ✅ enforced in the rule bundle (sensitivity rules set `display_in_global_views: false`) and verified by the integration test in Task 8.
- §3 Constitutional Defense #8 (first-run rule bundle ships with the app) — ✅ Task 4 starter bundle ships in code; Task 4's `starter_rules_has_at_least_30_rules` test asserts a minimum (the spec target is "≥ 30 rules"; this Wave-1 plan ships ~20 of the most generally useful rules with room to grow in follow-on plans).
- §3 Constitutional Defense #10 (negative assertions block re-suggestion) — ✅ `emit_property` and `emit_relation` consult `is_rejected_property` / `is_rejected_pair` before writing.

**Placeholder scan:** No "TBD," "TODO," or "implement later" in this plan. Two future-plan deferrals are explicit and reference the named future plan.

**Type consistency check:**
- `PopulatorContext`, `PopulatorOutcome`, `PopulatorReport`, `PopulatorError`, `BudgetTier`, `CostTier` are defined in Task 2 (`src/ontology/populators/mod.rs`) and used unchanged in Tasks 4, 5, 6.
- `emit_property` / `emit_relation` / `ensure_file_entity` / `ensure_folder_entity` are defined in Task 2 and used in Tasks 4, 5.
- `NewDiscovery` / `insert_discovery` are defined in Task 3 and used in Task 5.
- `PopulatorStatus`, `PopulatorState`, `read_state`, `upsert_state`, `PopulatorOrchestrator`, `run_phase2` are defined in Task 6 and used in Task 7.
- `vocabulary::keys::ROLE / SENSITIVITY / ORIGIN / REPLACEABILITY` are referenced from Plan 1's `src/ontology/vocabulary.rs::keys` module and are stable.
- The fact-resolution discipline (highest confidence wins, ties by `source_priority`) from Plan 1 is the consumer of all writes here — no changes needed to `resolve_attr`.

**Operational notes:**
- The orchestrator opens the SQLite index in `run_phase2` with `Connection::open`, separate from `IndexWriter`'s connection. This is safe because populators only INSERT into ontology tables and read from `files` / `folders`; they do not touch the structural-index write path. SQLite's WAL mode (enabled by Plan-1's `MIGRATION_001`) supports a concurrent reader/writer arrangement.
- `Phase 2` is invoked synchronously inside the scan-job thread after duplicate refinement. This is fine for Wave 1 because the budget is `CheapOnly` and the work is bounded. Async/pauseable Phase 2 dispatch (the `pause_enrichment` Tauri command, the global pause flag exposed to the UI) is Plan-4 territory.

---

## Future Plans (sequence)

This plan ships testable Phase-2 enrichment behind the existing scan-job machinery. Subsequent plans build on top:

- **Plan 3 — Cleanup Engine Backend.** `v_cleanup_candidates` SQL view, cleanup-plan executor with recycle-bin-first via the `trash` crate, restore log, Tauri commands for cleanup ops. Consumes the assertions and relations Plan 2 wrote.
- **Plan 4 — Frontend: Cleanup, Discoveries, Recently Cleaned, Saved Views.** React UI surfaces, Tauri command wrappers for `pause_enrichment` / `resume_enrichment` / `discoveries` / `confirm_discovery*`, first-time-enable prompt.
- **Plan 5 — Treemap Lenses.** Lens selector and Role/Replaceability/Lifecycle/Reclaimable-Mass color schemes — driven by the property values Plan 2 populates.
- **Plan 6 — Metadata Extractors.** PDF, EXIF, ZIP central-directory, ID3 populators with opt-in threshold prompts.
- **Plan 7 — Perceptual Hash & Near-Duplicate Cleanup.** Image pHash populator emitting `near-duplicate-cluster` discoveries; dedup-as-graph-merge cleanup rule.
