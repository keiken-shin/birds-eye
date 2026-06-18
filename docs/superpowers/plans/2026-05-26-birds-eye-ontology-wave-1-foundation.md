# Birds Eye Ontology Wave 1 — Plan 1: Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the ontology storage layer — schema migration, vocabulary types, entity/attribute/relation/negative-assertion CRUD, pin-to-keep, sensitivity-containment helper, ontology-enabled toggle — fully tested and wired into the Birds Eye `birds_eye` crate, with the constitutional invariants enforced as automated tests.

**Architecture:** A new top-level module `birds_eye::ontology` exposing CRUD primitives over the existing rusqlite-backed index. A single SQLite migration (`MIGRATION_005`) adds 9 new tables and a perceptual-hash side table. All vocabulary is encoded as Rust enums with `as_str()` / `from_str()` round-trips. Fact resolution implements the "highest confidence wins, ties broken by source-priority order" discipline from §4 of the spec. No user-visible behavior changes in this plan; subsequent plans build populators, cleanup engine, and frontend on top.

**Tech Stack:** Rust 2021, `rusqlite` 0.32 (bundled SQLite), `serde` 1, `regex` 1. Tests use stock `#[cfg(test)]` modules with in-memory SQLite connections.

**Spec reference:** [docs/superpowers/specs/2026-05-26-birds-eye-ontology-wave-1-design.md](../specs/2026-05-26-birds-eye-ontology-wave-1-design.md)

**Plan-1 scope:** Foundation only. No populators, no cleanup engine, no frontend, no Tauri commands. Future plans handle those.

---

## File Structure

This plan creates the following files (new) and modifies the following (existing):

**Create:**
- `src/ontology/mod.rs` — module root, public API surface
- `src/ontology/vocabulary.rs` — `Role`, `Replaceability`, `Sensitivity`, `Lifecycle`, `Origin`, `EntityKind` enums and their string round-trips
- `src/ontology/entities.rs` — `Entity` struct, `insert_entity`, `find_entity_for_file`, `find_entity_for_folder`, `get_entity`
- `src/ontology/attrs.rs` — `Assertion` struct, `assert_attr`, `get_attrs`, `resolve_attr`
- `src/ontology/relations.rs` — `Relation` struct, `assert_relation`, `outbound`, `inbound`
- `src/ontology/negative.rs` — `reject_pair`, `reject_property`, `is_rejected_pair`, `is_rejected_property`
- `src/ontology/pinning.rs` — `pin_file`, `unpin_file`, `is_pinned`
- `src/ontology/sensitivity.rs` — `is_globally_visible_file`, `is_globally_visible_folder`
- `src/ontology/enabled.rs` — `enable`, `disable`, `is_enabled`
- `src/ontology/errors.rs` — `OntologyError` enum + `From<rusqlite::Error>`
- `tests/ontology_foundation.rs` — integration tests exercising the full module against an in-memory DB

**Modify:**
- `src/index/schema.rs` — append `MIGRATION_005`, bump `CURRENT_SCHEMA_VERSION` to 5, extend `ALL_MIGRATIONS`, extend the schema tests
- `src/lib.rs` — add `pub mod ontology;`

**Vocabulary version constant:** `pub const VOCABULARY_VERSION: i64 = 1;` lives in `src/ontology/mod.rs` and is referenced by every assertion.

---

## Task 1: Schema migration — `MIGRATION_005` adds ontology tables

**Files:**
- Modify: [src/index/schema.rs](../../../src/index/schema.rs)

**Goal:** Add the new ontology tables (entities, attrs, relations, negative-assertions, pinned-files, enabled-toggle, vocabulary-version, perceptual-hashes, discoveries, cleanup-log, cleanup-plans) as `MIGRATION_005`, bump the schema version, and prove the migration is well-formed via existing-style tests.

- [x] **Step 1.1: Write the failing schema test additions**

Append the following to the existing `#[cfg(test)] mod tests` block at the bottom of [src/index/schema.rs](../../../src/index/schema.rs):

```rust
    #[test]
    fn ontology_migration_present() {
        assert!(CURRENT_SCHEMA_VERSION >= 5);
        assert!(ALL_MIGRATIONS.iter().any(|(v, _)| *v == 5));
    }

    #[test]
    fn migration_005_contains_ontology_tables() {
        let mig = ALL_MIGRATIONS
            .iter()
            .find(|(v, _)| *v == 5)
            .expect("migration 5 missing")
            .1;

        for table in [
            "ontology_vocabulary_version",
            "ontology_entities",
            "ontology_attrs",
            "ontology_relations",
            "ontology_negative_assertions",
            "ontology_pinned_files",
            "ontology_enabled",
            "ontology_perceptual_hashes",
            "ontology_discoveries",
            "ontology_cleanup_log",
            "ontology_cleanup_plans",
        ] {
            assert!(
                mig.contains(&format!("CREATE TABLE IF NOT EXISTS {table}")),
                "migration 5 missing table {table}"
            );
        }

        for index in [
            "idx_ontology_entities_linked_file",
            "idx_ontology_entities_linked_folder",
            "idx_ontology_attrs_entity_key",
            "idx_ontology_relations_subj_pred",
            "idx_ontology_relations_pred_obj",
            "idx_phash",
            "idx_discoveries_status_roi",
        ] {
            assert!(mig.contains(index), "migration 5 missing index {index}");
        }
    }
```

- [x] **Step 1.2: Run the tests to verify they fail**

Run: `cargo test --lib index::schema::tests::ontology_migration_present`
Expected: FAIL with `assertion failed: CURRENT_SCHEMA_VERSION >= 5` (current value is 4).

Run: `cargo test --lib index::schema::tests::migration_005_contains_ontology_tables`
Expected: FAIL with `migration 5 missing` panic from the `.expect` call.

- [x] **Step 1.3: Add `MIGRATION_005`, bump the version, extend `ALL_MIGRATIONS`**

In [src/index/schema.rs](../../../src/index/schema.rs):

Change the top constant:
```rust
pub const CURRENT_SCHEMA_VERSION: u32 = 5;
```

Append a new migration constant after `MIGRATION_004`:

```rust
pub const MIGRATION_005: &str = r#"
CREATE TABLE IF NOT EXISTS ontology_vocabulary_version (
  current_version INTEGER NOT NULL,
  applied_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO ontology_vocabulary_version (current_version, applied_at)
VALUES (1, strftime('%s', 'now'));

CREATE TABLE IF NOT EXISTS ontology_entities (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('File', 'Folder', 'Project', 'Work', 'Theme')),
  canonical_id TEXT NOT NULL,
  linked_file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
  linked_folder_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
  display_name TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(kind, canonical_id)
);

CREATE INDEX IF NOT EXISTS idx_ontology_entities_linked_file ON ontology_entities(linked_file_id);
CREATE INDEX IF NOT EXISTS idx_ontology_entities_linked_folder ON ontology_entities(linked_folder_id);
CREATE INDEX IF NOT EXISTS idx_ontology_entities_kind_id ON ontology_entities(kind, id);

CREATE TABLE IF NOT EXISTS ontology_attrs (
  id INTEGER PRIMARY KEY,
  entity_id INTEGER NOT NULL REFERENCES ontology_entities(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  source TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
  asserted_at INTEGER NOT NULL,
  vocabulary_version INTEGER NOT NULL,
  display_in_global_views INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_ontology_attrs_entity_key ON ontology_attrs(entity_id, key);
CREATE INDEX IF NOT EXISTS idx_ontology_attrs_key_value ON ontology_attrs(key, value);

CREATE TABLE IF NOT EXISTS ontology_relations (
  id INTEGER PRIMARY KEY,
  subject_id INTEGER NOT NULL REFERENCES ontology_entities(id) ON DELETE CASCADE,
  predicate TEXT NOT NULL,
  object_id INTEGER NOT NULL REFERENCES ontology_entities(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
  asserted_at INTEGER NOT NULL,
  vocabulary_version INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ontology_relations_subj_pred ON ontology_relations(subject_id, predicate);
CREATE INDEX IF NOT EXISTS idx_ontology_relations_pred_obj ON ontology_relations(predicate, object_id);
CREATE INDEX IF NOT EXISTS idx_ontology_relations_pred_conf ON ontology_relations(predicate, confidence DESC);

CREATE TABLE IF NOT EXISTS ontology_negative_assertions (
  id INTEGER PRIMARY KEY,
  subject_id INTEGER NOT NULL REFERENCES ontology_entities(id) ON DELETE CASCADE,
  predicate TEXT NOT NULL,
  object_id INTEGER REFERENCES ontology_entities(id) ON DELETE CASCADE,
  key TEXT,
  value TEXT,
  rejected_at INTEGER NOT NULL,
  reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_neg_assertions_subj_pred ON ontology_negative_assertions(subject_id, predicate);
CREATE INDEX IF NOT EXISTS idx_neg_assertions_subj_key ON ontology_negative_assertions(subject_id, key);

CREATE TABLE IF NOT EXISTS ontology_pinned_files (
  file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  pinned_at INTEGER NOT NULL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS ontology_enabled (
  index_singleton INTEGER PRIMARY KEY CHECK (index_singleton = 1),
  enabled INTEGER NOT NULL,
  changed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ontology_perceptual_hashes (
  file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  phash BLOB NOT NULL,
  dhash BLOB NOT NULL,
  computed_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_phash ON ontology_perceptual_hashes(phash);

CREATE TABLE IF NOT EXISTS ontology_discoveries (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'rejected', 'expired')),
  confidence REAL NOT NULL,
  potential_bytes_unlocked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_discoveries_status_roi ON ontology_discoveries(status, potential_bytes_unlocked DESC, confidence DESC);

CREATE TABLE IF NOT EXISTS ontology_cleanup_plans (
  id INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL,
  executed_at INTEGER,
  scope TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'executed', 'cancelled'))
);

CREATE TABLE IF NOT EXISTS ontology_cleanup_log (
  id INTEGER PRIMARY KEY,
  cleanup_plan_id INTEGER NOT NULL REFERENCES ontology_cleanup_plans(id) ON DELETE CASCADE,
  file_id INTEGER NOT NULL,
  original_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  cleaned_at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  gating_facts TEXT NOT NULL,
  restore_status TEXT NOT NULL CHECK (restore_status IN ('in_recycle_bin', 'restored', 'expired')) DEFAULT 'in_recycle_bin',
  expires_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_cleanup_log_status ON ontology_cleanup_log(restore_status, expires_at);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (5, strftime('%s', 'now'));
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
];
```

Update the pre-existing `exposes_current_migration` test to:
```rust
    #[test]
    fn exposes_current_migration() {
        assert_eq!(CURRENT_SCHEMA_VERSION, 5);
        assert_eq!(ALL_MIGRATIONS.len(), 5);
    }
```

- [x] **Step 1.4: Run the tests to verify they pass**

Run: `cargo test --lib index::schema::tests`
Expected: ALL tests pass (the two new ones from Step 1.1 plus the updated `exposes_current_migration` and the existing `migration_contains_core_tables_and_indexes`).

- [x] **Step 1.5: Verify the migration actually applies against an in-memory DB**

Append one more test to the same test block:

```rust
    #[test]
    fn migration_005_applies_cleanly_in_memory() {
        use rusqlite::Connection;

        let conn = Connection::open_in_memory().expect("open in-memory db");
        for (_, sql) in ALL_MIGRATIONS {
            conn.execute_batch(sql)
                .expect("migration applies");
        }

        // Spot-check that key tables exist
        for table in [
            "ontology_entities",
            "ontology_attrs",
            "ontology_relations",
            "ontology_pinned_files",
            "ontology_enabled",
        ] {
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |r| r.get(0),
                )
                .expect("query sqlite_master");
            assert_eq!(count, 1, "table {table} missing after migrations");
        }

        // Vocabulary version row should be seeded.
        let v: i64 = conn
            .query_row(
                "SELECT current_version FROM ontology_vocabulary_version",
                [],
                |r| r.get(0),
            )
            .expect("vocab version row");
        assert_eq!(v, 1);
    }
```

Run: `cargo test --lib index::schema::tests::migration_005_applies_cleanly_in_memory`
Expected: PASS.

- [x] **Step 1.6: Commit**

```bash
git add src/index/schema.rs
git commit -m "feat(ontology): add MIGRATION_005 with ontology tables and indexes"
```

---

## Task 2: Module skeleton + lib wiring + `OntologyError`

**Files:**
- Create: `src/ontology/mod.rs`
- Create: `src/ontology/errors.rs`
- Modify: [src/lib.rs](../../../src/lib.rs)

**Goal:** Land the empty module structure so subsequent tasks just fill in submodules, and establish `OntologyError`.

- [x] **Step 2.1: Create `src/ontology/errors.rs`**

```rust
use rusqlite;

#[derive(Debug)]
pub enum OntologyError {
    Sqlite(rusqlite::Error),
    InvalidVocabulary(String),
    EntityNotFound(i64),
    OntologyDisabled,
}

impl From<rusqlite::Error> for OntologyError {
    fn from(err: rusqlite::Error) -> Self {
        OntologyError::Sqlite(err)
    }
}

impl std::fmt::Display for OntologyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Sqlite(e) => write!(f, "sqlite error: {e}"),
            Self::InvalidVocabulary(v) => write!(f, "invalid vocabulary value: {v}"),
            Self::EntityNotFound(id) => write!(f, "entity not found: {id}"),
            Self::OntologyDisabled => write!(f, "ontology layer is disabled for this index"),
        }
    }
}

impl std::error::Error for OntologyError {}
```

- [x] **Step 2.2: Create `src/ontology/mod.rs`**

```rust
//! Birds Eye ontology layer (Wave 1 foundation).
//!
//! See `docs/superpowers/specs/2026-05-26-birds-eye-ontology-wave-1-design.md`
//! for the full design rationale.

pub mod attrs;
pub mod enabled;
pub mod entities;
pub mod errors;
pub mod negative;
pub mod pinning;
pub mod relations;
pub mod sensitivity;
pub mod vocabulary;

pub use errors::OntologyError;

/// Current vocabulary version. Bump when the vocabulary changes.
pub const VOCABULARY_VERSION: i64 = 1;

/// Source-priority ordering for fact resolution.
/// Higher values win in ties.
pub fn source_priority(source: &str) -> i32 {
    if source == "user" {
        100
    } else if source.starts_with("extractor:") {
        80
    } else if source.starts_with("rule:") {
        60
    } else if source.starts_with("heuristic:") {
        40
    } else if source == "phash" {
        30
    } else if source.starts_with("ml:") {
        20
    } else if source == "system" {
        10
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_priority_ordering() {
        assert!(source_priority("user") > source_priority("extractor:pdf"));
        assert!(source_priority("extractor:pdf") > source_priority("rule:r1"));
        assert!(source_priority("rule:r1") > source_priority("heuristic:h1"));
        assert!(source_priority("heuristic:h1") > source_priority("phash"));
        assert!(source_priority("phash") > source_priority("ml:m1"));
        assert!(source_priority("ml:m1") > source_priority("system"));
        assert_eq!(source_priority("unknown-source"), 0);
    }
}
```

- [x] **Step 2.3: Create empty submodule files**

Create each of these as a minimal file with just a module-level doc comment (concrete content lands in later tasks):

`src/ontology/vocabulary.rs`:
```rust
//! Controlled-vocabulary enums for Wave 1 ontology.
```

`src/ontology/entities.rs`:
```rust
//! Entity CRUD.
```

`src/ontology/attrs.rs`:
```rust
//! Attribute (EAV) CRUD and resolution.
```

`src/ontology/relations.rs`:
```rust
//! Typed-relation CRUD.
```

`src/ontology/negative.rs`:
```rust
//! Negative assertion CRUD (user-rejected facts).
```

`src/ontology/pinning.rs`:
```rust
//! Pin-to-keep CRUD.
```

`src/ontology/sensitivity.rs`:
```rust
//! Sensitivity-containment helpers (Constitutional Defense #3).
```

`src/ontology/enabled.rs`:
```rust
//! Ontology-enabled toggle (per-index opt-in).
```

- [x] **Step 2.4: Wire into `lib.rs`**

Edit [src/lib.rs](../../../src/lib.rs):
```rust
pub mod index;
pub mod native;
pub mod ontology;
pub mod scanner;
```

- [x] **Step 2.5: Verify build + module tests pass**

Run: `cargo build`
Expected: clean build.

Run: `cargo test --lib ontology::tests`
Expected: `source_priority_ordering` passes.

- [x] **Step 2.6: Commit**

```bash
git add src/lib.rs src/ontology/
git commit -m "feat(ontology): scaffold module structure and OntologyError"
```

---

## Task 3: Vocabulary enums and string round-trips

**Files:**
- Modify: `src/ontology/vocabulary.rs`

**Goal:** Encode the controlled vocabularies from spec §4 as Rust enums with bidirectional string conversion.

- [x] **Step 3.1: Write the failing test**

In `src/ontology/vocabulary.rs`:

```rust
//! Controlled-vocabulary enums for Wave 1 ontology.

use crate::ontology::OntologyError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EntityKind {
    File,
    Folder,
    Project,
    Work,
    Theme,
}

impl EntityKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::File => "File",
            Self::Folder => "Folder",
            Self::Project => "Project",
            Self::Work => "Work",
            Self::Theme => "Theme",
        }
    }

    pub fn from_str(s: &str) -> Result<Self, OntologyError> {
        match s {
            "File" => Ok(Self::File),
            "Folder" => Ok(Self::Folder),
            "Project" => Ok(Self::Project),
            "Work" => Ok(Self::Work),
            "Theme" => Ok(Self::Theme),
            other => Err(OntologyError::InvalidVocabulary(format!("EntityKind: {other}"))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Source,
    Derivative,
    Reference,
    Asset,
    Tool,
    Backup,
    Scratch,
    System,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Source => "source",
            Self::Derivative => "derivative",
            Self::Reference => "reference",
            Self::Asset => "asset",
            Self::Tool => "tool",
            Self::Backup => "backup",
            Self::Scratch => "scratch",
            Self::System => "system",
        }
    }

    pub fn from_str(s: &str) -> Result<Self, OntologyError> {
        match s {
            "source" => Ok(Self::Source),
            "derivative" => Ok(Self::Derivative),
            "reference" => Ok(Self::Reference),
            "asset" => Ok(Self::Asset),
            "tool" => Ok(Self::Tool),
            "backup" => Ok(Self::Backup),
            "scratch" => Ok(Self::Scratch),
            "system" => Ok(Self::System),
            other => Err(OntologyError::InvalidVocabulary(format!("Role: {other}"))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Replaceability {
    Regenerable,
    Redownloadable,
    RecoverableWithEffort,
    Irreplaceable,
    Unknown,
}

impl Replaceability {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Regenerable => "regenerable",
            Self::Redownloadable => "redownloadable",
            Self::RecoverableWithEffort => "recoverable-with-effort",
            Self::Irreplaceable => "irreplaceable",
            Self::Unknown => "unknown",
        }
    }

    pub fn from_str(s: &str) -> Result<Self, OntologyError> {
        match s {
            "regenerable" => Ok(Self::Regenerable),
            "redownloadable" => Ok(Self::Redownloadable),
            "recoverable-with-effort" => Ok(Self::RecoverableWithEffort),
            "irreplaceable" => Ok(Self::Irreplaceable),
            "unknown" => Ok(Self::Unknown),
            other => Err(OntologyError::InvalidVocabulary(format!("Replaceability: {other}"))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sensitivity {
    Public,
    Normal,
    Private,
    Restricted,
}

impl Sensitivity {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Public => "public",
            Self::Normal => "normal",
            Self::Private => "private",
            Self::Restricted => "restricted",
        }
    }

    pub fn from_str(s: &str) -> Result<Self, OntologyError> {
        match s {
            "public" => Ok(Self::Public),
            "normal" => Ok(Self::Normal),
            "private" => Ok(Self::Private),
            "restricted" => Ok(Self::Restricted),
            other => Err(OntologyError::InvalidVocabulary(format!("Sensitivity: {other}"))),
        }
    }

    pub fn restricted_or_private(self) -> bool {
        matches!(self, Self::Private | Self::Restricted)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lifecycle {
    Planning,
    Active,
    Finished,
    Archived,
    Abandoned,
}

impl Lifecycle {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Planning => "planning",
            Self::Active => "active",
            Self::Finished => "finished",
            Self::Archived => "archived",
            Self::Abandoned => "abandoned",
        }
    }

    pub fn from_str(s: &str) -> Result<Self, OntologyError> {
        match s {
            "planning" => Ok(Self::Planning),
            "active" => Ok(Self::Active),
            "finished" => Ok(Self::Finished),
            "archived" => Ok(Self::Archived),
            "abandoned" => Ok(Self::Abandoned),
            other => Err(OntologyError::InvalidVocabulary(format!("Lifecycle: {other}"))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    UserCreated,
    WebDownload,
    PhoneScreenshot,
    PhoneCamera,
    MessengerReceived,
    AppExport,
    ArchiveExtracted,
    Unknown,
}

impl Origin {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UserCreated => "user-created",
            Self::WebDownload => "web-download",
            Self::PhoneScreenshot => "phone-screenshot",
            Self::PhoneCamera => "phone-camera",
            Self::MessengerReceived => "messenger-received",
            Self::AppExport => "app-export",
            Self::ArchiveExtracted => "archive-extracted",
            Self::Unknown => "unknown",
        }
    }

    pub fn from_str(s: &str) -> Result<Self, OntologyError> {
        match s {
            "user-created" => Ok(Self::UserCreated),
            "web-download" => Ok(Self::WebDownload),
            "phone-screenshot" => Ok(Self::PhoneScreenshot),
            "phone-camera" => Ok(Self::PhoneCamera),
            "messenger-received" => Ok(Self::MessengerReceived),
            "app-export" => Ok(Self::AppExport),
            "archive-extracted" => Ok(Self::ArchiveExtracted),
            "unknown" => Ok(Self::Unknown),
            other => Err(OntologyError::InvalidVocabulary(format!("Origin: {other}"))),
        }
    }
}

/// Property keys (the `key` column of `ontology_attrs`).
pub mod keys {
    pub const ROLE: &str = "role";
    pub const REPLACEABILITY: &str = "replaceability";
    pub const SENSITIVITY: &str = "sensitivity";
    pub const LIFECYCLE: &str = "lifecycle";
    pub const ORIGIN: &str = "origin";
    pub const LANGUAGE: &str = "language";
    pub const MEDIA_TYPE: &str = "mediaType";
}

/// Relation predicates (the `predicate` column of `ontology_relations`).
pub mod predicates {
    pub const IN_FOLDER: &str = "inFolder";
    pub const PART_OF: &str = "partOf";
    pub const DERIVED_FROM: &str = "derivedFrom";
    pub const BACKUP_OF: &str = "backupOf";
    pub const MANIFESTATION_OF: &str = "manifestationOf";
    pub const DEPICTS: &str = "depicts";
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip<T, F, G>(values: &[T], to_str: F, from_str: G)
    where
        T: PartialEq + std::fmt::Debug + Copy,
        F: Fn(T) -> &'static str,
        G: Fn(&str) -> Result<T, OntologyError>,
    {
        for v in values {
            let s = to_str(*v);
            let parsed = from_str(s).expect("round-trip");
            assert_eq!(parsed, *v, "{s} did not round-trip");
        }
    }

    #[test]
    fn entity_kind_round_trip() {
        round_trip(
            &[
                EntityKind::File,
                EntityKind::Folder,
                EntityKind::Project,
                EntityKind::Work,
                EntityKind::Theme,
            ],
            EntityKind::as_str,
            EntityKind::from_str,
        );
        assert!(EntityKind::from_str("Nonsense").is_err());
    }

    #[test]
    fn role_round_trip() {
        round_trip(
            &[
                Role::Source,
                Role::Derivative,
                Role::Reference,
                Role::Asset,
                Role::Tool,
                Role::Backup,
                Role::Scratch,
                Role::System,
            ],
            Role::as_str,
            Role::from_str,
        );
        assert!(Role::from_str("archive").is_err(), "renamed to backup");
    }

    #[test]
    fn replaceability_round_trip() {
        round_trip(
            &[
                Replaceability::Regenerable,
                Replaceability::Redownloadable,
                Replaceability::RecoverableWithEffort,
                Replaceability::Irreplaceable,
                Replaceability::Unknown,
            ],
            Replaceability::as_str,
            Replaceability::from_str,
        );
    }

    #[test]
    fn sensitivity_round_trip_and_restricted_check() {
        round_trip(
            &[
                Sensitivity::Public,
                Sensitivity::Normal,
                Sensitivity::Private,
                Sensitivity::Restricted,
            ],
            Sensitivity::as_str,
            Sensitivity::from_str,
        );

        assert!(Sensitivity::Restricted.restricted_or_private());
        assert!(Sensitivity::Private.restricted_or_private());
        assert!(!Sensitivity::Normal.restricted_or_private());
        assert!(!Sensitivity::Public.restricted_or_private());
    }

    #[test]
    fn lifecycle_round_trip() {
        round_trip(
            &[
                Lifecycle::Planning,
                Lifecycle::Active,
                Lifecycle::Finished,
                Lifecycle::Archived,
                Lifecycle::Abandoned,
            ],
            Lifecycle::as_str,
            Lifecycle::from_str,
        );
    }

    #[test]
    fn origin_round_trip() {
        round_trip(
            &[
                Origin::UserCreated,
                Origin::WebDownload,
                Origin::PhoneScreenshot,
                Origin::PhoneCamera,
                Origin::MessengerReceived,
                Origin::AppExport,
                Origin::ArchiveExtracted,
                Origin::Unknown,
            ],
            Origin::as_str,
            Origin::from_str,
        );
    }
}
```

- [x] **Step 3.2: Run the tests**

Run: `cargo test --lib ontology::vocabulary::tests`
Expected: ALL tests pass (entity_kind, role, replaceability, sensitivity, lifecycle, origin round-trips, plus the `archive` rejection check).

- [x] **Step 3.3: Commit**

```bash
git add src/ontology/vocabulary.rs
git commit -m "feat(ontology): controlled-vocabulary enums with round-trip tests"
```

---

## Task 4: Entity CRUD

**Files:**
- Modify: `src/ontology/entities.rs`

**Goal:** `Entity` struct + `insert_entity` (idempotent on `(kind, canonical_id)`) + `find_entity_for_file` / `find_entity_for_folder` / `get_entity`.

- [x] **Step 4.1: Write the failing tests + implementation skeleton**

Replace the contents of `src/ontology/entities.rs`:

```rust
//! Entity CRUD.

use crate::ontology::vocabulary::EntityKind;
use crate::ontology::OntologyError;
use rusqlite::{params, Connection, OptionalExtension};

#[derive(Debug, Clone, PartialEq)]
pub struct Entity {
    pub id: i64,
    pub kind: EntityKind,
    pub canonical_id: String,
    pub linked_file_id: Option<i64>,
    pub linked_folder_id: Option<i64>,
    pub display_name: Option<String>,
    pub created_at: i64,
}

/// Insert an entity, or return the existing entity's row if one already exists
/// with the same `(kind, canonical_id)`. The (canonical_id) unique constraint
/// makes this idempotent.
pub fn upsert_entity(
    conn: &Connection,
    kind: EntityKind,
    canonical_id: &str,
    linked_file_id: Option<i64>,
    linked_folder_id: Option<i64>,
    display_name: Option<&str>,
) -> Result<Entity, OntologyError> {
    let now = unix_now();

    // Try to insert first; if it already exists, fall through to a SELECT.
    conn.execute(
        "INSERT OR IGNORE INTO ontology_entities
            (kind, canonical_id, linked_file_id, linked_folder_id, display_name, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            kind.as_str(),
            canonical_id,
            linked_file_id,
            linked_folder_id,
            display_name,
            now,
        ],
    )?;

    get_entity_by_canonical(conn, kind, canonical_id)?
        .ok_or_else(|| OntologyError::Sqlite(rusqlite::Error::QueryReturnedNoRows))
}

pub fn get_entity(conn: &Connection, id: i64) -> Result<Option<Entity>, OntologyError> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, kind, canonical_id, linked_file_id, linked_folder_id, display_name, created_at
         FROM ontology_entities WHERE id = ?1",
    )?;
    let row = stmt
        .query_row(params![id], row_to_entity)
        .optional()?;
    Ok(row)
}

pub fn get_entity_by_canonical(
    conn: &Connection,
    kind: EntityKind,
    canonical_id: &str,
) -> Result<Option<Entity>, OntologyError> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, kind, canonical_id, linked_file_id, linked_folder_id, display_name, created_at
         FROM ontology_entities WHERE kind = ?1 AND canonical_id = ?2",
    )?;
    let row = stmt
        .query_row(params![kind.as_str(), canonical_id], row_to_entity)
        .optional()?;
    Ok(row)
}

pub fn find_entity_for_file(conn: &Connection, file_id: i64) -> Result<Option<Entity>, OntologyError> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, kind, canonical_id, linked_file_id, linked_folder_id, display_name, created_at
         FROM ontology_entities WHERE kind = 'File' AND linked_file_id = ?1",
    )?;
    let row = stmt
        .query_row(params![file_id], row_to_entity)
        .optional()?;
    Ok(row)
}

pub fn find_entity_for_folder(conn: &Connection, folder_id: i64) -> Result<Option<Entity>, OntologyError> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, kind, canonical_id, linked_file_id, linked_folder_id, display_name, created_at
         FROM ontology_entities WHERE kind = 'Folder' AND linked_folder_id = ?1",
    )?;
    let row = stmt
        .query_row(params![folder_id], row_to_entity)
        .optional()?;
    Ok(row)
}

fn row_to_entity(row: &rusqlite::Row<'_>) -> rusqlite::Result<Entity> {
    let kind_str: String = row.get(1)?;
    let kind = EntityKind::from_str(&kind_str)
        .map_err(|_| rusqlite::Error::InvalidColumnType(1, "kind".into(), rusqlite::types::Type::Text))?;
    Ok(Entity {
        id: row.get(0)?,
        kind,
        canonical_id: row.get(2)?,
        linked_file_id: row.get(3)?,
        linked_folder_id: row.get(4)?,
        display_name: row.get(5)?,
        created_at: row.get(6)?,
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

    fn migrated_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        for (_, sql) in ALL_MIGRATIONS {
            conn.execute_batch(sql).unwrap();
        }
        conn
    }

    #[test]
    fn upsert_inserts_then_returns_existing() {
        let conn = migrated_conn();

        let first = upsert_entity(&conn, EntityKind::Project, "proj-uuid-1", None, None, Some("Japanese"))
            .unwrap();
        assert_eq!(first.kind, EntityKind::Project);
        assert_eq!(first.canonical_id, "proj-uuid-1");
        assert_eq!(first.display_name.as_deref(), Some("Japanese"));

        // Second upsert with same (kind, canonical_id) returns the same row.
        let second = upsert_entity(&conn, EntityKind::Project, "proj-uuid-1", None, None, Some("Japanese"))
            .unwrap();
        assert_eq!(second.id, first.id);
    }

    #[test]
    fn upsert_distinguishes_kinds() {
        let conn = migrated_conn();
        let a = upsert_entity(&conn, EntityKind::Project, "same-id", None, None, None).unwrap();
        let b = upsert_entity(&conn, EntityKind::Theme, "same-id", None, None, None).unwrap();
        assert_ne!(a.id, b.id);
        assert_eq!(a.kind, EntityKind::Project);
        assert_eq!(b.kind, EntityKind::Theme);
    }

    #[test]
    fn get_entity_roundtrips() {
        let conn = migrated_conn();
        let inserted = upsert_entity(
            &conn,
            EntityKind::Work,
            "Beyblade (2001)",
            None,
            None,
            Some("Beyblade"),
        )
        .unwrap();

        let fetched = get_entity(&conn, inserted.id).unwrap().expect("present");
        assert_eq!(fetched, inserted);

        assert!(get_entity(&conn, 9999).unwrap().is_none());
    }

    #[test]
    fn find_entity_for_file_and_folder() {
        let conn = migrated_conn();

        // Seed a folder and file in the underlying tables so FKs resolve.
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

        let file_entity =
            upsert_entity(&conn, EntityKind::File, "/root/a.txt", Some(1), None, None).unwrap();
        let folder_entity =
            upsert_entity(&conn, EntityKind::Folder, "/root", None, Some(1), None).unwrap();

        assert_eq!(
            find_entity_for_file(&conn, 1).unwrap().unwrap().id,
            file_entity.id
        );
        assert_eq!(
            find_entity_for_folder(&conn, 1).unwrap().unwrap().id,
            folder_entity.id
        );
        assert!(find_entity_for_file(&conn, 999).unwrap().is_none());
    }
}
```

- [x] **Step 4.2: Run the tests**

Run: `cargo test --lib ontology::entities::tests`
Expected: all four tests pass.

- [x] **Step 4.3: Commit**

```bash
git add src/ontology/entities.rs
git commit -m "feat(ontology): entity CRUD with idempotent upsert"
```

---

## Task 5: Attribute CRUD + resolution

**Files:**
- Modify: `src/ontology/attrs.rs`

**Goal:** `Assertion` struct, `assert_attr`, `get_attrs(entity_id, key)`, `resolve_attr` implementing the resolution discipline (highest confidence wins; ties by `source_priority`).

- [x] **Step 5.1: Write the implementation + tests**

Replace `src/ontology/attrs.rs`:

```rust
//! Attribute (EAV) CRUD and resolution.

use crate::ontology::{source_priority, OntologyError, VOCABULARY_VERSION};
use rusqlite::{params, Connection};

#[derive(Debug, Clone, PartialEq)]
pub struct Assertion {
    pub id: i64,
    pub entity_id: i64,
    pub key: String,
    pub value: String,
    pub source: String,
    pub confidence: f32,
    pub asserted_at: i64,
    pub vocabulary_version: i64,
    pub display_in_global_views: bool,
}

pub struct NewAssertion<'a> {
    pub key: &'a str,
    pub value: &'a str,
    pub source: &'a str,
    pub confidence: f32,
    pub display_in_global_views: bool,
}

/// Insert a new assertion. Multiple assertions for the same (entity, key) are
/// allowed (and intended) — resolution at query time picks the winning value.
pub fn assert_attr(
    conn: &Connection,
    entity_id: i64,
    a: &NewAssertion<'_>,
) -> Result<Assertion, OntologyError> {
    let now = unix_now();
    conn.execute(
        "INSERT INTO ontology_attrs
            (entity_id, key, value, source, confidence, asserted_at, vocabulary_version, display_in_global_views)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            entity_id,
            a.key,
            a.value,
            a.source,
            a.confidence,
            now,
            VOCABULARY_VERSION,
            if a.display_in_global_views { 1 } else { 0 },
        ],
    )?;
    let id = conn.last_insert_rowid();
    Ok(Assertion {
        id,
        entity_id,
        key: a.key.to_string(),
        value: a.value.to_string(),
        source: a.source.to_string(),
        confidence: a.confidence,
        asserted_at: now,
        vocabulary_version: VOCABULARY_VERSION,
        display_in_global_views: a.display_in_global_views,
    })
}

pub fn get_attrs(
    conn: &Connection,
    entity_id: i64,
    key: &str,
) -> Result<Vec<Assertion>, OntologyError> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, entity_id, key, value, source, confidence, asserted_at, vocabulary_version, display_in_global_views
         FROM ontology_attrs WHERE entity_id = ?1 AND key = ?2",
    )?;
    let rows = stmt
        .query_map(params![entity_id, key], row_to_assertion)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Returns the *winning* assertion for an entity+key according to the
/// resolution discipline:
///   1. Highest confidence wins.
///   2. Ties broken by source_priority (user > extractor > rule > heuristic > phash > ml > system > unknown).
///   3. Final tiebreaker: most recent asserted_at.
pub fn resolve_attr(
    conn: &Connection,
    entity_id: i64,
    key: &str,
) -> Result<Option<Assertion>, OntologyError> {
    let candidates = get_attrs(conn, entity_id, key)?;
    Ok(candidates.into_iter().max_by(|a, b| {
        a.confidence
            .partial_cmp(&b.confidence)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| source_priority(&a.source).cmp(&source_priority(&b.source)))
            .then_with(|| a.asserted_at.cmp(&b.asserted_at))
    }))
}

fn row_to_assertion(row: &rusqlite::Row<'_>) -> rusqlite::Result<Assertion> {
    Ok(Assertion {
        id: row.get(0)?,
        entity_id: row.get(1)?,
        key: row.get(2)?,
        value: row.get(3)?,
        source: row.get(4)?,
        confidence: row.get::<_, f64>(5)? as f32,
        asserted_at: row.get(6)?,
        vocabulary_version: row.get(7)?,
        display_in_global_views: row.get::<_, i64>(8)? != 0,
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
    use crate::ontology::entities::upsert_entity;
    use crate::ontology::vocabulary::EntityKind;

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
        upsert_entity(conn, EntityKind::File, "/root/a.txt", Some(1), None, None)
            .unwrap()
            .id
    }

    #[test]
    fn assert_and_get_attrs() {
        let conn = migrated_conn();
        let eid = seed_file_entity(&conn);

        let a = assert_attr(
            &conn,
            eid,
            &NewAssertion {
                key: "role",
                value: "source",
                source: "rule:psd-extension",
                confidence: 0.85,
                display_in_global_views: true,
            },
        )
        .unwrap();

        assert!(a.id > 0);
        let fetched = get_attrs(&conn, eid, "role").unwrap();
        assert_eq!(fetched.len(), 1);
        assert_eq!(fetched[0].value, "source");
        assert_eq!(fetched[0].source, "rule:psd-extension");
        assert!((fetched[0].confidence - 0.85).abs() < 1e-6);
    }

    #[test]
    fn resolve_prefers_higher_confidence() {
        let conn = migrated_conn();
        let eid = seed_file_entity(&conn);

        assert_attr(&conn, eid, &NewAssertion {
            key: "role", value: "source",
            source: "rule:r1", confidence: 0.5, display_in_global_views: true,
        }).unwrap();
        assert_attr(&conn, eid, &NewAssertion {
            key: "role", value: "derivative",
            source: "heuristic:h1", confidence: 0.9, display_in_global_views: true,
        }).unwrap();

        let winner = resolve_attr(&conn, eid, "role").unwrap().unwrap();
        assert_eq!(winner.value, "derivative");
    }

    #[test]
    fn resolve_tie_broken_by_source_priority() {
        let conn = migrated_conn();
        let eid = seed_file_entity(&conn);

        // Same confidence, different source tiers.
        assert_attr(&conn, eid, &NewAssertion {
            key: "role", value: "source",
            source: "rule:r1", confidence: 0.7, display_in_global_views: true,
        }).unwrap();
        assert_attr(&conn, eid, &NewAssertion {
            key: "role", value: "derivative",
            source: "user", confidence: 0.7, display_in_global_views: true,
        }).unwrap();

        let winner = resolve_attr(&conn, eid, "role").unwrap().unwrap();
        assert_eq!(winner.value, "derivative", "user should beat rule on tie");
    }

    #[test]
    fn resolve_returns_none_when_absent() {
        let conn = migrated_conn();
        let eid = seed_file_entity(&conn);
        assert!(resolve_attr(&conn, eid, "role").unwrap().is_none());
    }
}
```

- [x] **Step 5.2: Run the tests**

Run: `cargo test --lib ontology::attrs::tests`
Expected: four tests pass.

- [x] **Step 5.3: Commit**

```bash
git add src/ontology/attrs.rs
git commit -m "feat(ontology): attribute CRUD with confidence-based resolution"
```

---

## Task 6: Relation CRUD

**Files:**
- Modify: `src/ontology/relations.rs`

**Goal:** `Relation` struct, `assert_relation`, `outbound`, `inbound`.

- [x] **Step 6.1: Write the implementation + tests**

Replace `src/ontology/relations.rs`:

```rust
//! Typed-relation CRUD.

use crate::ontology::{OntologyError, VOCABULARY_VERSION};
use rusqlite::{params, Connection};

#[derive(Debug, Clone, PartialEq)]
pub struct Relation {
    pub id: i64,
    pub subject_id: i64,
    pub predicate: String,
    pub object_id: i64,
    pub source: String,
    pub confidence: f32,
    pub asserted_at: i64,
    pub vocabulary_version: i64,
}

pub struct NewRelation<'a> {
    pub subject_id: i64,
    pub predicate: &'a str,
    pub object_id: i64,
    pub source: &'a str,
    pub confidence: f32,
}

pub fn assert_relation(conn: &Connection, r: &NewRelation<'_>) -> Result<Relation, OntologyError> {
    let now = unix_now();
    conn.execute(
        "INSERT INTO ontology_relations
            (subject_id, predicate, object_id, source, confidence, asserted_at, vocabulary_version)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            r.subject_id, r.predicate, r.object_id, r.source, r.confidence, now, VOCABULARY_VERSION
        ],
    )?;
    Ok(Relation {
        id: conn.last_insert_rowid(),
        subject_id: r.subject_id,
        predicate: r.predicate.to_string(),
        object_id: r.object_id,
        source: r.source.to_string(),
        confidence: r.confidence,
        asserted_at: now,
        vocabulary_version: VOCABULARY_VERSION,
    })
}

pub fn outbound(
    conn: &Connection,
    subject_id: i64,
    predicate: &str,
) -> Result<Vec<Relation>, OntologyError> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, subject_id, predicate, object_id, source, confidence, asserted_at, vocabulary_version
         FROM ontology_relations WHERE subject_id = ?1 AND predicate = ?2",
    )?;
    let rows = stmt
        .query_map(params![subject_id, predicate], row_to_relation)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn inbound(
    conn: &Connection,
    object_id: i64,
    predicate: &str,
) -> Result<Vec<Relation>, OntologyError> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, subject_id, predicate, object_id, source, confidence, asserted_at, vocabulary_version
         FROM ontology_relations WHERE object_id = ?1 AND predicate = ?2",
    )?;
    let rows = stmt
        .query_map(params![object_id, predicate], row_to_relation)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn row_to_relation(row: &rusqlite::Row<'_>) -> rusqlite::Result<Relation> {
    Ok(Relation {
        id: row.get(0)?,
        subject_id: row.get(1)?,
        predicate: row.get(2)?,
        object_id: row.get(3)?,
        source: row.get(4)?,
        confidence: row.get::<_, f64>(5)? as f32,
        asserted_at: row.get(6)?,
        vocabulary_version: row.get(7)?,
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
    use crate::ontology::entities::upsert_entity;
    use crate::ontology::vocabulary::{predicates, EntityKind};

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
        ).unwrap();
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, size, indexed_at)
             VALUES (1, 1, '/root/a.psd', 'a.psd', 100, 0),
                    (2, 1, '/root/a.png', 'a.png', 10, 0)",
            [],
        ).unwrap();
        let a = upsert_entity(conn, EntityKind::File, "/root/a.psd", Some(1), None, None).unwrap().id;
        let b = upsert_entity(conn, EntityKind::File, "/root/a.png", Some(2), None, None).unwrap().id;
        (a, b)
    }

    #[test]
    fn assert_outbound_inbound_round_trip() {
        let conn = migrated_conn();
        let (psd, png) = seed_two_file_entities(&conn);

        let r = assert_relation(&conn, &NewRelation {
            subject_id: png,
            predicate: predicates::DERIVED_FROM,
            object_id: psd,
            source: "heuristic:sibling-name",
            confidence: 0.55,
        }).unwrap();

        assert!(r.id > 0);
        let out = outbound(&conn, png, predicates::DERIVED_FROM).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].object_id, psd);

        let inb = inbound(&conn, psd, predicates::DERIVED_FROM).unwrap();
        assert_eq!(inb.len(), 1);
        assert_eq!(inb[0].subject_id, png);
    }

    #[test]
    fn multiple_assertions_accumulate() {
        let conn = migrated_conn();
        let (psd, png) = seed_two_file_entities(&conn);

        for source in &["heuristic:sibling-name", "user"] {
            assert_relation(&conn, &NewRelation {
                subject_id: png,
                predicate: predicates::DERIVED_FROM,
                object_id: psd,
                source,
                confidence: 0.8,
            }).unwrap();
        }
        let out = outbound(&conn, png, predicates::DERIVED_FROM).unwrap();
        assert_eq!(out.len(), 2);
    }
}
```

- [x] **Step 6.2: Run the tests**

Run: `cargo test --lib ontology::relations::tests`
Expected: two tests pass.

- [x] **Step 6.3: Commit**

```bash
git add src/ontology/relations.rs
git commit -m "feat(ontology): typed-relation CRUD"
```

---

## Task 7: Negative assertions

**Files:**
- Modify: `src/ontology/negative.rs`

**Goal:** Two kinds of rejection — relation rejection (`reject_pair`) and property rejection (`reject_property`); check helpers (`is_rejected_pair`, `is_rejected_property_value`).

- [x] **Step 7.1: Write the implementation + tests**

Replace `src/ontology/negative.rs`:

```rust
//! Negative assertion CRUD (user-rejected facts). Blocks re-suggestion.

use crate::ontology::OntologyError;
use rusqlite::{params, Connection};

pub fn reject_pair(
    conn: &Connection,
    subject_id: i64,
    predicate: &str,
    object_id: i64,
    reason: Option<&str>,
) -> Result<(), OntologyError> {
    conn.execute(
        "INSERT INTO ontology_negative_assertions
            (subject_id, predicate, object_id, rejected_at, reason)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![subject_id, predicate, object_id, unix_now(), reason],
    )?;
    Ok(())
}

pub fn reject_property(
    conn: &Connection,
    subject_id: i64,
    key: &str,
    value: &str,
    reason: Option<&str>,
) -> Result<(), OntologyError> {
    conn.execute(
        "INSERT INTO ontology_negative_assertions
            (subject_id, predicate, key, value, rejected_at, reason)
         VALUES (?1, 'property', ?2, ?3, ?4, ?5)",
        params![subject_id, key, value, unix_now(), reason],
    )?;
    Ok(())
}

pub fn is_rejected_pair(
    conn: &Connection,
    subject_id: i64,
    predicate: &str,
    object_id: i64,
) -> Result<bool, OntologyError> {
    let mut stmt = conn.prepare_cached(
        "SELECT 1 FROM ontology_negative_assertions
         WHERE subject_id = ?1 AND predicate = ?2 AND object_id = ?3
         LIMIT 1",
    )?;
    let exists = stmt.exists(params![subject_id, predicate, object_id])?;
    Ok(exists)
}

pub fn is_rejected_property_value(
    conn: &Connection,
    subject_id: i64,
    key: &str,
    value: &str,
) -> Result<bool, OntologyError> {
    let mut stmt = conn.prepare_cached(
        "SELECT 1 FROM ontology_negative_assertions
         WHERE subject_id = ?1 AND predicate = 'property' AND key = ?2 AND value = ?3
         LIMIT 1",
    )?;
    let exists = stmt.exists(params![subject_id, key, value])?;
    Ok(exists)
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
    use crate::ontology::entities::upsert_entity;
    use crate::ontology::vocabulary::{predicates, EntityKind};

    fn migrated_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        for (_, sql) in ALL_MIGRATIONS {
            conn.execute_batch(sql).unwrap();
        }
        conn
    }

    fn seed(conn: &Connection) -> (i64, i64) {
        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
             VALUES (1, NULL, '/root', 'root', 0, 0)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, size, indexed_at)
             VALUES (1, 1, '/root/a.psd', 'a.psd', 100, 0),
                    (2, 1, '/root/a.png', 'a.png', 10, 0)",
            [],
        ).unwrap();
        (
            upsert_entity(conn, EntityKind::File, "/root/a.psd", Some(1), None, None).unwrap().id,
            upsert_entity(conn, EntityKind::File, "/root/a.png", Some(2), None, None).unwrap().id,
        )
    }

    #[test]
    fn pair_rejection_round_trip() {
        let conn = migrated_conn();
        let (psd, png) = seed(&conn);
        assert!(!is_rejected_pair(&conn, png, predicates::DERIVED_FROM, psd).unwrap());

        reject_pair(&conn, png, predicates::DERIVED_FROM, psd, Some("not actually derived")).unwrap();
        assert!(is_rejected_pair(&conn, png, predicates::DERIVED_FROM, psd).unwrap());

        // Asymmetric: rejecting (png, derivedFrom, psd) does NOT reject (psd, derivedFrom, png).
        assert!(!is_rejected_pair(&conn, psd, predicates::DERIVED_FROM, png).unwrap());
    }

    #[test]
    fn property_rejection_round_trip() {
        let conn = migrated_conn();
        let (psd, _) = seed(&conn);
        assert!(!is_rejected_property_value(&conn, psd, "role", "scratch").unwrap());

        reject_property(&conn, psd, "role", "scratch", None).unwrap();
        assert!(is_rejected_property_value(&conn, psd, "role", "scratch").unwrap());

        // Different value: not rejected.
        assert!(!is_rejected_property_value(&conn, psd, "role", "system").unwrap());
    }
}
```

- [x] **Step 7.2: Run the tests**

Run: `cargo test --lib ontology::negative::tests`
Expected: two tests pass.

- [x] **Step 7.3: Commit**

```bash
git add src/ontology/negative.rs
git commit -m "feat(ontology): negative assertions for pair and property rejection"
```

---

## Task 8: Pin-to-keep

**Files:**
- Modify: `src/ontology/pinning.rs`

**Goal:** `pin_file`, `unpin_file`, `is_pinned`. Enforces Constitutional Defense #1.

- [x] **Step 8.1: Write the implementation + tests**

Replace `src/ontology/pinning.rs`:

```rust
//! Pin-to-keep CRUD. Files in this set are permanently excluded from
//! automated cleanup regardless of role/replaceability.

use crate::ontology::OntologyError;
use rusqlite::{params, Connection};

pub fn pin_file(conn: &Connection, file_id: i64, note: Option<&str>) -> Result<(), OntologyError> {
    conn.execute(
        "INSERT OR REPLACE INTO ontology_pinned_files (file_id, pinned_at, note)
         VALUES (?1, ?2, ?3)",
        params![file_id, unix_now(), note],
    )?;
    Ok(())
}

pub fn unpin_file(conn: &Connection, file_id: i64) -> Result<(), OntologyError> {
    conn.execute(
        "DELETE FROM ontology_pinned_files WHERE file_id = ?1",
        params![file_id],
    )?;
    Ok(())
}

pub fn is_pinned(conn: &Connection, file_id: i64) -> Result<bool, OntologyError> {
    let mut stmt = conn.prepare_cached(
        "SELECT 1 FROM ontology_pinned_files WHERE file_id = ?1 LIMIT 1",
    )?;
    Ok(stmt.exists(params![file_id])?)
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

    fn migrated_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        for (_, sql) in ALL_MIGRATIONS {
            conn.execute_batch(sql).unwrap();
        }
        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
             VALUES (1, NULL, '/root', 'root', 0, 0)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, size, indexed_at)
             VALUES (1, 1, '/root/x.txt', 'x.txt', 100, 0)",
            [],
        ).unwrap();
        conn
    }

    #[test]
    fn pin_unpin_round_trip() {
        let conn = migrated_conn();
        assert!(!is_pinned(&conn, 1).unwrap());

        pin_file(&conn, 1, Some("never delete")).unwrap();
        assert!(is_pinned(&conn, 1).unwrap());

        unpin_file(&conn, 1).unwrap();
        assert!(!is_pinned(&conn, 1).unwrap());
    }

    #[test]
    fn pin_is_idempotent() {
        let conn = migrated_conn();
        pin_file(&conn, 1, Some("a")).unwrap();
        pin_file(&conn, 1, Some("b")).unwrap(); // INSERT OR REPLACE
        assert!(is_pinned(&conn, 1).unwrap());
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM ontology_pinned_files WHERE file_id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }
}
```

- [x] **Step 8.2: Run the tests**

Run: `cargo test --lib ontology::pinning::tests`
Expected: two tests pass.

- [x] **Step 8.3: Commit**

```bash
git add src/ontology/pinning.rs
git commit -m "feat(ontology): pin-to-keep CRUD"
```

---

## Task 9: Sensitivity boundary helper

**Files:**
- Modify: `src/ontology/sensitivity.rs`

**Goal:** `is_globally_visible_file` and `is_globally_visible_folder` — the helpers every cross-cutting query MUST use to honor Constitutional Defense #3.

- [x] **Step 9.1: Write the implementation + tests**

Replace `src/ontology/sensitivity.rs`:

```rust
//! Sensitivity-containment helpers (Constitutional Defense #3).
//!
//! These helpers answer "should this file/folder appear in cross-cutting UI
//! results (search, treemap labels, discoveries, suggestions)?" The answer is
//! `false` if the entity has any `sensitivity` attribute with a `private` or
//! `restricted` value at confidence >= 0.5. Sensitive entities also have all
//! their attributes flagged `display_in_global_views = false` so extracted
//! metadata (titles, etc.) never leaks via global queries.

use crate::ontology::vocabulary::{keys, Sensitivity};
use crate::ontology::OntologyError;
use rusqlite::{params, Connection};

pub fn is_globally_visible_file(conn: &Connection, file_id: i64) -> Result<bool, OntologyError> {
    is_globally_visible(conn, "File", "linked_file_id", file_id)
}

pub fn is_globally_visible_folder(conn: &Connection, folder_id: i64) -> Result<bool, OntologyError> {
    is_globally_visible(conn, "Folder", "linked_folder_id", folder_id)
}

fn is_globally_visible(
    conn: &Connection,
    kind: &str,
    link_column: &str,
    linked_id: i64,
) -> Result<bool, OntologyError> {
    let sql = format!(
        "SELECT a.value
         FROM ontology_entities e
         JOIN ontology_attrs a ON a.entity_id = e.id
         WHERE e.kind = ?1
           AND e.{link_column} = ?2
           AND a.key = ?3
           AND a.confidence >= 0.5"
    );
    let mut stmt = conn.prepare_cached(&sql)?;
    let mut rows = stmt.query(params![kind, linked_id, keys::SENSITIVITY])?;

    while let Some(row) = rows.next()? {
        let value: String = row.get(0)?;
        if let Ok(s) = Sensitivity::from_str(&value) {
            if s.restricted_or_private() {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::schema::ALL_MIGRATIONS;
    use crate::ontology::attrs::{assert_attr, NewAssertion};
    use crate::ontology::entities::upsert_entity;
    use crate::ontology::vocabulary::EntityKind;

    fn migrated_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        for (_, sql) in ALL_MIGRATIONS {
            conn.execute_batch(sql).unwrap();
        }
        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
             VALUES (1, NULL, '/root', 'root', 0, 0)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, size, indexed_at)
             VALUES (1, 1, '/root/safe.txt', 'safe.txt', 100, 0),
                    (2, 1, '/root/secret.pdf', 'secret.pdf', 200, 0)",
            [],
        ).unwrap();
        conn
    }

    #[test]
    fn files_without_sensitivity_are_visible() {
        let conn = migrated_conn();
        upsert_entity(&conn, EntityKind::File, "/root/safe.txt", Some(1), None, None).unwrap();
        assert!(is_globally_visible_file(&conn, 1).unwrap());
    }

    #[test]
    fn restricted_files_are_hidden() {
        let conn = migrated_conn();
        let e = upsert_entity(&conn, EntityKind::File, "/root/secret.pdf", Some(2), None, None).unwrap();
        assert_attr(&conn, e.id, &NewAssertion {
            key: keys::SENSITIVITY,
            value: Sensitivity::Restricted.as_str(),
            source: "rule:path-personal-details",
            confidence: 1.0,
            display_in_global_views: true,
        }).unwrap();
        assert!(!is_globally_visible_file(&conn, 2).unwrap());
    }

    #[test]
    fn private_files_are_hidden() {
        let conn = migrated_conn();
        let e = upsert_entity(&conn, EntityKind::File, "/root/secret.pdf", Some(2), None, None).unwrap();
        assert_attr(&conn, e.id, &NewAssertion {
            key: keys::SENSITIVITY,
            value: Sensitivity::Private.as_str(),
            source: "user",
            confidence: 1.0,
            display_in_global_views: true,
        }).unwrap();
        assert!(!is_globally_visible_file(&conn, 2).unwrap());
    }

    #[test]
    fn low_confidence_sensitivity_does_not_hide() {
        let conn = migrated_conn();
        let e = upsert_entity(&conn, EntityKind::File, "/root/secret.pdf", Some(2), None, None).unwrap();
        assert_attr(&conn, e.id, &NewAssertion {
            key: keys::SENSITIVITY,
            value: Sensitivity::Restricted.as_str(),
            source: "heuristic:guess",
            confidence: 0.3,
            display_in_global_views: true,
        }).unwrap();
        assert!(is_globally_visible_file(&conn, 2).unwrap(), "confidence 0.3 is below the 0.5 floor");
    }

    #[test]
    fn folder_visibility_works_the_same_way() {
        let conn = migrated_conn();
        let e = upsert_entity(&conn, EntityKind::Folder, "/root", None, Some(1), None).unwrap();
        assert_attr(&conn, e.id, &NewAssertion {
            key: keys::SENSITIVITY,
            value: Sensitivity::Restricted.as_str(),
            source: "rule:path-personal-details",
            confidence: 1.0,
            display_in_global_views: true,
        }).unwrap();
        assert!(!is_globally_visible_folder(&conn, 1).unwrap());
    }
}
```

- [x] **Step 9.2: Run the tests**

Run: `cargo test --lib ontology::sensitivity::tests`
Expected: five tests pass.

- [x] **Step 9.3: Commit**

```bash
git add src/ontology/sensitivity.rs
git commit -m "feat(ontology): sensitivity containment helpers for files and folders"
```

---

## Task 10: Ontology-enabled toggle

**Files:**
- Modify: `src/ontology/enabled.rs`

**Goal:** Per-index opt-in. `enable`, `disable`, `is_enabled`.

- [x] **Step 10.1: Write the implementation + tests**

Replace `src/ontology/enabled.rs`:

```rust
//! Ontology-enabled toggle (per-index opt-in).
//!
//! A single row in `ontology_enabled` with `index_singleton = 1` controls
//! whether populators run and the layer's surfaces are exposed. Defaults to
//! disabled until explicitly enabled.

use crate::ontology::OntologyError;
use rusqlite::{params, Connection};

pub fn enable(conn: &Connection) -> Result<(), OntologyError> {
    set_enabled(conn, true)
}

pub fn disable(conn: &Connection) -> Result<(), OntologyError> {
    set_enabled(conn, false)
}

pub fn is_enabled(conn: &Connection) -> Result<bool, OntologyError> {
    let mut stmt = conn.prepare_cached(
        "SELECT enabled FROM ontology_enabled WHERE index_singleton = 1",
    )?;
    let row: Option<i64> = stmt
        .query_row([], |r| r.get(0))
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(0),
            other => Err(other),
        })
        .ok();
    Ok(matches!(row, Some(1)))
}

fn set_enabled(conn: &Connection, enabled: bool) -> Result<(), OntologyError> {
    conn.execute(
        "INSERT INTO ontology_enabled (index_singleton, enabled, changed_at)
         VALUES (1, ?1, ?2)
         ON CONFLICT(index_singleton) DO UPDATE SET enabled = excluded.enabled, changed_at = excluded.changed_at",
        params![if enabled { 1 } else { 0 }, unix_now()],
    )?;
    Ok(())
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

    fn migrated_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        for (_, sql) in ALL_MIGRATIONS {
            conn.execute_batch(sql).unwrap();
        }
        conn
    }

    #[test]
    fn defaults_to_disabled() {
        let conn = migrated_conn();
        assert!(!is_enabled(&conn).unwrap());
    }

    #[test]
    fn enable_then_disable() {
        let conn = migrated_conn();
        enable(&conn).unwrap();
        assert!(is_enabled(&conn).unwrap());

        disable(&conn).unwrap();
        assert!(!is_enabled(&conn).unwrap());
    }

    #[test]
    fn enable_is_idempotent() {
        let conn = migrated_conn();
        enable(&conn).unwrap();
        enable(&conn).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM ontology_enabled", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }
}
```

- [x] **Step 10.2: Run the tests**

Run: `cargo test --lib ontology::enabled::tests`
Expected: three tests pass.

- [x] **Step 10.3: Commit**

```bash
git add src/ontology/enabled.rs
git commit -m "feat(ontology): per-index enabled toggle"
```

---

## Task 11: Integration test — end-to-end foundation behavior

**Files:**
- Create: `tests/ontology_foundation.rs`

**Goal:** A crate-level integration test that exercises the entire foundation against an in-memory DB, asserting the constitutional invariants applicable to this plan:

- (#1 — pin) Pinned files are tracked correctly.
- (#3 — sensitivity) `is_globally_visible_file` excludes restricted/private files at confidence ≥ 0.5.
- (#7 — provenance) Every assertion carries source/confidence/asserted_at; resolution honors the discipline.

- [x] **Step 11.1: Write the integration test**

Create `tests/ontology_foundation.rs`:

```rust
use birds_eye::index::schema::ALL_MIGRATIONS;
use birds_eye::ontology::attrs::{assert_attr, get_attrs, resolve_attr, NewAssertion};
use birds_eye::ontology::enabled::{disable, enable, is_enabled};
use birds_eye::ontology::entities::{find_entity_for_file, upsert_entity};
use birds_eye::ontology::negative::{is_rejected_pair, reject_pair};
use birds_eye::ontology::pinning::{is_pinned, pin_file, unpin_file};
use birds_eye::ontology::relations::{assert_relation, outbound, NewRelation};
use birds_eye::ontology::sensitivity::is_globally_visible_file;
use birds_eye::ontology::vocabulary::{keys, predicates, EntityKind, Role, Sensitivity};
use rusqlite::Connection;

fn migrated() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    for (_, sql) in ALL_MIGRATIONS {
        conn.execute_batch(sql).unwrap();
    }
    conn.execute(
        "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
         VALUES (1, NULL, '/dataset', 'dataset', 0, 0),
                (2, 1, '/dataset/Personal Details', 'Personal Details', 1, 0),
                (3, 1, '/dataset/Toonie_world', 'Toonie_world', 1, 0)",
        [],
    ).unwrap();
    conn.execute(
        "INSERT INTO files (id, folder_id, path, name, size, indexed_at) VALUES
            (1, 2, '/dataset/Personal Details/id.pdf', 'id.pdf', 1000, 0),
            (2, 3, '/dataset/Toonie_world/List.psd', 'List.psd', 5_000_000, 0),
            (3, 3, '/dataset/Toonie_world/List_export.png', 'List_export.png', 200_000, 0)",
        [],
    ).unwrap();
    conn
}

#[test]
fn end_to_end_foundation_behavior() {
    let conn = migrated();

    // Toggle starts disabled.
    assert!(!is_enabled(&conn).unwrap());
    enable(&conn).unwrap();
    assert!(is_enabled(&conn).unwrap());

    // Materialize entities for each file.
    let id_pdf = upsert_entity(&conn, EntityKind::File, "/dataset/Personal Details/id.pdf", Some(1), None, None).unwrap();
    let psd    = upsert_entity(&conn, EntityKind::File, "/dataset/Toonie_world/List.psd", Some(2), None, None).unwrap();
    let png    = upsert_entity(&conn, EntityKind::File, "/dataset/Toonie_world/List_export.png", Some(3), None, None).unwrap();

    // id.pdf gets sensitivity=restricted from a path rule.
    assert_attr(&conn, id_pdf.id, &NewAssertion {
        key: keys::SENSITIVITY,
        value: Sensitivity::Restricted.as_str(),
        source: "rule:path-personal-details",
        confidence: 1.0,
        display_in_global_views: false,  // even the metadata flag is set
    }).unwrap();

    // List.psd is a source; List_export.png is a derivative from it.
    assert_attr(&conn, psd.id, &NewAssertion {
        key: keys::ROLE,
        value: Role::Source.as_str(),
        source: "rule:psd-extension",
        confidence: 0.85,
        display_in_global_views: true,
    }).unwrap();
    assert_attr(&conn, png.id, &NewAssertion {
        key: keys::ROLE,
        value: Role::Derivative.as_str(),
        source: "heuristic:sibling-name",
        confidence: 0.55,
        display_in_global_views: true,
    }).unwrap();
    assert_relation(&conn, &NewRelation {
        subject_id: png.id,
        predicate: predicates::DERIVED_FROM,
        object_id: psd.id,
        source: "heuristic:sibling-name",
        confidence: 0.55,
    }).unwrap();

    // Invariant: sensitive file is not globally visible.
    assert!(!is_globally_visible_file(&conn, 1).unwrap(), "restricted file leaked");
    // Invariant: non-sensitive files are visible.
    assert!(is_globally_visible_file(&conn, 2).unwrap());
    assert!(is_globally_visible_file(&conn, 3).unwrap());

    // Invariant: resolve_attr returns the highest-confidence value.
    let winning_role = resolve_attr(&conn, psd.id, keys::ROLE).unwrap().unwrap();
    assert_eq!(winning_role.value, "source");

    // Invariant: derivedFrom edge is traversable.
    let out = outbound(&conn, png.id, predicates::DERIVED_FROM).unwrap();
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].object_id, psd.id);

    // Invariant: pin-to-keep state survives unpin/re-pin.
    pin_file(&conn, 2, Some("keep all sources")).unwrap();
    assert!(is_pinned(&conn, 2).unwrap());
    unpin_file(&conn, 2).unwrap();
    assert!(!is_pinned(&conn, 2).unwrap());

    // Invariant: rejecting a pair blocks future re-suggestion.
    reject_pair(&conn, png.id, predicates::DERIVED_FROM, psd.id, Some("not actually derived")).unwrap();
    assert!(is_rejected_pair(&conn, png.id, predicates::DERIVED_FROM, psd.id).unwrap());

    // find_entity_for_file lookup is round-trip stable.
    assert_eq!(find_entity_for_file(&conn, 1).unwrap().unwrap().id, id_pdf.id);

    // Disabling does not destroy data.
    disable(&conn).unwrap();
    assert!(!is_enabled(&conn).unwrap());
    let attrs_after_disable = get_attrs(&conn, psd.id, keys::ROLE).unwrap();
    assert_eq!(attrs_after_disable.len(), 1, "data survives disable");
}
```

- [x] **Step 11.2: Run the integration test**

Run: `cargo test --test ontology_foundation`
Expected: PASS.

- [x] **Step 11.3: Run the full suite to ensure no regressions**

Run: `cargo test`
Expected: ALL tests pass — the existing Birds Eye tests plus all new ontology tests.

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: clean check (the desktop crate depends on this lib; verify it still builds).

- [x] **Step 11.4: Commit**

```bash
git add tests/ontology_foundation.rs
git commit -m "test(ontology): end-to-end integration test for Wave 1 foundation"
```

---

## Self-Review (executed before plan is closed)

**Spec coverage check (against `2026-05-26-birds-eye-ontology-wave-1-design.md`):**

Plan 1 covers spec sections:
- §4 Vocabulary (Wave 1 subset) — ✅ via Task 3 (vocabulary.rs) and the SQL schema's CHECK constraints in Task 1.
- §5 Storage model — ✅ via Task 1's MIGRATION_005 and the CRUD layer in Tasks 4–8.
- §3 Constitutional defenses, partial — ✅ #1 (pin-to-keep CRUD via Task 8), #3 (sensitivity helper via Task 9), #7 (provenance fields enforced by schema + resolved by `resolve_attr` in Task 5), #4 (vocabulary_version column present via Task 5, full migration UX deferred to a later plan).
- §14 Migration & rollback — ✅ partial: enabled toggle (Task 10). The user-facing first-time prompt is in a future frontend plan.

Plan 1 explicitly does NOT cover (intentional, in later plans):
- §6 Populator framework — Plan 2.
- §7 Cleanup engine — Plan 3.
- §8 Discoveries panel — Plans 3+4.
- §9 Treemap re-coloring — Plan 5.
- §10 Saved views — Plan 4.
- §11 Frontend surfaces — Plans 4 and 5.
- §12 Backend Tauri commands — Plan 4.
- §13 Testable invariants — populator, cleanup, and frontend invariants land in their respective plans. Foundation-applicable invariants (#3, #7, #9 pin behavior, #12 display_in_global_views default) are covered here.

**Placeholder scan:** No "TBD," "TODO," or "implement later" remain in this plan.

**Type consistency check:** `EntityKind`, `Role`, `Replaceability`, `Sensitivity`, `Lifecycle`, `Origin` names are consistent across Tasks 3, 4, 5, 6, 9, 11. `Assertion`, `NewAssertion`, `Relation`, `NewRelation` signatures match between definition (Tasks 5, 6) and use (Task 11). `unix_now()` is defined locally in each module that needs it — minor DRY violation but acceptable for foundation work; a `time` utility module is a fair refactor for a later plan.

---

## Future Plans (sequence)

Plan 1 (this document) ships testable but invisible storage. Subsequent plans:

- **Plan 2 — Populators & Orchestrator.** RulePopulator (with starter rule bundle), StructuralHeuristicPopulator (derivedFrom + backupOf), populator trait, orchestrator with pause/resume + budget. Hooks into the existing scan flow as Phase 2.
- **Plan 3 — Cleanup Engine Backend.** Cleanup predicate view, cleanup plan executor with recycle-bin-first via the existing `trash` crate, restore log, Tauri commands for cleanup ops.
- **Plan 4 — Frontend: Cleanup, Discoveries, Recently Cleaned, Saved Views.** React UI surfaces, Tauri command wrappers, file-detail-panel additions, Settings additions, first-time-enable prompt.
- **Plan 5 — Treemap Lenses.** Lens selector + Role/Replaceability/Lifecycle/Reclaimable-Mass color schemes.
- **Plan 6 — Metadata Extractors.** PDF, EXIF, ZIP central directory, ID3 with opt-in threshold prompts.
- **Plan 7 — Perceptual Hash & Near-Duplicate Cleanup.** Image pHash populator, near-duplicate clusters in Discoveries, dedup-as-graph-merge operational rule.

Each subsequent plan will be authored by re-invoking the writing-plans skill against the Wave 1 spec with the previous plan(s) as completed dependencies.
