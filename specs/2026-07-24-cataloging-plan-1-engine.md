# Cataloging Plan 1 — Suggestion Engine & Commands (Rust)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce relocation suggestion cards from the index and execute reviewed moves, entirely in the Rust crate — no UI.

**Architecture:** A new `CatalogPopulator` runs inside the existing opt-in ontology Phase-2 orchestrator at `CostTier::Cheap`. It scopes candidates to inbox zones, clusters them by `media_kind` refined with name patterns, infers a destination (user rule > learned home > template), and emits one `ontology_discoveries` row of kind `relocation` per cluster. A separate plan/execute command pair re-verifies against disk and performs the moves through an injectable `Mover` seam. Domain code lives in `src/ontology/catalog/`, mirroring `src/ontology/cleanup/`.

**Tech Stack:** Rust 2021, rusqlite (bundled SQLite), serde/serde_json. Crate is `birds-eye`, lib target `birds_eye`. No `[workspace]`, no dev-dependencies (**`tempfile` is unavailable** — hand-roll temp dirs).

## Global Constraints

- Repo root `src/` is the `birds-eye` lib crate. `src-tauri/` is a separate crate (`birds-eye-desktop`) holding only `main.rs`; it has **no tests** and is only `cargo check`ed.
- `src/native/api.rs` contains **zero** `#[tauri::command]` attributes. Commands are plain `pub fn`; the `#[tauri::command(async)]` wrapper lives in `src-tauri/src/main.rs`.
- Request DTOs derive `#[derive(Debug, Clone, Deserialize)]`; response DTOs derive `#[derive(Debug, Clone, Serialize, PartialEq)]`. `index_path` is always the first request field. Optional fields carry `#[serde(default)]`. **No `rename_all` anywhere** — snake_case crosses the wire verbatim.
- Errors are always `Result<T, String>` via `.map_err(|e| e.to_string())`. Never a typed error enum.
- Connections open **only** through `crate::index::open_index_connection(...)` (fully qualified, never imported).
- Migrations are `pub const MIGRATION_0NN: &str = r#"..."#;` raw SQL run by `execute_batch` **outside a transaction** — every statement must be `IF NOT EXISTS` so a partial failure re-runs cleanly. Every migration ends with the self-registering `INSERT OR IGNORE INTO schema_migrations` footer using `strftime('%s','now')`.
- The discoveries table is named **`ontology_discoveries`** (there is no table named `discoveries`).
- Tests are inline `#[cfg(test)] mod tests { use super::*; ... }` at the bottom of the module. DB tests use a local `fn migrated_conn() -> Connection` doing `Connection::open_in_memory()` + replay of `ALL_MIGRATIONS`. On-disk tests copy the local `test_root`/`write_file`/`cleanup` trio — **there is no shared test-helper module; duplicate the trio.**
- Verification gates (repo root, PowerShell):
  ```bash
  cargo test
  ```
  ```bash
  cargo check --manifest-path src-tauri\Cargo.toml
  ```
  There is no clippy, no rustfmt, no lint CI. Do not invent one.
- Discovery kind constant is the literal `"relocation"` throughout.

---

### Task 1: Migration 011 — catalog tables and indexes

**Files:**
- Modify: `src/index/schema.rs:1` (version), `src/index/schema.rs:504-517` (new const + array), `src/index/schema.rs:519-527` (pinned test)
- Test: `src/index/schema.rs` (inline `mod tests`)

**Interfaces:**
- Consumes: nothing.
- Produces: tables `catalog_rules`, `ontology_relocation_plans`, `ontology_relocation_plan_items`; indexes `idx_files_kind_folder`, `idx_discoveries_kind_status`, `idx_relocation_items_plan`. `CURRENT_SCHEMA_VERSION == 11`, `ALL_MIGRATIONS.len() == 11`.

- [ ] **Step 1: Write the failing test**

Add to the existing `#[cfg(test)] mod tests` in `src/index/schema.rs`, directly after `migration_010_creates_derived_stat_tables`:

```rust
    #[test]
    fn migration_011_creates_catalog_tables() {
        use rusqlite::Connection;
        let conn = Connection::open_in_memory().expect("open in-memory db");
        for (_, sql) in ALL_MIGRATIONS {
            conn.execute_batch(sql).expect("migration applies");
        }
        for table in [
            "catalog_rules",
            "ontology_relocation_plans",
            "ontology_relocation_plan_items",
        ] {
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |r| r.get(0),
                )
                .expect("query sqlite_master");
            assert_eq!(count, 1, "{table} must exist after migrations");
        }
        for index in [
            "idx_files_kind_folder",
            "idx_discoveries_kind_status",
            "idx_relocation_items_plan",
        ] {
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?1",
                    [index],
                    |r| r.get(0),
                )
                .expect("query sqlite_master");
            assert_eq!(count, 1, "{index} must exist after migrations");
        }
    }
```

Also update the pinned test in the same module:

```rust
    #[test]
    fn exposes_current_migration() {
        assert_eq!(CURRENT_SCHEMA_VERSION, 11);
        assert_eq!(ALL_MIGRATIONS.len(), 11);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --lib migration_011_creates_catalog_tables`
Expected: FAIL — `catalog_rules must exist after migrations` (left `0`, right `1`).

- [ ] **Step 3: Write minimal implementation**

Change line 1 of `src/index/schema.rs`:

```rust
pub const CURRENT_SCHEMA_VERSION: u32 = 11;
```

Add immediately after the `MIGRATION_010` const and before `pub const ALL_MIGRATIONS`:

```rust
pub const MIGRATION_011: &str = r#"
-- Cataloging: relocation suggestions and their reviewed execution.
-- `catalog_rules` holds user-taught destinations (saved after a manual move or
-- an edited suggestion) and outranks every inferred destination.
-- Relocation plans mirror ontology_cleanup_plans, except a relocation is an
-- explicit per-file (from, to) list rather than a recomputable scope predicate,
-- so the destinations live in the items table.
CREATE TABLE IF NOT EXISTS catalog_rules (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  criteria TEXT NOT NULL,
  destination TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('saved-after-move', 'saved-after-edit')),
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ontology_relocation_plans (
  id INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL,
  executed_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('draft', 'executed', 'cancelled'))
);

CREATE TABLE IF NOT EXISTS ontology_relocation_plan_items (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES ontology_relocation_plans(id) ON DELETE CASCADE,
  discovery_id INTEGER,
  file_id INTEGER NOT NULL,
  from_path TEXT NOT NULL,
  to_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('planned', 'moved', 'skipped', 'failed')) DEFAULT 'planned',
  note TEXT
);

CREATE INDEX IF NOT EXISTS idx_relocation_items_plan ON ontology_relocation_plan_items(plan_id, status);

-- Learned-home inference groups files by media_kind per folder; without this the
-- pass is a full scan of `files` for every kind on every enrichment run.
CREATE INDEX IF NOT EXISTS idx_files_kind_folder ON files(media_kind, folder_id);

-- Rejection suppression reads rejected rows of one kind; idx_discoveries_status_roi
-- leads with status and cannot serve a kind lookup.
CREATE INDEX IF NOT EXISTS idx_discoveries_kind_status ON ontology_discoveries(kind, status);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (11, strftime('%s', 'now'));
"#;
```

Append to the `ALL_MIGRATIONS` array as the last element:

```rust
    (11, MIGRATION_011),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --lib schema`
Expected: PASS — `exposes_current_migration`, `migration_011_creates_catalog_tables`, and all pre-existing schema tests.

- [ ] **Step 5: Commit**

```bash
git add src/index/schema.rs && git commit -m "feat(catalog): add migration 011 for catalog rules and relocation plans"
```

---

### Task 2: Inbox-zone resolution

**Files:**
- Create: `src/ontology/catalog/mod.rs`, `src/ontology/catalog/zones.rs`
- Modify: `src/ontology/mod.rs` (add `pub mod catalog;`)
- Test: inline in `src/ontology/catalog/zones.rs`

**Interfaces:**
- Consumes: `crate::ontology::OntologyError`.
- Produces:
  - `pub fn inbox_zones(conn: &Connection) -> Result<Vec<String>, OntologyError>`
  - `pub fn is_in_zone(path: &str, zones: &[String]) -> bool`
  - `pub fn is_drive_root(path: &str) -> bool`

- [ ] **Step 1: Write the failing test**

Create `src/ontology/catalog/zones.rs` containing only this test module for now:

```rust
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
    fn recognises_drive_roots_only() {
        assert!(is_drive_root("C:\\"));
        assert!(is_drive_root("D:"));
        assert!(!is_drive_root("D:\\Projects"));
        assert!(!is_drive_root("C:\\Users\\a\\Downloads"));
    }

    #[test]
    fn zone_membership_needs_a_separator_boundary() {
        let zones = vec!["C:\\Users\\a\\Downloads".to_string()];
        assert!(is_in_zone("C:\\Users\\a\\Downloads\\x.exe", &zones));
        assert!(is_in_zone("C:\\Users\\a\\Downloads", &zones));
        // A sibling folder that merely shares the prefix is NOT in the zone.
        assert!(!is_in_zone("C:\\Users\\a\\DownloadsOld\\x.exe", &zones));
    }

    #[test]
    fn indexed_drive_root_becomes_a_zone_but_a_deep_scan_root_does_not() {
        let conn = migrated_conn();
        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
             VALUES (1, NULL, 'D:\\', 'D:', 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
             VALUES (2, NULL, 'D:\\Projects', 'Projects', 0, 0)",
            [],
        )
        .unwrap();
        let zones = inbox_zones(&conn).unwrap();
        assert!(zones.iter().any(|z| z == "D:\\"), "drive root is a zone: {zones:?}");
        assert!(
            !zones.iter().any(|z| z == "D:\\Projects"),
            "a deep scan root is not a drive root: {zones:?}"
        );
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --lib zones`
Expected: FAIL to compile — `cannot find function is_drive_root in this scope`.

- [ ] **Step 3: Write minimal implementation**

Create `src/ontology/catalog/mod.rs`:

```rust
//! Cataloging: where files should live, and the reviewed moves that put them there.

pub mod zones;
```

Add `pub mod catalog;` to `src/ontology/mod.rs` alongside the existing `pub mod cleanup;`.

Prepend to `src/ontology/catalog/zones.rs` (above the test module):

```rust
//! Inbox-zone resolution.
//!
//! Cataloging only ever proposes moves for files sitting in an "inbox" — the
//! places downloads and stray files accumulate. Everything else is left alone,
//! because V1 has no folder-coherence classification to protect a real project.

use crate::ontology::OntologyError;
use rusqlite::Connection;

/// `C:\`, `D:` — a volume root, not a folder on one.
pub fn is_drive_root(path: &str) -> bool {
    let trimmed = path.trim_end_matches(['\\', '/']);
    trimmed.len() == 2 && trimmed.ends_with(':') && trimmed.starts_with(|c: char| c.is_ascii_alphabetic())
}

/// True when `path` is the zone itself or lives underneath it. Prefix matching
/// alone would put `DownloadsOld` inside `Downloads`, so a separator boundary is
/// required.
pub fn is_in_zone(path: &str, zones: &[String]) -> bool {
    zones.iter().any(|zone| {
        let zone = zone.trim_end_matches(['\\', '/']);
        if path.len() == zone.len() {
            return path.eq_ignore_ascii_case(zone);
        }
        path.len() > zone.len()
            && path[..zone.len()].eq_ignore_ascii_case(zone)
            && matches!(path.as_bytes()[zone.len()], b'\\' | b'/')
    })
}

/// The zones for this index: the user's Downloads and Desktop, plus any drive
/// root that is actually a scan root in this index.
///
/// Known limitation: Downloads and Desktop are resolved as `%USERPROFILE%\<name>`
/// rather than through `SHGetKnownFolderPath`, so a user who has relocated those
/// folders gets no candidates from them.
pub fn inbox_zones(conn: &Connection) -> Result<Vec<String>, OntologyError> {
    let mut zones = Vec::new();

    if let Some(home) = home_dir() {
        let home = home.trim_end_matches(['\\', '/']).to_string();
        zones.push(format!("{home}\\Downloads"));
        zones.push(format!("{home}\\Desktop"));
    }

    let mut stmt = conn.prepare("SELECT path FROM folders WHERE parent_id IS NULL")?;
    let roots = stmt.query_map([], |row| row.get::<_, String>(0))?;
    for root in roots {
        let root = root?;
        if is_drive_root(&root) {
            zones.push(root);
        }
    }

    Ok(zones)
}

fn home_dir() -> Option<String> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .filter(|value| !value.is_empty())
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --lib zones`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ontology/catalog src/ontology/mod.rs && git commit -m "feat(catalog): resolve inbox zones from env and indexed drive roots"
```

---

### Task 3: Non-graduating discovery kinds + kind-aware queries

**Files:**
- Modify: `src/ontology/discoveries_resolve.rs:153-190` (confirm/reject), `src/ontology/discoveries.rs` (new readers)
- Test: inline in both files

**Interfaces:**
- Consumes: `Discovery`, `DiscoveryStatus` from `src/ontology/discoveries.rs`.
- Produces:
  - `pub const NON_GRADUATING_KINDS: [&str; 1] = ["relocation"];` in `discoveries_resolve.rs`
  - `pub fn list_by_kind_and_status(conn: &Connection, kind: &str, status: DiscoveryStatus) -> Result<Vec<Discovery>, OntologyError>`
  - `pub fn count_pending_by_kind(conn: &Connection, kind: &str) -> Result<u64, OntologyError>`

- [ ] **Step 1: Write the failing test**

Add to the existing `#[cfg(test)] mod tests` in `src/ontology/discoveries_resolve.rs`:

```rust
    #[test]
    fn relocation_rejects_without_graduating() {
        let conn = migrated_conn();
        let id = insert_discovery(
            &conn,
            &NewDiscovery {
                kind: "relocation",
                payload_json: r#"{"destination":"D:\\Docs"}"#,
                confidence: 0.8,
                potential_bytes_unlocked: 1024,
            },
        )
        .unwrap();

        reject_discovery(&conn, id, Some("not there")).expect("reject must not error");

        let after = get_discovery(&conn, id).unwrap().unwrap();
        assert_eq!(after.status, DiscoveryStatus::Rejected);

        // A relocation has no subject/predicate/object triple, so nothing may be
        // written to the negative-assertion table on its behalf.
        let negatives: i64 = conn
            .query_row("SELECT COUNT(*) FROM ontology_negative_assertions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(negatives, 0, "relocation rejection must not assert a negative pair");
    }

    #[test]
    fn relocation_confirms_without_writing_facts() {
        let conn = migrated_conn();
        let id = insert_discovery(
            &conn,
            &NewDiscovery {
                kind: "relocation",
                payload_json: r#"{"destination":"D:\\Docs"}"#,
                confidence: 0.8,
                potential_bytes_unlocked: 1024,
            },
        )
        .unwrap();

        confirm_discovery(&conn, id).expect("confirm must not error");

        assert_eq!(
            get_discovery(&conn, id).unwrap().unwrap().status,
            DiscoveryStatus::Confirmed
        );
        let attrs: i64 = conn
            .query_row("SELECT COUNT(*) FROM ontology_attrs", [], |r| r.get(0))
            .unwrap();
        let relations: i64 = conn
            .query_row("SELECT COUNT(*) FROM ontology_relations", [], |r| r.get(0))
            .unwrap();
        assert_eq!((attrs, relations), (0, 0), "relocation must not graduate to facts");
    }
```

Add to the existing `#[cfg(test)] mod tests` in `src/ontology/discoveries.rs`:

```rust
    #[test]
    fn counts_and_lists_are_kind_scoped() {
        let conn = migrated_conn();
        for (kind, conf) in [("relocation", 0.9_f32), ("relocation", 0.5), ("backupOf-pair", 0.7)] {
            insert_discovery(
                &conn,
                &NewDiscovery {
                    kind,
                    payload_json: "{}",
                    confidence: conf,
                    potential_bytes_unlocked: 0,
                },
            )
            .unwrap();
        }

        assert_eq!(count_pending_by_kind(&conn, "relocation").unwrap(), 2);
        assert_eq!(count_pending_by_kind(&conn, "backupOf-pair").unwrap(), 1);
        assert_eq!(count_pending(&conn).unwrap(), 3);

        let rejected_before =
            list_by_kind_and_status(&conn, "relocation", DiscoveryStatus::Rejected).unwrap();
        assert!(rejected_before.is_empty());

        let first = list_pending_by_kind(&conn, "relocation", 10).unwrap()[0].id;
        crate::ontology::discoveries_resolve::reject_discovery(&conn, first, None).unwrap();

        let rejected_after =
            list_by_kind_and_status(&conn, "relocation", DiscoveryStatus::Rejected).unwrap();
        assert_eq!(rejected_after.len(), 1);
        assert_eq!(rejected_after[0].id, first);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --lib discoveries`
Expected: FAIL — `reject must not error: Populator("discovery kind relocation is not user-confirmable in Wave 1")`, and `cannot find function count_pending_by_kind`.

- [ ] **Step 3: Write minimal implementation**

In `src/ontology/discoveries_resolve.rs`, add above `fn graduation_plan`:

```rust
/// Discovery kinds that are user-resolvable but have no subject/predicate/object
/// triple to graduate into. Confirming one records the decision and nothing else;
/// crucially it must NOT write user-sourced facts, which resolve at confidence
/// 1.0 and feed the cleanup candidate view.
pub const NON_GRADUATING_KINDS: [&str; 1] = ["relocation"];

fn is_non_graduating(kind: &str) -> bool {
    NON_GRADUATING_KINDS.contains(&kind)
}
```

In `confirm_discovery`, insert the short-circuit immediately after the `if d.status != DiscoveryStatus::Pending { return Ok(()); }` guard and **before** the `graduation_plan` call:

```rust
    if is_non_graduating(&d.kind) {
        return set_status(conn, id, DiscoveryStatus::Confirmed);
    }
```

In `reject_discovery`, insert the same guard after its pending check and before its `graduation_plan` call:

```rust
    if is_non_graduating(&d.kind) {
        return set_status(conn, id, DiscoveryStatus::Rejected);
    }
```

In `src/ontology/discoveries.rs`, add after `count_pending`:

```rust
/// Pending count for one kind. `count_pending` spans every kind, which would
/// make a relocation card inflate the Board's finding badge.
pub fn count_pending_by_kind(conn: &Connection, kind: &str) -> Result<u64, OntologyError> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM ontology_discoveries WHERE status = 'pending' AND kind = ?1",
        params![kind],
        |row| row.get(0),
    )?;
    Ok(count as u64)
}

/// Rows of one kind in one status — the read path rejection-suppression needs,
/// since `list_pending_by_kind` hardcodes `status = 'pending'`.
pub fn list_by_kind_and_status(
    conn: &Connection,
    kind: &str,
    status: DiscoveryStatus,
) -> Result<Vec<Discovery>, OntologyError> {
    let mut stmt = conn.prepare(
        "SELECT id, kind, payload, status, confidence, potential_bytes_unlocked, created_at, resolved_at
         FROM ontology_discoveries
         WHERE kind = ?1 AND status = ?2
         ORDER BY id ASC",
    )?;
    let rows = stmt.query_map(params![kind, status.as_str()], row_to_discovery)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(OntologyError::from)
}
```

> If `discoveries.rs` has no `row_to_discovery` helper, reuse the closure body already used by `list_pending_by_kind` verbatim in its place.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --lib discoveries`
Expected: PASS — including the two new resolve tests and the kind-scoped query test.

- [ ] **Step 5: Commit**

```bash
git add src/ontology/discoveries.rs src/ontology/discoveries_resolve.rs && git commit -m "feat(catalog): allow non-graduating discovery kinds and kind-scoped queries"
```

---

### Task 4: Cluster payload types and fingerprinting

**Files:**
- Create: `src/ontology/catalog/payload.rs`
- Modify: `src/ontology/catalog/mod.rs`
- Test: inline in `src/ontology/catalog/payload.rs`

**Interfaces:**
- Produces:
  - `pub const RELOCATION_KIND: &str = "relocation";`
  - `pub const MEMBER_CAP: usize = 50;`
  - `pub struct RelocationMember { pub file_id: i64, pub path: String, pub name: String, pub size: i64 }`
  - `pub struct RelocationPayload { pub fingerprint, member_hash, destination, destination_exists, source, reason, zone, kind, member_count, total_bytes, members }`
  - `pub fn fingerprint(zone: &str, kind: &str, destination: &str) -> String`
  - `pub fn member_hash(file_ids: &[i64]) -> String`

- [ ] **Step 1: Write the failing test**

Create `src/ontology/catalog/payload.rs` with only this test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_is_stable_and_discriminating() {
        let a = fingerprint("C:\\Users\\a\\Downloads", "installer", "D:\\Software");
        assert_eq!(a, fingerprint("C:\\Users\\a\\Downloads", "installer", "D:\\Software"));
        assert_ne!(a, fingerprint("C:\\Users\\a\\Desktop", "installer", "D:\\Software"));
        assert_ne!(a, fingerprint("C:\\Users\\a\\Downloads", "document", "D:\\Software"));
        assert_ne!(a, fingerprint("C:\\Users\\a\\Downloads", "installer", "D:\\Apps"));
    }

    #[test]
    fn member_hash_ignores_order_but_not_membership() {
        assert_eq!(member_hash(&[3, 1, 2]), member_hash(&[1, 2, 3]));
        assert_ne!(member_hash(&[1, 2, 3]), member_hash(&[1, 2]));
        assert_ne!(member_hash(&[1, 2, 3]), member_hash(&[1, 2, 4]));
    }

    #[test]
    fn payload_round_trips_through_json() {
        let payload = RelocationPayload {
            fingerprint: "fp".to_string(),
            member_hash: "mh".to_string(),
            destination: "D:\\Docs".to_string(),
            destination_exists: false,
            source: "learned".to_string(),
            reason: "87% of your documents already live here".to_string(),
            zone: "C:\\Users\\a\\Downloads".to_string(),
            kind: "document".to_string(),
            member_count: 1,
            total_bytes: 10,
            members: vec![RelocationMember {
                file_id: 1,
                path: "C:\\Users\\a\\Downloads\\a.pdf".to_string(),
                name: "a.pdf".to_string(),
                size: 10,
            }],
        };
        let json = serde_json::to_string(&payload).unwrap();
        let back: RelocationPayload = serde_json::from_str(&json).unwrap();
        assert_eq!(back, payload);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --lib payload`
Expected: FAIL to compile — `cannot find function fingerprint in this scope`.

- [ ] **Step 3: Write minimal implementation**

Prepend to `src/ontology/catalog/payload.rs`:

```rust
//! The JSON payload carried by a `relocation` discovery row.

use serde::{Deserialize, Serialize};

pub const RELOCATION_KIND: &str = "relocation";

/// Members embedded in the payload. The full list is served lazily instead —
/// `list_pending_by_kind` SELECTs `payload` for every row and it crosses IPC as
/// an escaped string, so a 500-file cluster would be ~60 KB per card.
pub const MEMBER_CAP: usize = 50;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RelocationMember {
    pub file_id: i64,
    pub path: String,
    pub name: String,
    pub size: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RelocationPayload {
    pub fingerprint: String,
    pub member_hash: String,
    pub destination: String,
    pub destination_exists: bool,
    /// "rule" | "learned" | "template"
    pub source: String,
    pub reason: String,
    pub zone: String,
    pub kind: String,
    pub member_count: u64,
    pub total_bytes: u64,
    pub members: Vec<RelocationMember>,
}

/// Identity of a cluster across runs: same zone, same kind, same destination.
pub fn fingerprint(zone: &str, kind: &str, destination: &str) -> String {
    format!("{:016x}", fnv1a(&format!("{zone}\u{1f}{kind}\u{1f}{destination}")))
}

/// Identity of a cluster's membership. Sorted so row order never changes it.
pub fn member_hash(file_ids: &[i64]) -> String {
    let mut ids = file_ids.to_vec();
    ids.sort_unstable();
    let joined = ids.iter().map(|id| id.to_string()).collect::<Vec<_>>().join(",");
    format!("{:016x}", fnv1a(&joined))
}

/// FNV-1a 64. Not cryptographic — this only needs to be stable across runs and
/// cheap, and it avoids taking a hashing dependency for two identity strings.
fn fnv1a(input: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in input.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    hash
}
```

Add to `src/ontology/catalog/mod.rs`:

```rust
pub mod payload;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --lib payload`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ontology/catalog && git commit -m "feat(catalog): add relocation payload types and cluster fingerprints"
```

---

### Task 5: Candidate selection and clustering

**Files:**
- Create: `src/ontology/catalog/cluster.rs`
- Modify: `src/ontology/catalog/mod.rs`
- Test: inline in `src/ontology/catalog/cluster.rs`

**Interfaces:**
- Consumes: `zones::{inbox_zones, is_in_zone}`, `payload::RelocationMember`.
- Produces:
  - `pub struct Candidate { pub file_id: i64, pub path: String, pub name: String, pub size: i64, pub media_kind: String, pub zone: String }`
  - `pub fn candidates(conn: &Connection, zones: &[String]) -> Result<Vec<Candidate>, OntologyError>` — excludes protected roles
  - `pub fn refine_kind(media_kind: &str, name: &str) -> String`
  - `pub fn cluster(candidates: Vec<Candidate>) -> Vec<(String, String, Vec<Candidate>)>` — `(zone, refined_kind, members)`

- [ ] **Step 1: Write the failing test**

Create `src/ontology/catalog/cluster.rs` with only this test module:

```rust
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
        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
             VALUES (1, NULL, 'C:\\Inbox', 'Inbox', 0, 0)",
            [],
        )
        .unwrap();
        conn
    }

    fn add_file(conn: &Connection, id: i64, name: &str, kind: &str, size: i64) {
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, size, media_kind, indexed_at)
             VALUES (?1, 1, ?2, ?3, ?4, ?5, 0)",
            rusqlite::params![id, format!("C:\\Inbox\\{name}"), name, size, kind],
        )
        .unwrap();
    }

    fn add_role(conn: &Connection, file_id: i64, path: &str, role: &str) {
        conn.execute(
            "INSERT INTO ontology_entities (kind, canonical_id, linked_file_id, created_at)
             VALUES ('File', ?1, ?2, 0)",
            rusqlite::params![path, file_id],
        )
        .unwrap();
        let eid = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO ontology_attrs
                (entity_id, key, value, source, confidence, asserted_at, vocabulary_version, display_in_global_views)
             VALUES (?1, 'role', ?2, 'rule:test', 0.95, 0, 1, 1)",
            rusqlite::params![eid, role],
        )
        .unwrap();
    }

    #[test]
    fn only_files_inside_a_zone_are_candidates() {
        let conn = migrated_conn();
        add_file(&conn, 1, "setup.exe", "installer", 100);
        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
             VALUES (2, NULL, 'D:\\Work', 'Work', 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, size, media_kind, indexed_at)
             VALUES (2, 2, 'D:\\Work\\report.pdf', 'report.pdf', 50, 'document', 0)",
            [],
        )
        .unwrap();

        let zones = vec!["C:\\Inbox".to_string()];
        let found = candidates(&conn, &zones).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].file_id, 1);
    }

    #[test]
    fn protected_roles_are_excluded() {
        let conn = migrated_conn();
        for (id, name, role) in [
            (1_i64, "a.rs", Some("source")),
            (2, "b.dll", Some("system")),
            (3, "c.tmp", Some("scratch")),
            (4, "d.png", Some("asset")),
            (5, "keep.pdf", None),
        ] {
            add_file(&conn, id, name, "document", 10);
            if let Some(role) = role {
                add_role(&conn, id, &format!("C:\\Inbox\\{name}"), role);
            }
        }

        let found = candidates(&conn, &["C:\\Inbox".to_string()]).unwrap();
        assert_eq!(found.len(), 1, "only the unroled file survives: {found:?}");
        assert_eq!(found[0].name, "keep.pdf");
    }

    #[test]
    fn deleted_files_are_never_candidates() {
        let conn = migrated_conn();
        add_file(&conn, 1, "gone.exe", "installer", 100);
        conn.execute("UPDATE files SET deleted_at = 1 WHERE id = 1", []).unwrap();
        assert!(candidates(&conn, &["C:\\Inbox".to_string()]).unwrap().is_empty());
    }

    #[test]
    fn name_patterns_refine_the_coarse_media_kind() {
        assert_eq!(refine_kind("photo", "Screenshot 2026-01-02 101112.png"), "screenshot");
        assert_eq!(refine_kind("photo", "IMG_4821.JPG"), "camera-photo");
        assert_eq!(refine_kind("photo", "DSC_0001.jpg"), "camera-photo");
        assert_eq!(refine_kind("document", "invoice-jan.pdf"), "invoice");
        assert_eq!(refine_kind("document", "Receipt_2026.pdf"), "invoice");
        assert_eq!(refine_kind("document", "my-resume.docx"), "resume");
        // Nothing matched: the coarse kind stands.
        assert_eq!(refine_kind("document", "notes.md"), "document");
        assert_eq!(refine_kind("other", "thing.psd"), "other");
    }

    #[test]
    fn clusters_group_by_zone_and_refined_kind() {
        let make = |id: i64, name: &str, kind: &str| Candidate {
            file_id: id,
            path: format!("C:\\Inbox\\{name}"),
            name: name.to_string(),
            size: 10,
            media_kind: kind.to_string(),
            zone: "C:\\Inbox".to_string(),
        };
        let clusters = cluster(vec![
            make(1, "a.exe", "installer"),
            make(2, "b.exe", "installer"),
            make(3, "invoice-a.pdf", "document"),
            make(4, "notes.md", "document"),
        ]);

        let mut sizes: Vec<(String, usize)> = clusters
            .iter()
            .map(|(_, kind, members)| (kind.clone(), members.len()))
            .collect();
        sizes.sort();
        assert_eq!(
            sizes,
            vec![
                ("document".to_string(), 1),
                ("installer".to_string(), 2),
                ("invoice".to_string(), 1),
            ]
        );
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --lib cluster`
Expected: FAIL to compile — `cannot find function candidates in this scope`.

- [ ] **Step 3: Write minimal implementation**

Prepend to `src/ontology/catalog/cluster.rs`:

```rust
//! Candidate selection and clustering.

use crate::ontology::catalog::zones::is_in_zone;
use crate::ontology::OntologyError;
use rusqlite::Connection;
use std::collections::HashMap;

/// Roles that mean "this file belongs to something" — a checked-out repo or a
/// build directory sitting in Downloads is protected by its files' roles, since
/// V1 has no folder-coherence classification.
const PROTECTED_ROLES: [&str; 4] = ["system", "scratch", "source", "asset"];

#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub file_id: i64,
    pub path: String,
    pub name: String,
    pub size: i64,
    pub media_kind: String,
    pub zone: String,
}

/// Every live file inside an inbox zone that carries no protective role.
///
/// Resolves zones through `folders` first — there are orders of magnitude fewer
/// folders than files, so this never loads a 500k-row `files` table into memory
/// just to discard almost all of it.
pub fn candidates(conn: &Connection, zones: &[String]) -> Result<Vec<Candidate>, OntologyError> {
    if zones.is_empty() {
        return Ok(Vec::new());
    }

    // (folder_id, owning zone) for every indexed folder inside a zone.
    let mut zone_folders: Vec<(i64, String)> = Vec::new();
    {
        let mut stmt = conn.prepare("SELECT id, path FROM folders")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (id, path) = row?;
            if let Some(zone) = zones
                .iter()
                .find(|zone| is_in_zone(&path, std::slice::from_ref(*zone)))
            {
                zone_folders.push((id, zone.clone()));
            }
        }
    }
    if zone_folders.is_empty() {
        return Ok(Vec::new());
    }

    let zone_of: HashMap<i64, String> = zone_folders.iter().cloned().collect();
    let placeholders = std::iter::repeat("?")
        .take(zone_folders.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT f.id, f.folder_id, f.path, f.name, f.size, COALESCE(f.media_kind, 'other')
         FROM files f
         WHERE f.deleted_at IS NULL
           AND f.folder_id IN ({placeholders})
           AND NOT EXISTS (
             SELECT 1
             FROM ontology_entities e
             JOIN ontology_attrs a ON a.entity_id = e.id
             WHERE e.linked_file_id = f.id
               AND a.key = 'role'
               AND a.value IN ('system', 'scratch', 'source', 'asset')
           )
         ORDER BY f.id ASC"
    );

    let ids: Vec<i64> = zone_folders.iter().map(|(id, _)| *id).collect();
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(ids), |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, String>(5)?,
        ))
    })?;

    let mut out = Vec::new();
    for row in rows {
        let (file_id, folder_id, path, name, size, media_kind) = row?;
        let Some(zone) = zone_of.get(&folder_id) else {
            continue;
        };
        out.push(Candidate {
            file_id,
            path,
            name,
            size,
            media_kind,
            zone: zone.clone(),
        });
    }
    Ok(out)
}

/// `media_kind` is a nine-value extension whitelist, so `.psd`, `.svg`, `.iso`
/// and extensionless files all land in `other`. Name patterns carry the real
/// discrimination.
pub fn refine_kind(media_kind: &str, name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    let refined = match media_kind {
        "photo" if lower.starts_with("screenshot") || lower.starts_with("screen shot") => {
            Some("screenshot")
        }
        "photo" if lower.starts_with("img_") || lower.starts_with("dsc_") || lower.starts_with("dscf") => {
            Some("camera-photo")
        }
        "document" if lower.contains("invoice") || lower.contains("receipt") => Some("invoice"),
        "document" if lower.contains("resume") || lower.contains("cv-") => Some("resume"),
        _ => None,
    };
    refined.unwrap_or(media_kind).to_string()
}

/// One cluster per (zone, refined kind). Returned sorted by size descending so
/// the biggest wins are emitted first.
pub fn cluster(candidates: Vec<Candidate>) -> Vec<(String, String, Vec<Candidate>)> {
    let mut groups: HashMap<(String, String), Vec<Candidate>> = HashMap::new();
    for candidate in candidates {
        let kind = refine_kind(&candidate.media_kind, &candidate.name);
        groups
            .entry((candidate.zone.clone(), kind))
            .or_default()
            .push(candidate);
    }

    let mut out: Vec<(String, String, Vec<Candidate>)> = groups
        .into_iter()
        .map(|((zone, kind), members)| (zone, kind, members))
        .collect();
    out.sort_by(|a, b| b.2.len().cmp(&a.2.len()).then_with(|| a.1.cmp(&b.1)));
    out
}
```

Add to `src/ontology/catalog/mod.rs`:

```rust
pub mod cluster;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --lib cluster`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ontology/catalog && git commit -m "feat(catalog): select inbox candidates and cluster by zone and refined kind"
```

---

### Task 6: Destination inference

**Files:**
- Create: `src/ontology/catalog/infer.rs`, `src/ontology/catalog/rules.rs`
- Modify: `src/ontology/catalog/mod.rs`
- Test: inline in both files

**Interfaces:**
- Consumes: `cluster::Candidate`, `zones::is_in_zone`.
- Produces:
  - `rules.rs`: `pub struct CatalogRule { pub id: i64, pub name: String, pub criteria: RuleCriteria, pub destination: String, pub source: String, pub enabled: bool }`, `pub struct RuleCriteria { pub kind: Option<String>, pub name_contains: Option<String>, pub zone: Option<String> }`, `pub fn create_rule(conn, &NewCatalogRule) -> Result<i64, OntologyError>`, `pub fn list_rules(conn) -> Result<Vec<CatalogRule>, OntologyError>`, `pub fn delete_rule(conn, id) -> Result<(), OntologyError>`, `pub fn matches(rule: &CatalogRule, zone: &str, kind: &str, name: &str) -> bool`
  - `infer.rs`: `pub struct Destination { pub path: String, pub source: &'static str, pub reason: String, pub confidence: f32 }`, `pub fn infer(conn: &Connection, zones: &[String], zone: &str, kind: &str, sample_name: &str, media_kind: &str) -> Result<Option<Destination>, OntologyError>`

- [ ] **Step 1: Write the failing test**

Create `src/ontology/catalog/rules.rs` with this test module (implementation follows in step 3):

```rust
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
}
```

Create `src/ontology/catalog/infer.rs` with this test module:

```rust
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --lib catalog::`
Expected: FAIL to compile — `cannot find function create_rule`, `cannot find function infer`.

- [ ] **Step 3: Write minimal implementation**

Prepend to `src/ontology/catalog/rules.rs`:

```rust
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
        out.push(CatalogRule {
            id,
            name,
            criteria: serde_json::from_str(&criteria).unwrap_or_default(),
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
```

Prepend to `src/ontology/catalog/infer.rs`:

```rust
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
```

Add to `src/ontology/catalog/mod.rs`:

```rust
pub mod infer;
pub mod rules;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --lib catalog::`
Expected: PASS — the 2 rules tests and 5 infer tests.

> These tests read `USERPROFILE`/`HOME`, which exist in every environment this ships to. The `below_threshold_share_falls_through_to_template` test asserts the suffix only, never the absolute path.

- [ ] **Step 5: Commit**

```bash
git add src/ontology/catalog && git commit -m "feat(catalog): infer destinations from rules, learned homes, and templates"
```

---

### Task 7: The CatalogPopulator

**Files:**
- Create: `src/ontology/populators/catalog.rs`
- Modify: `src/ontology/populators/mod.rs` (add `pub mod catalog;`), `src/ontology/orchestrator.rs:7-20,159-171` (registration)
- Test: inline in `src/ontology/populators/catalog.rs`, plus an ordering test in `src/ontology/orchestrator.rs`

**Interfaces:**
- Consumes: everything from Tasks 2, 4, 5, 6; `Populator`, `PopulatorContext`, `PopulatorOutcome`, `CostTier`, `PopulatorError`.
- Produces: `pub struct CatalogPopulator;` with `pub fn new() -> Self`, implementing `Populator` with `name() == "CatalogPopulator"`, `cost_tier() == CostTier::Cheap`.

- [ ] **Step 1: Write the failing test**

Create `src/ontology/populators/catalog.rs` with this test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::schema::ALL_MIGRATIONS;
    use crate::ontology::catalog::payload::{RelocationPayload, RELOCATION_KIND};
    use crate::ontology::discoveries::{list_pending_by_kind, DiscoveryStatus};
    use crate::ontology::discoveries_resolve::reject_discovery;
    use crate::ontology::populators::{BudgetTier, PopulatorContext};
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

    fn ctx() -> PopulatorContext {
        PopulatorContext::new(BudgetTier::Standard, Arc::new(AtomicBool::new(false)))
    }

    /// An inbox zone with `count` installers, plus a learned home holding 20.
    fn seed(conn: &Connection, count: i64) {
        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
             VALUES (1, NULL, 'C:\\', 'C:', 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
             VALUES (2, NULL, 'D:\\Software', 'Software', 0, 0)",
            [],
        )
        .unwrap();
        for n in 0..count {
            conn.execute(
                "INSERT INTO files (id, folder_id, path, name, size, media_kind, indexed_at)
                 VALUES (?1, 1, ?2, ?3, 100, 'installer', 0)",
                rusqlite::params![n + 1, format!("C:\\setup{n}.exe"), format!("setup{n}.exe")],
            )
            .unwrap();
        }
        for n in 0..20 {
            conn.execute(
                "INSERT INTO files (id, folder_id, path, name, size, media_kind, indexed_at)
                 VALUES (?1, 2, ?2, 'app.exe', 100, 'installer', 0)",
                rusqlite::params![1000 + n, format!("D:\\Software\\app{n}.exe")],
            )
            .unwrap();
        }
    }

    #[test]
    fn emits_one_card_per_cluster_with_a_learned_destination() {
        let mut conn = migrated_conn();
        seed(&conn, 3);

        let outcome = CatalogPopulator::new().run(&mut conn, &mut ctx(), None).unwrap();
        assert!(matches!(outcome, PopulatorOutcome::Completed(_)));

        let cards = list_pending_by_kind(&conn, RELOCATION_KIND, 10).unwrap();
        assert_eq!(cards.len(), 1, "one cluster, one card");

        let payload: RelocationPayload = serde_json::from_str(&cards[0].payload).unwrap();
        assert_eq!(payload.destination, "D:\\Software");
        assert_eq!(payload.source, "learned");
        assert_eq!(payload.member_count, 3);
        assert_eq!(payload.total_bytes, 300);
        assert_eq!(cards[0].potential_bytes_unlocked, 300);
    }

    #[test]
    fn does_not_re_emit_an_unchanged_rejected_cluster() {
        let mut conn = migrated_conn();
        seed(&conn, 3);

        CatalogPopulator::new().run(&mut conn, &mut ctx(), None).unwrap();
        let first = list_pending_by_kind(&conn, RELOCATION_KIND, 10).unwrap();
        reject_discovery(&conn, first[0].id, Some("no thanks")).unwrap();

        CatalogPopulator::new().run(&mut conn, &mut ctx(), None).unwrap();
        assert!(
            list_pending_by_kind(&conn, RELOCATION_KIND, 10).unwrap().is_empty(),
            "a rejected cluster with unchanged membership must stay rejected"
        );
    }

    #[test]
    fn re_emits_once_membership_changes() {
        let mut conn = migrated_conn();
        seed(&conn, 3);

        CatalogPopulator::new().run(&mut conn, &mut ctx(), None).unwrap();
        let first = list_pending_by_kind(&conn, RELOCATION_KIND, 10).unwrap();
        reject_discovery(&conn, first[0].id, None).unwrap();

        // A new download lands in the same zone.
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, size, media_kind, indexed_at)
             VALUES (99, 1, 'C:\\new-setup.exe', 'new-setup.exe', 100, 'installer', 0)",
            [],
        )
        .unwrap();

        CatalogPopulator::new().run(&mut conn, &mut ctx(), None).unwrap();
        let second = list_pending_by_kind(&conn, RELOCATION_KIND, 10).unwrap();
        assert_eq!(second.len(), 1, "changed membership re-opens the question");
    }

    #[test]
    fn does_not_duplicate_a_still_pending_card() {
        let mut conn = migrated_conn();
        seed(&conn, 3);

        CatalogPopulator::new().run(&mut conn, &mut ctx(), None).unwrap();
        CatalogPopulator::new().run(&mut conn, &mut ctx(), None).unwrap();

        assert_eq!(list_pending_by_kind(&conn, RELOCATION_KIND, 10).unwrap().len(), 1);
    }

    #[test]
    fn caps_the_embedded_member_list() {
        let mut conn = migrated_conn();
        seed(&conn, 120);

        CatalogPopulator::new().run(&mut conn, &mut ctx(), None).unwrap();
        let cards = list_pending_by_kind(&conn, RELOCATION_KIND, 10).unwrap();
        let payload: RelocationPayload = serde_json::from_str(&cards[0].payload).unwrap();

        assert_eq!(payload.member_count, 120, "the count is the truth");
        assert_eq!(payload.members.len(), 50, "the embedded list is capped");
    }

    #[test]
    fn emits_nothing_when_no_zone_has_candidates() {
        let mut conn = migrated_conn();
        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
             VALUES (1, NULL, 'D:\\Projects', 'Projects', 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, size, media_kind, indexed_at)
             VALUES (1, 1, 'D:\\Projects\\a.exe', 'a.exe', 10, 'installer', 0)",
            [],
        )
        .unwrap();

        CatalogPopulator::new().run(&mut conn, &mut ctx(), None).unwrap();
        assert!(list_pending_by_kind(&conn, RELOCATION_KIND, 10).unwrap().is_empty());
    }
}
```

Add to the `#[cfg(test)] mod tests` in `src/ontology/orchestrator.rs`:

```rust
    #[test]
    fn catalog_runs_last_among_cheap_populators() {
        let orchestrator = PopulatorOrchestrator::default();
        let names: Vec<&str> = orchestrator.ordered().iter().map(|p| p.name()).collect();
        let catalog = names.iter().position(|n| *n == "CatalogPopulator").expect("registered");
        let rules = names.iter().position(|n| *n == "RulePopulator").expect("registered");
        assert!(
            rules < catalog,
            "CatalogPopulator must see RulePopulator's role facts: {names:?}"
        );
    }
```

> `ordered()` is private; make it `pub(crate) fn ordered` if the test cannot reach it, or assert through an existing public accessor if one exists.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --lib catalog`
Expected: FAIL to compile — `cannot find struct CatalogPopulator`.

- [ ] **Step 3: Write minimal implementation**

Prepend to `src/ontology/populators/catalog.rs`:

```rust
//! Relocation-suggestion populator.
//!
//! Reads the index only. One cluster of stray files in an inbox zone becomes one
//! `relocation` discovery, carrying the destination, the evidence for it, and a
//! capped member list.

use crate::ontology::catalog::cluster::{candidates, cluster};
use crate::ontology::catalog::infer::infer;
use crate::ontology::catalog::payload::{
    fingerprint, member_hash, RelocationMember, RelocationPayload, MEMBER_CAP, RELOCATION_KIND,
};
use crate::ontology::catalog::zones::inbox_zones;
use crate::ontology::discoveries::{
    insert_discovery, list_by_kind_and_status, list_pending_by_kind, DiscoveryStatus, NewDiscovery,
};
use crate::ontology::populators::{
    CostTier, Populator, PopulatorContext, PopulatorError, PopulatorOutcome,
};
use rusqlite::Connection;
use std::collections::HashSet;

pub struct CatalogPopulator;

impl CatalogPopulator {
    pub fn new() -> Self {
        Self
    }
}

impl Default for CatalogPopulator {
    fn default() -> Self {
        Self::new()
    }
}

impl Populator for CatalogPopulator {
    fn name(&self) -> &'static str {
        "CatalogPopulator"
    }

    fn cost_tier(&self) -> CostTier {
        CostTier::Cheap
    }

    fn run(
        &self,
        conn: &mut Connection,
        ctx: &mut PopulatorContext,
        _resume_cursor: Option<&str>,
    ) -> Result<PopulatorOutcome, PopulatorError> {
        if ctx.is_paused() {
            return Ok(PopulatorOutcome::Paused {
                cursor: String::new(),
                partial: ctx.snapshot(),
            });
        }

        let zones = inbox_zones(conn)?;
        if zones.is_empty() {
            return Ok(PopulatorOutcome::Completed(ctx.snapshot()));
        }

        let found = candidates(conn, &zones)?;
        for _ in &found {
            ctx.note_file();
        }

        // Suppression keys: a cluster already answered (rejected) or already
        // asked (pending) with the same membership is not asked again.
        let mut seen: HashSet<(String, String)> = HashSet::new();
        for status in [DiscoveryStatus::Rejected, DiscoveryStatus::Pending] {
            for existing in list_by_kind_and_status(conn, RELOCATION_KIND, status)? {
                if let Ok(payload) = serde_json::from_str::<RelocationPayload>(&existing.payload) {
                    seen.insert((payload.fingerprint, payload.member_hash));
                }
            }
        }

        for (zone, kind, members) in cluster(found) {
            if ctx.is_paused() {
                return Ok(PopulatorOutcome::Paused {
                    cursor: String::new(),
                    partial: ctx.snapshot(),
                });
            }

            let sample = members[0].name.clone();
            let media_kind = members[0].media_kind.clone();
            let Some(destination) = infer(conn, &zones, &zone, &kind, &sample, &media_kind)? else {
                continue;
            };

            let ids: Vec<i64> = members.iter().map(|m| m.file_id).collect();
            let fp = fingerprint(&zone, &kind, &destination.path);
            let mh = member_hash(&ids);
            if seen.contains(&(fp.clone(), mh.clone())) {
                continue;
            }

            let total_bytes: u64 = members.iter().map(|m| m.size.max(0) as u64).sum();
            let payload = RelocationPayload {
                fingerprint: fp,
                member_hash: mh,
                destination_exists: std::path::Path::new(&destination.path).is_dir(),
                destination: destination.path,
                source: destination.source.to_string(),
                reason: destination.reason,
                zone,
                kind,
                member_count: members.len() as u64,
                total_bytes,
                members: members
                    .iter()
                    .take(MEMBER_CAP)
                    .map(|m| RelocationMember {
                        file_id: m.file_id,
                        path: m.path.clone(),
                        name: m.name.clone(),
                        size: m.size,
                    })
                    .collect(),
            };

            insert_discovery(
                conn,
                &NewDiscovery {
                    kind: RELOCATION_KIND,
                    payload_json: &serde_json::to_string(&payload)?,
                    confidence: destination.confidence,
                    // "bytes moved" for this kind. The column is the primary
                    // ORDER BY key, so all-zero rows would make the LIMIT an
                    // arbitrary cut.
                    potential_bytes_unlocked: total_bytes,
                },
            )?;
            ctx.note_discovery();
        }

        let _ = list_pending_by_kind(conn, RELOCATION_KIND, 1)?;
        Ok(PopulatorOutcome::Completed(ctx.snapshot()))
    }
}
```

Add `pub mod catalog;` as the first entry of the module list at the top of `src/ontology/populators/mod.rs` (alphabetical: catalog, extractors, heuristics, phash, rules).

In `src/ontology/orchestrator.rs`, add the import:

```rust
use crate::ontology::populators::catalog::CatalogPopulator;
```

and add to the `Default` vec **after** `RulePopulator` (same `Cheap` tier, and `sort_by_key` is stable so declaration order is preserved):

```rust
            Box::new(CatalogPopulator::new()),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --lib catalog`
Expected: PASS — 6 populator tests plus the orchestrator ordering test.

- [ ] **Step 5: Commit**

```bash
git add src/ontology && git commit -m "feat(catalog): emit relocation suggestions from a new CatalogPopulator"
```

---

### Task 8: Fix the orphan-copy hazard in move_files

**Files:**
- Modify: `src/native/api.rs:313-317`
- Test: inline in `src/native/api.rs`

**Interfaces:**
- Consumes: nothing new.
- Produces: unchanged public signature; `move_files` no longer leaves a destination copy behind when the source cannot be removed.

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` in `src/native/api.rs`:

```rust
    #[test]
    fn move_reports_failure_without_leaving_a_destination_copy() {
        let root = test_root("move-orphan");
        let source_dir = root.join("src");
        let dest_dir = root.join("dst");
        fs::create_dir_all(&source_dir).expect("create source dir");
        fs::create_dir_all(&dest_dir).expect("create dest dir");

        let from = source_dir.join("a.bin");
        write_file(&from, b"payload");

        // A destination whose parent is a FILE, not a directory: create_dir_all
        // fails, so nothing may be written and nothing may be reported as moved.
        let blocker = dest_dir.join("blocker");
        write_file(&blocker, b"x");
        let to = blocker.join("a.bin");

        let response = move_files(MoveFilesRequest {
            moves: vec![MoveSpec {
                from: from.to_string_lossy().to_string(),
                to: to.to_string_lossy().to_string(),
            }],
            index_path: None,
        });

        assert_eq!(response.moved, 0);
        assert_eq!(response.failed.len(), 1);
        assert!(from.exists(), "the source must survive a failed move");
        assert!(!to.exists(), "no orphan copy may remain at the destination");

        cleanup(&root);
    }
```

- [ ] **Step 2: Run the test and record that it passes**

Run: `cargo test --lib move_reports_failure_without_leaving_a_destination_copy`
Expected: **PASS**, before any change.

**This task is deliberately not TDD, and the report must say so.** The bug is a copy-succeeds/remove-fails race that cannot be provoked portably — it needs a source file held open by another process with the right share mode. This test pins the *invariant* ("a failed move leaves no orphan at the destination") on the path that IS reachable, so a future refactor cannot regress it. The fix itself is verified by inspection. Do not claim a RED phase that did not happen.

- [ ] **Step 3: Write the implementation**

Replace the `let result = ...` block in `move_files` (`src/native/api.rs:313-317`):

```rust
        let result = std::fs::rename(&spec.from, to).or_else(|_| {
            // Cross-volume move: copy then remove the source. If the source
            // cannot be removed (commonly a Windows lock), roll the copy back —
            // otherwise the file exists at BOTH paths while we report failure,
            // and the retry hits `to.exists()` forever.
            std::fs::copy(&spec.from, to).and_then(|_| {
                std::fs::remove_file(&spec.from).inspect_err(|_| {
                    let _ = std::fs::remove_file(to);
                })
            })
        });
```

> If the crate's Rust version predates `Result::inspect_err` (stable 1.76), use:
> ```rust
>                 match std::fs::remove_file(&spec.from) {
>                     Ok(()) => Ok(()),
>                     Err(error) => {
>                         let _ = std::fs::remove_file(to);
>                         Err(error)
>                     }
>                 }
> ```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --lib move_`
Expected: PASS — the new test and every pre-existing `move_files` test.

- [ ] **Step 5: Commit**

```bash
git add src/native/api.rs && git commit -m "fix(move): roll back the copy when the source cannot be removed"
```

---

### Task 9: Relocation plans — persist, re-verify, execute

**Files:**
- Create: `src/ontology/catalog/plans.rs`, `src/ontology/catalog/executor.rs`
- Modify: `src/ontology/catalog/mod.rs`
- Test: inline in both files

**Interfaces:**
- Consumes: migration 011 tables; `payload::RelocationPayload`.
- Produces:
  - `plans.rs`: `pub struct PlanItem { pub file_id: i64, pub from_path: String, pub to_path: String, pub size: i64, pub discovery_id: Option<i64> }`, `pub struct PlannedItem { pub id: i64, pub file_id: i64, pub from_path: String, pub to_path: String, pub size: i64, pub status: String, pub note: Option<String> }`, `pub fn create_plan(conn: &Connection, items: &[PlanItem]) -> Result<i64, OntologyError>`, `pub fn plan_items(conn: &Connection, plan_id: i64) -> Result<Vec<PlannedItem>, OntologyError>`, `pub fn set_plan_status(conn, plan_id, status: &str) -> Result<(), OntologyError>`, `pub fn set_item_status(conn, item_id, status: &str, note: Option<&str>) -> Result<(), OntologyError>`
  - `executor.rs`: `pub trait Mover { fn move_one(&self, from: &str, to: &str) -> Result<(), String>; }`, `pub struct SystemMover;`, `pub struct RelocationResult { pub plan_id: i64, pub moved: u64, pub bytes_moved: u64, pub pairs: Vec<MovedPair>, pub failed: Vec<RelocationFailure> }`, `pub struct MovedPair { pub from: String, pub to: String }`, `pub struct RelocationFailure { pub path: String, pub reason: String }`, `pub fn execute_plan_with(conn: &mut Connection, plan_id: i64, mover: &dyn Mover) -> Result<RelocationResult, OntologyError>`

- [ ] **Step 1: Write the failing test**

Create `src/ontology/catalog/plans.rs` with this test module:

```rust
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
    fn creates_a_draft_plan_with_per_file_destinations() {
        let conn = migrated_conn();
        let plan_id = create_plan(
            &conn,
            &[
                PlanItem {
                    file_id: 1,
                    from_path: "C:\\Inbox\\a.exe".to_string(),
                    to_path: "D:\\Software\\a.exe".to_string(),
                    size: 10,
                    discovery_id: Some(7),
                },
                PlanItem {
                    file_id: 2,
                    from_path: "C:\\Inbox\\b.exe".to_string(),
                    to_path: "D:\\Software\\b.exe".to_string(),
                    size: 20,
                    discovery_id: Some(7),
                },
            ],
        )
        .unwrap();

        let items = plan_items(&conn, plan_id).unwrap();
        assert_eq!(items.len(), 2);
        assert!(items.iter().all(|i| i.status == "planned"));
        // Each item carries its OWN destination — this is what a cleanup scope
        // predicate cannot express.
        assert_eq!(items[0].to_path, "D:\\Software\\a.exe");
        assert_eq!(items[1].to_path, "D:\\Software\\b.exe");

        let status: String = conn
            .query_row(
                "SELECT status FROM ontology_relocation_plans WHERE id = ?1",
                [plan_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(status, "draft");
    }

    #[test]
    fn item_status_and_note_persist() {
        let conn = migrated_conn();
        let plan_id = create_plan(
            &conn,
            &[PlanItem {
                file_id: 1,
                from_path: "a".to_string(),
                to_path: "b".to_string(),
                size: 1,
                discovery_id: None,
            }],
        )
        .unwrap();
        let item_id = plan_items(&conn, plan_id).unwrap()[0].id;

        set_item_status(&conn, item_id, "skipped", Some("vanished")).unwrap();

        let after = plan_items(&conn, plan_id).unwrap();
        assert_eq!(after[0].status, "skipped");
        assert_eq!(after[0].note.as_deref(), Some("vanished"));
    }
}
```

Create `src/ontology/catalog/executor.rs` with this test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::schema::ALL_MIGRATIONS;
    use crate::ontology::catalog::plans::{create_plan, plan_items, PlanItem};
    use rusqlite::Connection;
    use std::cell::RefCell;

    fn test_root(name: &str) -> std::path::PathBuf {
        let root = std::env::current_dir()
            .expect("failed to get current dir")
            .join("target")
            .join("catalog-executor-tests")
            .join(format!(
                "{}-{}",
                name,
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .expect("clock before epoch")
                    .as_nanos()
            ));
        cleanup(&root);
        std::fs::create_dir_all(&root).expect("create test root");
        root
    }

    fn cleanup(root: &std::path::Path) {
        if root.exists() {
            std::fs::remove_dir_all(root).expect("failed to remove test folder");
        }
    }

    fn migrated_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        for (_, sql) in ALL_MIGRATIONS {
            conn.execute_batch(sql).unwrap();
        }
        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
             VALUES (1, NULL, 'C:\\Inbox', 'Inbox', 0, 0)",
            [],
        )
        .unwrap();
        conn
    }

    /// Writes a REAL file and indexes it. `execute_plan_with` stats the disk at
    /// execute time, so a row pointing at a path that does not exist is skipped —
    /// these fixtures must be real.
    fn seed_file(conn: &Connection, id: i64, path: &std::path::Path) {
        std::fs::write(path, [7u8; 10]).expect("write fixture file");
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, size, media_kind, indexed_at)
             VALUES (?1, 1, ?2, 'f.exe', 10, 'installer', 0)",
            rusqlite::params![id, path.to_string_lossy()],
        )
        .expect("index fixture file");
    }

    /// Records calls and fails any move whose source is in `fail`.
    struct FakeMover {
        fail: Vec<String>,
        calls: RefCell<Vec<(String, String)>>,
    }

    impl Mover for FakeMover {
        fn move_one(&self, from: &str, to: &str) -> Result<(), String> {
            self.calls.borrow_mut().push((from.to_string(), to.to_string()));
            if self.fail.iter().any(|f| f == from) {
                return Err("locked by another process".to_string());
            }
            Ok(())
        }
    }

    #[test]
    fn moves_every_item_and_returns_reversible_pairs() {
        let root = test_root("moves-every-item");
        let from = root.join("a.exe");
        let to = root.join("dest").join("a.exe");
        let mut conn = migrated_conn();
        seed_file(&conn, 1, &from);
        let plan_id = create_plan(
            &conn,
            &[PlanItem {
                file_id: 1,
                from_path: from.to_string_lossy().to_string(),
                to_path: to.to_string_lossy().to_string(),
                size: 10,
                discovery_id: None,
            }],
        )
        .unwrap();

        let mover = FakeMover { fail: vec![], calls: RefCell::new(vec![]) };
        let result = execute_plan_with(&mut conn, plan_id, &mover).unwrap();

        assert_eq!(result.moved, 1);
        assert_eq!(result.bytes_moved, 10);
        assert_eq!(result.pairs.len(), 1);
        assert_eq!(result.pairs[0].from, from.to_string_lossy());
        assert_eq!(result.pairs[0].to, to.to_string_lossy());
        assert!(result.failed.is_empty());

        // The source row is marked deleted so views drop it before the rescan.
        let deleted: Option<i64> = conn
            .query_row("SELECT deleted_at FROM files WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert!(deleted.is_some());

        let status: String = conn
            .query_row(
                "SELECT status FROM ontology_relocation_plans WHERE id = ?1",
                [plan_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(status, "executed");
        assert_eq!(plan_items(&conn, plan_id).unwrap()[0].status, "moved");
        cleanup(&root);
    }

    #[test]
    fn a_partial_failure_keeps_the_good_moves_and_records_the_bad() {
        let root = test_root("partial-failure");
        let ok = root.join("ok.exe");
        let locked = root.join("locked.exe");
        let mut conn = migrated_conn();
        seed_file(&conn, 1, &ok);
        seed_file(&conn, 2, &locked);
        let plan_id = create_plan(
            &conn,
            &[
                PlanItem {
                    file_id: 1,
                    from_path: ok.to_string_lossy().to_string(),
                    to_path: root.join("dest").join("ok.exe").to_string_lossy().to_string(),
                    size: 10,
                    discovery_id: None,
                },
                PlanItem {
                    file_id: 2,
                    from_path: locked.to_string_lossy().to_string(),
                    to_path: root.join("dest").join("locked.exe").to_string_lossy().to_string(),
                    size: 20,
                    discovery_id: None,
                },
            ],
        )
        .unwrap();

        let mover = FakeMover {
            fail: vec![locked.to_string_lossy().to_string()],
            calls: RefCell::new(vec![]),
        };
        let result = execute_plan_with(&mut conn, plan_id, &mover).unwrap();

        assert_eq!(result.moved, 1);
        assert_eq!(result.bytes_moved, 10);
        assert_eq!(result.failed.len(), 1);
        assert_eq!(result.failed[0].path, locked.to_string_lossy());
        assert!(result.failed[0].reason.contains("locked"));

        let items = plan_items(&conn, plan_id).unwrap();
        assert_eq!(items[0].status, "moved");
        assert_eq!(items[1].status, "failed");

        // The failed file must NOT be marked deleted — it is still there.
        let deleted: Option<i64> = conn
            .query_row("SELECT deleted_at FROM files WHERE id = 2", [], |r| r.get(0))
            .unwrap();
        assert!(deleted.is_none());
        cleanup(&root);
    }

    #[test]
    fn skips_items_whose_source_row_is_already_deleted() {
        let root = test_root("skips-deleted");
        let gone = root.join("gone.exe");
        let mut conn = migrated_conn();
        seed_file(&conn, 1, &gone);
        conn.execute("UPDATE files SET deleted_at = 1 WHERE id = 1", []).unwrap();
        let plan_id = create_plan(
            &conn,
            &[PlanItem {
                file_id: 1,
                from_path: gone.to_string_lossy().to_string(),
                to_path: root.join("dest").join("gone.exe").to_string_lossy().to_string(),
                size: 10,
                discovery_id: None,
            }],
        )
        .unwrap();

        let mover = FakeMover { fail: vec![], calls: RefCell::new(vec![]) };
        let result = execute_plan_with(&mut conn, plan_id, &mover).unwrap();

        assert_eq!(result.moved, 0);
        assert!(mover.calls.borrow().is_empty(), "a deleted source is never touched on disk");
        assert_eq!(plan_items(&conn, plan_id).unwrap()[0].status, "skipped");
        cleanup(&root);
    }

    #[test]
    fn skips_an_item_whose_file_vanished_from_disk() {
        let root = test_root("skips-vanished");
        let vanished = root.join("vanished.exe");
        let mut conn = migrated_conn();
        seed_file(&conn, 1, &vanished);
        std::fs::remove_file(&vanished).expect("delete the fixture out from under the plan");
        let plan_id = create_plan(
            &conn,
            &[PlanItem {
                file_id: 1,
                from_path: vanished.to_string_lossy().to_string(),
                to_path: root.join("dest").join("vanished.exe").to_string_lossy().to_string(),
                size: 10,
                discovery_id: None,
            }],
        )
        .unwrap();

        let mover = FakeMover { fail: vec![], calls: RefCell::new(vec![]) };
        let result = execute_plan_with(&mut conn, plan_id, &mover).unwrap();

        assert_eq!(result.moved, 0);
        assert!(mover.calls.borrow().is_empty());
        assert_eq!(plan_items(&conn, plan_id).unwrap()[0].status, "skipped");
        cleanup(&root);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --lib catalog::plans catalog::executor`
Expected: FAIL to compile — `cannot find function create_plan`, `cannot find trait Mover`.

- [ ] **Step 3: Write minimal implementation**

Prepend to `src/ontology/catalog/plans.rs`:

```rust
//! Relocation plans: an explicit per-file (from, to) list.
//!
//! Unlike a cleanup plan — which stores a scope predicate and recomputes its
//! candidates — a relocation's destinations are chosen per file and cannot be
//! re-derived, so they are persisted as rows.

use crate::ontology::OntologyError;
use rusqlite::{params, Connection};
use serde::Serialize;

pub struct PlanItem {
    pub file_id: i64,
    pub from_path: String,
    pub to_path: String,
    pub size: i64,
    pub discovery_id: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PlannedItem {
    pub id: i64,
    pub file_id: i64,
    pub from_path: String,
    pub to_path: String,
    pub size: i64,
    pub status: String,
    pub note: Option<String>,
}

pub fn create_plan(conn: &Connection, items: &[PlanItem]) -> Result<i64, OntologyError> {
    conn.execute(
        "INSERT INTO ontology_relocation_plans (created_at, status)
         VALUES (strftime('%s','now'), 'draft')",
        [],
    )?;
    let plan_id = conn.last_insert_rowid();

    for item in items {
        conn.execute(
            "INSERT INTO ontology_relocation_plan_items
                (plan_id, discovery_id, file_id, from_path, to_path, size, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'planned')",
            params![
                plan_id,
                item.discovery_id,
                item.file_id,
                item.from_path,
                item.to_path,
                item.size
            ],
        )?;
    }
    Ok(plan_id)
}

pub fn plan_items(conn: &Connection, plan_id: i64) -> Result<Vec<PlannedItem>, OntologyError> {
    let mut stmt = conn.prepare(
        "SELECT id, file_id, from_path, to_path, size, status, note
         FROM ontology_relocation_plan_items
         WHERE plan_id = ?1
         ORDER BY id ASC",
    )?;
    let rows = stmt.query_map([plan_id], |row| {
        Ok(PlannedItem {
            id: row.get(0)?,
            file_id: row.get(1)?,
            from_path: row.get(2)?,
            to_path: row.get(3)?,
            size: row.get(4)?,
            status: row.get(5)?,
            note: row.get(6)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(OntologyError::from)
}

pub fn set_plan_status(conn: &Connection, plan_id: i64, status: &str) -> Result<(), OntologyError> {
    conn.execute(
        "UPDATE ontology_relocation_plans
         SET status = ?2,
             executed_at = CASE WHEN ?2 = 'executed' THEN strftime('%s','now') ELSE executed_at END
         WHERE id = ?1",
        params![plan_id, status],
    )?;
    Ok(())
}

pub fn set_item_status(
    conn: &Connection,
    item_id: i64,
    status: &str,
    note: Option<&str>,
) -> Result<(), OntologyError> {
    conn.execute(
        "UPDATE ontology_relocation_plan_items SET status = ?2, note = ?3 WHERE id = ?1",
        params![item_id, status, note],
    )?;
    Ok(())
}
```

Prepend to `src/ontology/catalog/executor.rs`:

```rust
//! Relocation execution, behind an injectable mover so failure paths are testable.

use crate::ontology::catalog::plans::{plan_items, set_item_status, set_plan_status};
use crate::ontology::OntologyError;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

/// The seam. `move_files` has no injection point of its own, so execution goes
/// through this trait and the real implementation delegates to the same logic.
pub trait Mover {
    fn move_one(&self, from: &str, to: &str) -> Result<(), String>;
}

pub struct SystemMover;

impl Mover for SystemMover {
    fn move_one(&self, from: &str, to: &str) -> Result<(), String> {
        let response = crate::native::api::move_files(crate::native::api::MoveFilesRequest {
            moves: vec![crate::native::api::MoveSpec {
                from: from.to_string(),
                to: to.to_string(),
            }],
            index_path: None,
        });
        match response.failed.first() {
            Some(failure) => Err(failure.reason.clone()),
            None => Ok(()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MovedPair {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RelocationFailure {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RelocationResult {
    pub plan_id: i64,
    pub moved: u64,
    pub bytes_moved: u64,
    /// Reversible (from, to) pairs — the frontend undoes by swapping them.
    pub pairs: Vec<MovedPair>,
    pub failed: Vec<RelocationFailure>,
}

pub fn execute_plan_with(
    conn: &mut Connection,
    plan_id: i64,
    mover: &dyn Mover,
) -> Result<RelocationResult, OntologyError> {
    let items = plan_items(conn, plan_id)?;
    let mut moved = 0_u64;
    let mut bytes_moved = 0_u64;
    let mut pairs = Vec::new();
    let mut failed = Vec::new();

    for item in items {
        if item.status != "planned" {
            continue;
        }

        // Re-verify at EXECUTE time, not only at plan time: an earlier move in
        // this same session marks sources deleted without inserting destinations.
        // `Option<Option<i64>>` — outer None means no row, inner Some means the
        // row is already soft-deleted. Both disqualify the item.
        let row: Option<Option<i64>> = conn
            .query_row(
                "SELECT deleted_at FROM files WHERE id = ?1",
                params![item.file_id],
                |row| row.get(0),
            )
            .optional()?;

        if !matches!(row, Some(None)) {
            set_item_status(conn, item.id, "skipped", Some("source no longer in the index"))?;
            continue;
        }
        if !std::path::Path::new(&item.from_path).exists() {
            set_item_status(conn, item.id, "skipped", Some("source no longer on disk"))?;
            continue;
        }

        match mover.move_one(&item.from_path, &item.to_path) {
            Ok(()) => {
                set_item_status(conn, item.id, "moved", None)?;
                let _ = conn.execute(
                    "UPDATE files SET deleted_at = strftime('%s','now') WHERE id = ?1",
                    params![item.file_id],
                );
                moved += 1;
                bytes_moved += item.size.max(0) as u64;
                pairs.push(MovedPair {
                    from: item.from_path,
                    to: item.to_path,
                });
            }
            Err(reason) => {
                set_item_status(conn, item.id, "failed", Some(&reason))?;
                failed.push(RelocationFailure {
                    path: item.from_path,
                    reason,
                });
            }
        }
    }

    set_plan_status(conn, plan_id, "executed")?;
    Ok(RelocationResult {
        plan_id,
        moved,
        bytes_moved,
        pairs,
        failed,
    })
}
```

Add to `src/ontology/catalog/mod.rs`:

```rust
pub mod executor;
pub mod plans;
```

> `execute_plan_with` stats the disk, so the executor tests seed **real** files under a `test_root` temp dir. The `FakeMover` never touches the filesystem — it only records calls — so a "moved" file still exists on disk after the test; that is fine, the assertions are about the returned pairs and the persisted statuses, and `cleanup(&root)` removes everything.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --lib catalog::plans catalog::executor`
Expected: PASS — 2 plans tests, 3 executor tests.

- [ ] **Step 5: Commit**

```bash
git add src/ontology/catalog && git commit -m "feat(catalog): persist relocation plans and execute them behind a mover seam"
```

---

### Task 10: Native commands

**Files:**
- Modify: `src/native/api.rs` (new DTOs + 5 commands)
- Test: inline in `src/native/api.rs`

**Interfaces:**
- Consumes: Task 9's `plans`/`executor`, Task 6's `rules`, Task 4's payload types.
- Produces (all `pub fn` in `src/native/api.rs`):
  - `relocation_plan(RelocationPlanRequest) -> Result<RelocationPlanResponse, String>`
  - `execute_relocation_plan(ExecuteRelocationPlanRequest) -> Result<RelocationResult, String>`
  - `relocation_members(RelocationMembersRequest) -> Result<Vec<RelocationMember>, String>`
  - `catalog_rules(CatalogRulesRequest) -> Result<Vec<CatalogRule>, String>`
  - `save_catalog_rule(SaveCatalogRuleRequest) -> Result<i64, String>`
  - `delete_catalog_rule(DeleteCatalogRuleRequest) -> Result<(), String>`

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` in `src/native/api.rs`:

```rust
    #[test]
    fn relocation_plan_then_execute_round_trips() {
        use crate::index::schema::ALL_MIGRATIONS;
        use rusqlite::Connection;

        let root = test_root("relocation-api");
        let inbox = root.join("inbox");
        let dest = root.join("dest");
        fs::create_dir_all(&inbox).expect("create inbox");
        fs::create_dir_all(&dest).expect("create dest");

        let from = inbox.join("a.exe");
        write_file(&from, b"payload!!");
        let to = dest.join("a.exe");
        let index_path = root.join("index.sqlite");

        {
            let conn = Connection::open(&index_path).unwrap();
            for (_, sql) in ALL_MIGRATIONS {
                conn.execute_batch(sql).unwrap();
            }
            conn.execute(
                "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
                 VALUES (1, NULL, ?1, 'inbox', 0, 0)",
                rusqlite::params![inbox.to_string_lossy()],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO files (id, folder_id, path, name, size, media_kind, indexed_at)
                 VALUES (1, 1, ?1, 'a.exe', 9, 'installer', 0)",
                rusqlite::params![from.to_string_lossy()],
            )
            .unwrap();
        }

        let plan = relocation_plan(RelocationPlanRequest {
            index_path: index_path.clone(),
            moves: vec![RelocationMoveInput {
                file_id: 1,
                from: from.to_string_lossy().to_string(),
                to: to.to_string_lossy().to_string(),
                discovery_id: None,
            }],
        })
        .expect("relocation_plan");

        assert_eq!(plan.total_files, 1);
        assert_eq!(plan.items.len(), 1);
        assert_eq!(plan.items[0].to_path, to.to_string_lossy());

        let result = execute_relocation_plan(ExecuteRelocationPlanRequest {
            index_path: index_path.clone(),
            plan_id: plan.plan_id,
        })
        .expect("execute_relocation_plan");

        assert_eq!(result.moved, 1);
        assert_eq!(result.pairs.len(), 1);
        assert!(to.exists(), "the file landed at the destination");
        assert!(!from.exists(), "the source is gone");

        cleanup(&root);
    }

    #[test]
    fn relocation_plan_drops_a_vanished_source() {
        use crate::index::schema::ALL_MIGRATIONS;
        use rusqlite::Connection;

        let root = test_root("relocation-vanished");
        fs::create_dir_all(&root).expect("create root");
        let index_path = root.join("index.sqlite");
        let ghost = root.join("ghost.exe");

        {
            let conn = Connection::open(&index_path).unwrap();
            for (_, sql) in ALL_MIGRATIONS {
                conn.execute_batch(sql).unwrap();
            }
            conn.execute(
                "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
                 VALUES (1, NULL, ?1, 'root', 0, 0)",
                rusqlite::params![root.to_string_lossy()],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO files (id, folder_id, path, name, size, media_kind, indexed_at)
                 VALUES (1, 1, ?1, 'ghost.exe', 9, 'installer', 0)",
                rusqlite::params![ghost.to_string_lossy()],
            )
            .unwrap();
        }

        let plan = relocation_plan(RelocationPlanRequest {
            index_path,
            moves: vec![RelocationMoveInput {
                file_id: 1,
                from: ghost.to_string_lossy().to_string(),
                to: root.join("moved.exe").to_string_lossy().to_string(),
                discovery_id: None,
            }],
        })
        .expect("relocation_plan");

        assert_eq!(plan.total_files, 0, "a file that is not on disk is dropped at plan time");
        assert_eq!(plan.dropped.len(), 1);
        assert!(plan.dropped[0].reason.contains("no longer"));

        cleanup(&root);
    }

    #[test]
    fn catalog_rules_crud_round_trips() {
        use crate::index::schema::ALL_MIGRATIONS;
        use rusqlite::Connection;

        let root = test_root("catalog-rules-api");
        fs::create_dir_all(&root).expect("create root");
        let index_path = root.join("index.sqlite");
        {
            let conn = Connection::open(&index_path).unwrap();
            for (_, sql) in ALL_MIGRATIONS {
                conn.execute_batch(sql).unwrap();
            }
        }

        let id = save_catalog_rule(SaveCatalogRuleRequest {
            index_path: index_path.clone(),
            name: "Invoices".to_string(),
            kind: Some("invoice".to_string()),
            name_contains: None,
            zone: None,
            destination: "D:\\Finance".to_string(),
            source: "saved-after-move".to_string(),
        })
        .expect("save_catalog_rule");

        let listed = catalog_rules(CatalogRulesRequest { index_path: index_path.clone() })
            .expect("catalog_rules");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].destination, "D:\\Finance");

        delete_catalog_rule(DeleteCatalogRuleRequest { index_path: index_path.clone(), id })
            .expect("delete_catalog_rule");
        assert!(catalog_rules(CatalogRulesRequest { index_path }).unwrap().is_empty());

        cleanup(&root);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --lib relocation_`
Expected: FAIL to compile — `cannot find function relocation_plan`.

- [ ] **Step 3: Write minimal implementation**

Add the DTOs to `src/native/api.rs` alongside the other request/response types:

```rust
#[derive(Debug, Clone, Deserialize)]
pub struct RelocationMoveInput {
    pub file_id: i64,
    pub from: String,
    pub to: String,
    #[serde(default)]
    pub discovery_id: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RelocationPlanRequest {
    pub index_path: PathBuf,
    pub moves: Vec<RelocationMoveInput>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DroppedMove {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RelocationPlanResponse {
    pub plan_id: i64,
    pub total_files: u64,
    pub total_bytes: u64,
    pub items: Vec<crate::ontology::catalog::plans::PlannedItem>,
    /// Files re-verification removed, with the reason to show inline.
    pub dropped: Vec<DroppedMove>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ExecuteRelocationPlanRequest {
    pub index_path: PathBuf,
    pub plan_id: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RelocationMembersRequest {
    pub index_path: PathBuf,
    pub discovery_id: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CatalogRulesRequest {
    pub index_path: PathBuf,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SaveCatalogRuleRequest {
    pub index_path: PathBuf,
    pub name: String,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub name_contains: Option<String>,
    #[serde(default)]
    pub zone: Option<String>,
    pub destination: String,
    pub source: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DeleteCatalogRuleRequest {
    pub index_path: PathBuf,
    pub id: i64,
}
```

Add the commands:

```rust
/// Re-verify a set of proposed moves and persist them as a draft plan.
pub fn relocation_plan(request: RelocationPlanRequest) -> Result<RelocationPlanResponse, String> {
    use crate::ontology::catalog::plans::{create_plan, plan_items, PlanItem};

    let conn =
        crate::index::open_index_connection(&request.index_path).map_err(|e| e.to_string())?;

    let mut items = Vec::new();
    let mut dropped = Vec::new();
    let mut claimed: std::collections::HashSet<String> = std::collections::HashSet::new();

    for input in request.moves {
        let row: Option<(i64, Option<i64>)> = conn
            .query_row(
                "SELECT size, deleted_at FROM files WHERE id = ?1",
                rusqlite::params![input.file_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok();

        let Some((size, deleted_at)) = row else {
            dropped.push(DroppedMove {
                path: input.from,
                reason: "no longer in the index".to_owned(),
            });
            continue;
        };
        if deleted_at.is_some() {
            dropped.push(DroppedMove {
                path: input.from,
                reason: "no longer in the index".to_owned(),
            });
            continue;
        }
        if !Path::new(&input.from).exists() {
            dropped.push(DroppedMove {
                path: input.from,
                reason: "no longer on disk".to_owned(),
            });
            continue;
        }
        if Path::new(&input.to).exists() || !claimed.insert(input.to.clone()) {
            dropped.push(DroppedMove {
                path: input.from,
                reason: "a file already claims that name at the destination".to_owned(),
            });
            continue;
        }

        items.push(PlanItem {
            file_id: input.file_id,
            from_path: input.from,
            to_path: input.to,
            size,
            discovery_id: input.discovery_id,
        });
    }

    let plan_id = create_plan(&conn, &items).map_err(|e| e.to_string())?;
    let persisted = plan_items(&conn, plan_id).map_err(|e| e.to_string())?;
    let total_files = persisted.len() as u64;
    let total_bytes = persisted.iter().map(|i| i.size.max(0) as u64).sum();

    Ok(RelocationPlanResponse {
        plan_id,
        total_files,
        total_bytes,
        items: persisted,
        dropped,
    })
}

/// Execute a draft relocation plan and mark its source discoveries confirmed.
pub fn execute_relocation_plan(
    request: ExecuteRelocationPlanRequest,
) -> Result<crate::ontology::catalog::executor::RelocationResult, String> {
    use crate::ontology::catalog::executor::{execute_plan_with, SystemMover};

    let mut conn =
        crate::index::open_index_connection(&request.index_path).map_err(|e| e.to_string())?;

    let discovery_ids: Vec<i64> = {
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT discovery_id
                 FROM ontology_relocation_plan_items
                 WHERE plan_id = ?1 AND discovery_id IS NOT NULL",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![request.plan_id], |row| row.get::<_, i64>(0))
            .map_err(|e| e.to_string())?;
        rows.filter_map(Result::ok).collect()
    };

    let result = execute_plan_with(&mut conn, request.plan_id, &SystemMover)
        .map_err(|e| e.to_string())?;

    for id in discovery_ids {
        let _ = crate::ontology::discoveries_resolve::confirm_discovery(&conn, id);
    }

    Ok(result)
}

/// The full member list for one card. The payload embeds only the first 50.
pub fn relocation_members(
    request: RelocationMembersRequest,
) -> Result<Vec<crate::ontology::catalog::payload::RelocationMember>, String> {
    use crate::ontology::catalog::cluster::{candidates, refine_kind};
    use crate::ontology::catalog::payload::{RelocationMember, RelocationPayload};
    use crate::ontology::catalog::zones::inbox_zones;
    use crate::ontology::discoveries::get_discovery;

    let conn =
        crate::index::open_index_connection(&request.index_path).map_err(|e| e.to_string())?;
    let discovery = get_discovery(&conn, request.discovery_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("discovery {} not found", request.discovery_id))?;
    let payload: RelocationPayload =
        serde_json::from_str(&discovery.payload).map_err(|e| e.to_string())?;

    let zones = inbox_zones(&conn).map_err(|e| e.to_string())?;
    let all = candidates(&conn, &zones).map_err(|e| e.to_string())?;

    Ok(all
        .into_iter()
        .filter(|c| c.zone == payload.zone && refine_kind(&c.media_kind, &c.name) == payload.kind)
        .map(|c| RelocationMember {
            file_id: c.file_id,
            path: c.path,
            name: c.name,
            size: c.size,
        })
        .collect())
}

/// List the user's saved catalog rules.
pub fn catalog_rules(
    request: CatalogRulesRequest,
) -> Result<Vec<crate::ontology::catalog::rules::CatalogRule>, String> {
    let conn =
        crate::index::open_index_connection(&request.index_path).map_err(|e| e.to_string())?;
    crate::ontology::catalog::rules::list_rules(&conn).map_err(|e| e.to_string())
}

/// Save a rule taught by a completed move or an edited suggestion.
pub fn save_catalog_rule(request: SaveCatalogRuleRequest) -> Result<i64, String> {
    use crate::ontology::catalog::rules::{create_rule, NewCatalogRule, RuleCriteria};

    let conn =
        crate::index::open_index_connection(&request.index_path).map_err(|e| e.to_string())?;
    let criteria = RuleCriteria {
        kind: request.kind,
        name_contains: request.name_contains,
        zone: request.zone,
    };
    create_rule(
        &conn,
        &NewCatalogRule {
            name: &request.name,
            criteria: &criteria,
            destination: &request.destination,
            source: &request.source,
        },
    )
    .map_err(|e| e.to_string())
}

/// Forget a saved rule.
pub fn delete_catalog_rule(request: DeleteCatalogRuleRequest) -> Result<(), String> {
    let conn =
        crate::index::open_index_connection(&request.index_path).map_err(|e| e.to_string())?;
    crate::ontology::catalog::rules::delete_rule(&conn, request.id).map_err(|e| e.to_string())
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --lib relocation_ catalog_rules_crud_round_trips`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/native/api.rs && git commit -m "feat(catalog): add relocation plan, execute, members, and rules commands"
```

---

### Task 11: Desktop shell wiring

**Files:**
- Modify: `src-tauri/src/main.rs:4-42` (imports), `src-tauri/src/main.rs:262-270` area (wrappers), `src-tauri/src/main.rs:365-413` (handler list)
- Test: none (the desktop crate has no tests — it is compile-checked only)

**Interfaces:**
- Consumes: Task 10's commands.
- Produces: IPC command names `relocation_plan`, `execute_relocation_plan`, `relocation_members`, `catalog_rules`, `save_catalog_rule`, `delete_catalog_rule`.

- [ ] **Step 1: Add the import aliases**

Append inside the existing `use birds_eye::native::api::{ ... };` block:

```rust
    // Cataloging
    relocation_plan as do_relocation_plan,
    execute_relocation_plan as do_execute_relocation_plan,
    relocation_members as do_relocation_members,
    catalog_rules as do_catalog_rules,
    save_catalog_rule as do_save_catalog_rule,
    delete_catalog_rule as do_delete_catalog_rule,
    CatalogRulesRequest, DeleteCatalogRuleRequest, ExecuteRelocationPlanRequest,
    RelocationMembersRequest, RelocationPlanRequest, RelocationPlanResponse,
    SaveCatalogRuleRequest,
```

- [ ] **Step 2: Add the wrapper fns**

Add next to the existing `cleanup_plan` / `execute_cleanup_plan` wrappers:

```rust
#[tauri::command(async)]
fn relocation_plan(request: RelocationPlanRequest) -> Result<RelocationPlanResponse, String> {
    do_relocation_plan(request)
}

#[tauri::command(async)]
fn execute_relocation_plan(
    request: ExecuteRelocationPlanRequest,
) -> Result<birds_eye::ontology::catalog::executor::RelocationResult, String> {
    do_execute_relocation_plan(request)
}

#[tauri::command(async)]
fn relocation_members(
    request: RelocationMembersRequest,
) -> Result<Vec<birds_eye::ontology::catalog::payload::RelocationMember>, String> {
    do_relocation_members(request)
}

#[tauri::command(async)]
fn catalog_rules(
    request: CatalogRulesRequest,
) -> Result<Vec<birds_eye::ontology::catalog::rules::CatalogRule>, String> {
    do_catalog_rules(request)
}

#[tauri::command(async)]
fn save_catalog_rule(request: SaveCatalogRuleRequest) -> Result<i64, String> {
    do_save_catalog_rule(request)
}

#[tauri::command(async)]
fn delete_catalog_rule(request: DeleteCatalogRuleRequest) -> Result<(), String> {
    do_delete_catalog_rule(request)
}
```

- [ ] **Step 3: Register in the handler list**

Add to `tauri::generate_handler![...]` immediately after `execute_cleanup_plan,` (keep the trailing comma on the final entry):

```rust
            relocation_plan,
            execute_relocation_plan,
            relocation_members,
            catalog_rules,
            save_catalog_rule,
            delete_catalog_rule,
```

- [ ] **Step 4: Verify the desktop crate compiles**

Run: `cargo check --manifest-path src-tauri\Cargo.toml`
Expected: `Finished` with no errors.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/main.rs && git commit -m "feat(catalog): expose cataloging commands to the desktop shell"
```

---

### Task 12: End-to-end integration test

**Files:**
- Create: `tests/catalog_relocation.rs`
- Test: this file

**Interfaces:**
- Consumes: the whole public surface (`birds_eye::native::api::*`, `birds_eye::ontology::*`).
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

Create `tests/catalog_relocation.rs`:

```rust
//! Cataloging integration: suggestion → plan → execute → undo, on real files.

use birds_eye::index::schema::ALL_MIGRATIONS;
use birds_eye::native::api::{
    execute_relocation_plan, move_files, relocation_plan, ExecuteRelocationPlanRequest,
    MoveFilesRequest, MoveSpec, RelocationMoveInput, RelocationPlanRequest,
};
use rusqlite::Connection;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

fn unique_dir(name: &str) -> PathBuf {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join("catalog-integration-tests")
        .join(format!("{name}-{nanos}"));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn migrate(index_path: &Path) -> Connection {
    let conn = Connection::open(index_path).unwrap();
    for (_, sql) in ALL_MIGRATIONS {
        conn.execute_batch(sql).unwrap();
    }
    conn
}

#[test]
fn relocation_round_trips_and_undoes() {
    let dir = unique_dir("round-trip");
    let inbox = dir.join("inbox");
    let home = dir.join("home");
    fs::create_dir_all(&inbox).unwrap();
    fs::create_dir_all(&home).unwrap();

    let from = inbox.join("setup.exe");
    fs::write(&from, [1u8; 64]).unwrap();
    let to = home.join("setup.exe");
    let index_path = dir.join("index.sqlite");

    {
        let conn = migrate(&index_path);
        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
             VALUES (1, NULL, ?1, 'inbox', 0, 0)",
            rusqlite::params![inbox.to_string_lossy()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, size, media_kind, indexed_at)
             VALUES (1, 1, ?1, 'setup.exe', 64, 'installer', 0)",
            rusqlite::params![from.to_string_lossy()],
        )
        .unwrap();
    }

    let plan = relocation_plan(RelocationPlanRequest {
        index_path: index_path.clone(),
        moves: vec![RelocationMoveInput {
            file_id: 1,
            from: from.to_string_lossy().to_string(),
            to: to.to_string_lossy().to_string(),
            discovery_id: None,
        }],
    })
    .expect("relocation_plan");
    assert_eq!(plan.total_files, 1);

    let result = execute_relocation_plan(ExecuteRelocationPlanRequest {
        index_path: index_path.clone(),
        plan_id: plan.plan_id,
    })
    .expect("execute_relocation_plan");

    assert_eq!(result.moved, 1);
    assert!(to.exists(), "file moved to its destination");
    assert!(!from.exists(), "source is gone");

    // Undo is the reversed pairs through move_files — no dedicated command.
    let undo = move_files(MoveFilesRequest {
        moves: result
            .pairs
            .iter()
            .map(|p| MoveSpec {
                from: p.to.clone(),
                to: p.from.clone(),
            })
            .collect(),
        index_path: Some(index_path),
    });

    assert_eq!(undo.moved, 1);
    assert!(from.exists(), "undo restored the source");
    assert!(!to.exists(), "undo emptied the destination");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_destination_collision_is_dropped_at_plan_time() {
    let dir = unique_dir("collision");
    let inbox = dir.join("inbox");
    let home = dir.join("home");
    fs::create_dir_all(&inbox).unwrap();
    fs::create_dir_all(&home).unwrap();

    let from = inbox.join("a.exe");
    fs::write(&from, [1u8; 8]).unwrap();
    let to = home.join("a.exe");
    fs::write(&to, [2u8; 8]).unwrap(); // already taken

    let index_path = dir.join("index.sqlite");
    {
        let conn = migrate(&index_path);
        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
             VALUES (1, NULL, ?1, 'inbox', 0, 0)",
            rusqlite::params![inbox.to_string_lossy()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, size, media_kind, indexed_at)
             VALUES (1, 1, ?1, 'a.exe', 8, 'installer', 0)",
            rusqlite::params![from.to_string_lossy()],
        )
        .unwrap();
    }

    let plan = relocation_plan(RelocationPlanRequest {
        index_path,
        moves: vec![RelocationMoveInput {
            file_id: 1,
            from: from.to_string_lossy().to_string(),
            to: to.to_string_lossy().to_string(),
            discovery_id: None,
        }],
    })
    .expect("relocation_plan");

    assert_eq!(plan.total_files, 0);
    assert_eq!(plan.dropped.len(), 1);
    assert_eq!(fs::read(&to).unwrap(), vec![2u8; 8], "the existing file is untouched");

    let _ = fs::remove_dir_all(&dir);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --test catalog_relocation`
Expected: FAIL to compile if any interface drifted from Tasks 9–10; otherwise PASS.

- [ ] **Step 3: Fix any interface drift**

If compilation fails, reconcile the names against Tasks 9 and 10 — do not change the test's intent.

- [ ] **Step 4: Run the full gate**

Run: `cargo test`
Expected: PASS — the whole suite.

Run: `cargo check --manifest-path src-tauri\Cargo.toml`
Expected: `Finished`.

- [ ] **Step 5: Commit**

```bash
git add tests/catalog_relocation.rs && git commit -m "test(catalog): cover relocation round trip, undo, and collisions"
```

---

## Self-Review

**Spec coverage.** Migration/tables → Task 1. Zone resolution → Task 2. Non-graduating confirm/reject, `count_pending_by_kind`, `list_by_kind_and_status` → Task 3. Payload with fingerprint/member_hash/cap and `potential_bytes_unlocked` semantics → Tasks 4, 7. Candidate scoping + role exclusion + `media_kind` clustering → Task 5. Rule > learned > template inference with thresholds, denominator, and the `idx_files_kind_folder` index → Tasks 1, 6. Populator + registration ordering → Task 7. Orphan-copy fix → Task 8. Plan/execute with re-verification at execute time and the `Mover` seam → Task 9. Commands including lazy members and rules CRUD → Task 10. Shell wiring → Task 11. End-to-end + undo-by-reversed-pairs → Task 12.

**Deliberately deferred to Plan 2** (UI): `stagedMoves`, `RelocateReviewModal`, `CatalogView`, `CleanupTray` dual-kind, Files multi-select, nav wiring, mock backend. Also unimplemented by design: scan-concurrency gating, which Plan 2 handles at the call site by checking `scanView.status` before invoking `execute_relocation_plan`.

**Known interface notes for the implementer.** `relocation_members` recomputes the cluster rather than reading stored ids — acceptable because the populator is cheap and the payload is capped, but it will return the *current* membership, which can differ from when the card was emitted. If that drift matters, store the full id list in a side table instead. `list_rules` is called once per cluster in `infer`; with more than a few dozen rules, hoist it out of the loop.
