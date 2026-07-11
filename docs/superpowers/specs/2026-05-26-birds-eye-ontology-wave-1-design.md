# Birds Eye Ontology Layer — Wave 1 Design Spec

*Implementation-ready spec for the Wave 1 ontology layer in Birds Eye. Ships the space-recovery thesis: safer dedup + smarter reorg. Cognition-side features (Work, Theme, depicts, manifestation, language) are scoped to Wave 2 and captured in the companion vision document.*

*Date: 2026-05-26. Companion documents: `2026-05-26-birds-eye-ontology-chapters-1-6.md` (full design rationale), `2026-05-26-birds-eye-ontology-wave-2-vision.md` (cognition follow-on).*

---

## Context

Birds Eye today is a Tauri desktop application with a Rust parallel scanner, SQLite-backed index, React dashboard with canvas treemap, and hash-based exact-duplicate detection. It answers structural questions about disk usage: what's big, where, and which files share a hash. It does not answer semantic questions about *safety to delete*, *role in production*, *project membership*, or *replaceability*.

The original Birds Eye mission is to *reorganize scattered storage and reclaim disk space through safer-than-byte-only deduplication*, prompted by real-world memory shortage and storage price spikes. Byte-only dedup unlocks maybe 10% of the reclaimable mass on a typical scattered drive; the other 90% — regenerable derivatives, redundant backups, finished-project cruft, near-duplicates — sits untouched because the user has no way to delete it safely.

Wave 1 of the ontology layer addresses this gap by introducing typed entities, typed relations, and properties on files that gate cleanup decisions through a transparent predicate. The user gains a brave-enough cleanup engine: it can recommend deletion of 38 GB of derivative exports because their sources are still on disk, identify 12 GB of byte-identical backups whose live counterparts exist, and protect 8 GB of backup files whose origins are gone (the only-copy case the naive instinct would have destroyed).

This spec covers only Wave 1. The cognition-side features that would make Birds Eye a "Storage Cognition Engine" (grouping multi-language manifestations of the same Work, surfacing cross-folder thematic links, color-by-Work treemap) are layered on later in Wave 2 without requiring vocabulary changes or architectural rework. See the companion vision document.

### How each Wave 1 capability serves the original mission

| Wave 1 capability | Original-mission alignment |
|---|---|
| `role` property + `derivedFrom` relation | Distinguishes irreplaceable sources from regenerable derivatives — unlocks safe bulk deletion of derivatives. |
| `replaceability` property | The safety net that prevents irreversible loss of dead-link software, vacation photos, out-of-print scans. |
| `sensitivity` property | Hard-excludes Personal Details/Work Details from cleanup. |
| `lifecycle` on Project | Finished/abandoned projects become top deletion candidates. |
| `backupOf` relation | Surfaces redundant backup copies and *protects* backups whose originals are gone. |
| Dedup-as-graph-merge | Preserves semantic context (theme/project memberships) on duplicate consolidation. |
| Reclaimable-Mass treemap lens | Visual decision support — see *where* to clean as a shape, not a list. |
| Discoveries panel | Brings the user into the loop to confirm low-confidence inferences before they enable cleanup actions. |

---

## Goals

1. Ship a vocabulary, storage model, and populator framework sufficient to populate File / Folder / Project entities with `role`, `replaceability`, `sensitivity`, `lifecycle`, `origin`, and `mediaType` properties, and `derivedFrom` / `backupOf` / `partOf` / `inFolder` relations.
2. Ship a transparent cleanup engine that evaluates a single visible predicate over those facts to produce a plan grouped by reason, with recycle-bin-first execution and a persistent restore log.
3. Ship a Discoveries panel that surfaces low-confidence inferences for user confirmation, with pattern-level and item-level bulk actions, ranked by ROI.
4. Ship four new treemap re-coloring lenses (Role, Replaceability, Lifecycle, Reclaimable-Mass) layered on the existing treemap.
5. Ship a starter library of saved views and a starter rule bundle that fires usefully on first run.
6. Preserve all 8 constitutional defenses from the design dialogue as architectural invariants and automated tests.
7. Keep the ontology layer **opt-in per index**; disabling it leaves Birds Eye's existing behavior fully intact.

## Non-Goals

This spec deliberately excludes:

- The cognition-side classes (`Work`, `Theme`) being populated. They are defined in the schema but no Wave 1 populator writes to them.
- The cognition-side relations (`manifestationOf`, `depicts`). Defined, dormant.
- The `language` property. Defined, dormant.
- ML classifiers (`role` classifier, `lifecycle` classifier). Wave 2 territory.
- CLIP-grade image embeddings. Wave 2 territory.
- External knowledge lookups (Wikidata, MAL, IMDB). Wave 2 territory; offline-first preserved.
- Encrypted index storage. Future (v3+) territory.
- Multi-machine federation, AI-assisted content summarization, face recognition, Event modelling.
- Modifications to the existing scan engine's Phase 1 path. All Wave 1 work is additive (Phase 2 enrichment + new commands + new UI).

---

## Architectural Principles (the Constitution)

The eight non-negotiable invariants. Every implementation choice in this spec derives from one or more of these. They are restated as automated tests in §13.

1. **Recycle bin always; persistent restore log; pin-to-keep.** Cleanup never hard-deletes. The "Recently Cleaned" log persists with one-click restore for a configurable retention window (default 90 days), surviving recycle-bin emptying. Any file marked "pin-to-keep" is permanently excluded from cleanup queues regardless of role/replaceability.

2. **Two-phase scan; enrichment opt-in and pauseable.** Phase 1 (the existing structural scanner) remains unchanged and is the fast happy path. Phase 2 (ontology enrichment) runs as a separate background, pauseable job. The app is fully usable after Phase 1; ontology features show "enrichment in progress, X% done" until Phase 2 completes.

3. **`sensitivity` is a UI containment boundary, not just a property.** Files with `sensitivity ∈ {private, restricted}` never appear in cross-cutting UI (global search results, recent-discoveries, suggestions, treemap labels) unless the user explicitly opens their parent context. Stored metadata is flagged `display_in_global_views=false`.

4. **Vocabulary changes are deliberate, batched, prompt-on-migrate.** Every fact carries a `vocabulary_version` column. Migrations write new facts at higher version, never overwrite user-confirmed facts silently. Rule-output facts are cheap to rerun; user-confirmed facts get a migration prompt.

5. **The ontology describes; it never prescribes file moves.** No code path in Wave 1 moves, renames, or restructures files based on ontology inferences. Folder structure remains authoritative for user organization. Cleanup only ever recycle-bins.

6. **Discoveries supports pattern-level + item-level confirmation, ranked by ROI.** The Discoveries panel must offer "confirm all 47 PSDs that match this derivedFrom pattern" alongside individual review. Items are ranked by `potential_bytes_unlocked × confidence`, capped at a daily diet of ~10–30 categories.

7. **Every cleanup action shows its gating facts. No black boxes.** Any cleanup candidate displays the full provenance chain on click: which facts gated entry, which source asserted each fact, what confidence, what's excluded by no hard rule. No inference is opaque.

8. **First-run rule bundle ships with the app.** A "Personal Storage Patterns" rule bundle fires usefully on day one, recognizing common landmarks (Downloads/, Personal Details/, OneDrive paths, common scratch folders like `node_modules`, `.cache`, `target`, common sensitive paths). A welcome flow demonstrates the ontology working immediately.

---

## Vocabulary (Wave 1 subset)

Each item below has been defended in Chapter 3 (and 3.5) of the design dialogue. The full rationale lives in `2026-05-26-birds-eye-ontology-chapters-1-6.md`.

### Classes

| Class | Identity | Active in Wave 1? |
|---|---|---|
| **File** | canonical path + content hash | ✅ Active |
| **Folder** | canonical path | ✅ Active |
| **Project** | assigned `project_id` (not path-derived) | ✅ Active |
| **Work** | assigned `work_id`, ideally tied to external ID | ⏸ Defined, dormant (Wave 2) |
| **Theme** | assigned `theme_id` | ⏸ Defined, dormant (Wave 2) |

### Relations

| Relation | Domain → Range | Active in Wave 1? |
|---|---|---|
| **inFolder** | File\|Folder → Folder | ✅ Active |
| **partOf** | File\|Folder → Project | ✅ Active (Project only; Theme dormant) |
| **derivedFrom** | File → File (transitive) | ✅ Active |
| **backupOf** | File\|Folder → File\|Folder | ✅ Active |
| **manifestationOf** | File\|Folder → Work | ⏸ Defined, dormant |
| **depicts** | File → Work | ⏸ Defined, dormant |

### Properties

| Property | Lives on | Vocabulary | Active? |
|---|---|---|---|
| **role** | File | `source`, `derivative`, `reference`, `asset`, `tool`, `backup`, `scratch`, `system` | ✅ |
| **replaceability** | File | `regenerable`, `redownloadable`, `recoverable-with-effort`, `irreplaceable` | ✅ |
| **sensitivity** | File\|Folder | `public`, `normal`, `private`, `restricted` | ✅ |
| **lifecycle** | Project | `planning`, `active`, `finished`, `archived`, `abandoned` | ✅ |
| **origin** | File | `user-created`, `web-download`, `phone-screenshot`, `phone-camera`, `messenger-received`, `app-export`, `archive-extracted`, `unknown` | ✅ |
| **mediaType** | File | Existing `media_kind` vocabulary | ✅ (carried from current schema) |
| **language** | File\|Folder | ISO 639-1 codes | ⏸ Dormant |

### Fact metadata (on every assertion)

- **source** — `user`, `rule:<rule_id>`, `extractor:<extractor_id>`, `heuristic:<heuristic_id>`, `phash`, `system`.
- **confidence** — float in [0.0, 1.0].
- **asserted_at** — Unix timestamp.
- **vocabulary_version** — integer; increment on any vocabulary change.

---

## Storage Model

All Wave 1 storage is additive to the existing SQLite index. No existing tables are modified.

### New tables

```sql
-- Vocabulary version tracking
CREATE TABLE ontology_vocabulary_version (
  current_version INTEGER NOT NULL,
  applied_at INTEGER NOT NULL
);

-- Entities (File, Folder, Project; Work/Theme present for forward compat)
CREATE TABLE ontology_entities (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('File', 'Folder', 'Project', 'Work', 'Theme')),
  canonical_id TEXT NOT NULL,           -- path for File/Folder; uuid for Project/Work/Theme
  linked_file_id INTEGER,               -- FK into existing files(id) when kind='File'
  linked_folder_id INTEGER,             -- FK into existing folders(id) when kind='Folder'
  display_name TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(kind, canonical_id)
);

CREATE INDEX idx_ontology_entities_linked_file ON ontology_entities(linked_file_id);
CREATE INDEX idx_ontology_entities_linked_folder ON ontology_entities(linked_folder_id);
CREATE INDEX idx_ontology_entities_kind_id ON ontology_entities(kind, id);

-- Attributes (EAV table)
CREATE TABLE ontology_attrs (
  id INTEGER PRIMARY KEY,
  entity_id INTEGER NOT NULL REFERENCES ontology_entities(id) ON DELETE CASCADE,
  key TEXT NOT NULL,                    -- 'role', 'replaceability', 'sensitivity', ...
  value TEXT NOT NULL,
  source TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
  asserted_at INTEGER NOT NULL,
  vocabulary_version INTEGER NOT NULL,
  display_in_global_views INTEGER NOT NULL DEFAULT 1  -- bool; 0 for sensitive extracts
);

CREATE INDEX idx_ontology_attrs_entity_key ON ontology_attrs(entity_id, key);
CREATE INDEX idx_ontology_attrs_key_value ON ontology_attrs(key, value);

-- Relations (typed edges with provenance)
CREATE TABLE ontology_relations (
  id INTEGER PRIMARY KEY,
  subject_id INTEGER NOT NULL REFERENCES ontology_entities(id) ON DELETE CASCADE,
  predicate TEXT NOT NULL,              -- 'inFolder', 'partOf', 'derivedFrom', 'backupOf', ...
  object_id INTEGER NOT NULL REFERENCES ontology_entities(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
  asserted_at INTEGER NOT NULL,
  vocabulary_version INTEGER NOT NULL
);

CREATE INDEX idx_ontology_relations_subj_pred ON ontology_relations(subject_id, predicate);
CREATE INDEX idx_ontology_relations_pred_obj ON ontology_relations(predicate, object_id);
CREATE INDEX idx_ontology_relations_pred_conf ON ontology_relations(predicate, confidence DESC);

-- Negative assertions (user rejections block re-suggestion)
CREATE TABLE ontology_negative_assertions (
  id INTEGER PRIMARY KEY,
  subject_id INTEGER NOT NULL REFERENCES ontology_entities(id) ON DELETE CASCADE,
  predicate TEXT NOT NULL,
  object_id INTEGER REFERENCES ontology_entities(id) ON DELETE CASCADE,  -- null for property-rejections
  key TEXT,                              -- for property-rejections: which key
  value TEXT,                            -- for property-rejections: rejected value
  rejected_at INTEGER NOT NULL,
  reason TEXT
);

CREATE INDEX idx_neg_assertions_subj_pred ON ontology_negative_assertions(subject_id, predicate);

-- Discoveries queue
CREATE TABLE ontology_discoveries (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,                   -- 'derivedFrom-pattern', 'backupOf-pair', 'role-suggestion', ...
  payload TEXT NOT NULL,                -- JSON: candidate facts grouped by pattern or single fact
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'rejected', 'expired')),
  confidence REAL NOT NULL,
  potential_bytes_unlocked INTEGER NOT NULL DEFAULT 0,  -- for ROI ranking
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE INDEX idx_discoveries_status_roi ON ontology_discoveries(status, potential_bytes_unlocked DESC, confidence DESC);

-- Pin-to-keep
CREATE TABLE ontology_pinned_files (
  file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  pinned_at INTEGER NOT NULL,
  note TEXT
);

-- Recently Cleaned log
CREATE TABLE ontology_cleanup_log (
  id INTEGER PRIMARY KEY,
  cleanup_plan_id INTEGER NOT NULL,
  file_id INTEGER NOT NULL,             -- not a FK; file may now be in recycle bin
  original_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  cleaned_at INTEGER NOT NULL,
  reason TEXT NOT NULL,                 -- which cleanup-eligibility bucket
  gating_facts TEXT NOT NULL,           -- JSON: snapshot of facts that made it eligible
  restore_status TEXT NOT NULL CHECK (restore_status IN ('in_recycle_bin', 'restored', 'expired')) DEFAULT 'in_recycle_bin',
  expires_at INTEGER                    -- retention window cutoff
);

CREATE INDEX idx_cleanup_log_status ON ontology_cleanup_log(restore_status, expires_at);

-- Cleanup plans (for grouping operations)
CREATE TABLE ontology_cleanup_plans (
  id INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL,
  executed_at INTEGER,
  scope TEXT NOT NULL,                  -- JSON: which reasons, filters, scope
  status TEXT NOT NULL CHECK (status IN ('draft', 'executed', 'cancelled'))
);
```

### Schema design notes

- **No JSON columns for facts.** Each property/relation is a row with strict typed columns; keeps the predicate evaluation in pure SQL.
- **No deletion of facts.** Negative assertions are *new rows in `ontology_negative_assertions`*, not deletions. Audit-trail integrity preserved.
- **Cascade on entity delete** to avoid orphaned facts when files are removed from the underlying scan index.
- **`linked_file_id` / `linked_folder_id`** make joins to the existing `files` and `folders` tables index-fast.
- **`display_in_global_views=0`** is the materialization of Constitutional Defense #3. Every query that surfaces cross-cutting results MUST include `AND display_in_global_views = 1` in its `WHERE`.

### Migration approach

- Wave 1 migration is a single SQLite migration script that creates the new tables. It does not touch existing tables.
- The ontology layer is enabled *per-index*. A row in a new `ontology_enabled` table flags whether enrichment runs for this index. Default for new indexes: enabled. Default for existing indexes after upgrade: prompt the user.
- Disabling the layer drops *nothing*; it just hides the surfaces and stops Phase 2 enrichment. Re-enabling resumes.

---

## Populator Framework

### The `Populator` trait

```rust
pub trait Populator: Send + Sync {
    fn name(&self) -> &'static str;
    fn cost_tier(&self) -> CostTier;     // Cheap | Medium | Expensive
    fn supports_file(&self, file: &FileFact) -> bool;
    fn populate(
        &self,
        context: &PopulatorContext,
        file: &FileFact,
    ) -> Result<Vec<Assertion>, PopulatorError>;
}

pub enum Assertion {
    Property { entity_kind: EntityKind, entity_ref: EntityRef, key: String, value: String, confidence: f32, source: String },
    Relation { subject: EntityRef, predicate: String, object: EntityRef, confidence: f32, source: String },
    DiscoveryPattern { kind: String, payload: serde_json::Value, confidence: f32, potential_bytes_unlocked: u64 },
}

pub enum CostTier {
    Cheap,     // runs on every file, no budget gate
    Medium,    // gated by file-count threshold and user opt-in
    Expensive, // strictly opt-in per category
}
```

A `PopulatorOrchestrator` runs registered populators in cost-tier order during Phase 2, respecting:
- A global pause flag.
- A performance budget (Cheap < 5% scan time; Medium/Expensive only on opt-in).
- Resume points (state persisted per-populator-per-file so a paused/restarted scan picks up where it left off).
- A negative-assertion check before emitting any Assertion (don't re-suggest rejected pairs).

### Wave 1 populators

#### `RulePopulator` (Cheap, always-on)

Path/filename/extension matchers. Ships with the starter "Personal Storage Patterns" rule bundle. Rules are externalizable (`config/ontology_rules.toml`-ish file shipped with the app, plus user-editable additions).

Starter rules include:
- `path matches '*/Personal Details/*'` → `sensitivity=restricted`, conf 1.0.
- `path matches '*/Work Details/*'` → `sensitivity=restricted`, conf 1.0.
- `path matches '*passport*' OR '*aadhar*' OR '*pan*' OR '*payslip*' OR '*salary*'` (case-insensitive) → `sensitivity=restricted`, conf 0.9.
- `path matches '*/Old HDD-Backup/*'` OR `'*/Backup*'` → `role=backup`, conf 0.85.
- `path matches '*/node_modules/*'` OR `'*/.cache/*'` OR `'*/target/debug/*'` OR `'*/target/release/*'` OR `'*/__pycache__/*'` OR `'*/dist/*'` OR `'*/build/*'` → `role=scratch`, conf 0.95.
- `path matches '*/.DS_Store'` OR `'*/Thumbs.db'` OR `'*/desktop.ini'` → `role=system`, conf 1.0.
- `extension in ('psd', 'ai', 'ae', 'xd', 'aep', 'sketch', 'fig')` → `role=source` candidate, conf 0.85.
- `extension in ('ttf', 'otf', 'woff', 'woff2', 'eot')` → `role=asset`, conf 0.95.
- `extension in ('exe', 'msi', 'dmg', 'app', 'AppImage')` → `role=tool` candidate, conf 0.75.
- `filename matches '^Screenshot[_-].*' OR '^Screen Shot.*'` → `origin=phone-screenshot|app-export`, conf 0.85.
- `filename matches '^IMG[_-].*WA.*'` → `origin=messenger-received`, conf 0.9.
- `filename matches '^IMG_\d{8}_\d{6}.*' OR '^DSC.*' OR '^PXL_.*'` → `origin=phone-camera`, conf 0.85.

Plus folder-pattern rules:
- `folder name contains '(\d{4})'` (year in parens) → tags folder for downstream FRBR analysis (Wave 2; Wave 1 just stores the tag).
- `folder name contains '\[.*Dub\]' OR '\[.*Sub\]'` → same.

#### `MetadataExtractorPopulator` (Medium, opt-in by file-count threshold)

Per-format readers. Wave 1 ships:
- **PDF** (`lopdf` crate or similar): info dictionary → title, author, producer, creation date. Properties: PDF-`title` and `author` stored as opaque tags on the File (not part of the ontology vocabulary itself, but useful for search and Discoveries-side Work-title parsing in Wave 2).
- **EXIF** (`kamadak-exif`): camera make/model → `origin=phone-camera` confirmed at conf 0.95 if make/model present. GPS data deliberately *not* stored (privacy).
- **ZIP central directory** (`zip` crate): read TOC without extraction. For zips containing `.dll`, `.exe`, `.jar`, `.so` files: tags File as `role=tool` candidate at conf 0.7. For zips containing only media: leaves role unmodified.
- **ID3** (`lofty` crate): MP3/M4A/FLAC artist/album/title. Stored as opaque tags (Wave 2 fuel for Work resolution).

Threshold gate: if `count(files with format X) > 10000` and user has not opted in, the populator queues a one-time prompt "Birds Eye can extract metadata from your X-format files (~Y minutes). Enable?" Once opted in, the answer persists per-index.

#### `StructuralHeuristicPopulator` (Cheap, always-on; emits only DiscoveryPatterns)

Heuristic logic operating on file siblings and timestamps:

**Sibling-derivedFrom heuristic:**
```
For each File f1 with role IN ('source', undecided) in folder F:
  For each File f2 in F (or its sibling/exports folders):
    if normalize(name(f2)) starts_with normalize(name(f1))
    AND modified_at(f2) > modified_at(f1)
    AND size_ratio(f1, f2) in [0.05, 50]
    AND extension(f1) ≠ extension(f2):
      emit DiscoveryPattern derivedFrom(f2, f1), conf = computed
```

**Cross-folder backupOf heuristic:**
```
For each File f1 in a folder matched by 'backup-zone-pattern' rules:
  Find files anywhere else on disk with same normalized name and within 50% size:
    if found: emit DiscoveryPattern backupOf(f1, candidate), conf = computed
```

**Replaceability inference (rule-augmented heuristic):**
- `role=derivative` + resolved derivedFrom to existing source → `replaceability=regenerable`, conf 0.95.
- `role=tool` + filename matches known-installer pattern (`*-Setup*`, `*Installer*`) → `replaceability=redownloadable`, conf 0.6 (because we *don't actually know* whether the original install source is online).
- All other files default to `replaceability=unknown` (a real value distinct from any cleanup-eligible state).

#### `PerceptualHashPopulator` (Expensive, opt-in per category)

Computes pHash (and dHash as a tiebreaker) for image files. Stores hashes in an `ontology_perceptual_hashes` table:

```sql
CREATE TABLE ontology_perceptual_hashes (
  file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  phash BLOB NOT NULL,        -- 64-bit
  dhash BLOB NOT NULL,        -- 64-bit
  computed_at INTEGER NOT NULL
);
CREATE INDEX idx_phash ON ontology_perceptual_hashes(phash);
```

Near-duplicate clusters (Hamming distance ≤ threshold) become DiscoveryPattern entries of kind `near-duplicate-cluster`, with `potential_bytes_unlocked` set to the sum of (cluster size minus largest member).

Wave 1 scope: image pHash only. Video pHash deferred.

### Populator orchestration

```
On Phase 2 start (or resume):
  Run cheap populators against all files (parallel-batched, no user prompt)
  Check for pending Medium-tier opt-in prompts; if user has decided, run those
  Check for pending Expensive-tier opt-ins; if user has enabled per-category, run those
  Materialize DiscoveryPatterns into the ontology_discoveries table
  Update the "enrichment progress" metric for the UI
```

Pausing: a global pause flag is honored at every populator-batch boundary. Resume is automatic when the flag clears.

Negative-assertion check: before emitting any Assertion, the orchestrator queries `ontology_negative_assertions` and skips the assertion if a matching rejection exists.

---

## Cleanup Engine

### The cleanup-decision predicate

Implemented as a SQL view, regenerable per query for the live cleanup plan:

```sql
CREATE VIEW v_cleanup_candidates AS
WITH file_facts AS (
  SELECT
    f.id AS file_id,
    f.size,
    f.path,
    e.id AS entity_id,
    MAX(CASE WHEN a.key = 'role' THEN a.value END) AS role,
    MAX(CASE WHEN a.key = 'role' THEN a.confidence END) AS role_conf,
    MAX(CASE WHEN a.key = 'replaceability' THEN a.value END) AS replaceability,
    MAX(CASE WHEN a.key = 'replaceability' THEN a.confidence END) AS replaceability_conf,
    MAX(CASE WHEN a.key = 'sensitivity' THEN a.value END) AS sensitivity,
    -- ... etc for other properties ...
    EXISTS(SELECT 1 FROM ontology_pinned_files p WHERE p.file_id = f.id) AS is_pinned
  FROM files f
  JOIN ontology_entities e ON e.kind = 'File' AND e.linked_file_id = f.id
  LEFT JOIN ontology_attrs a ON a.entity_id = e.id
  GROUP BY f.id, e.id
),
project_lifecycles AS (
  SELECT
    r.subject_id AS file_entity_id,
    MAX(CASE WHEN a.key = 'lifecycle' THEN a.value END) AS lifecycle
  FROM ontology_relations r
  JOIN ontology_entities pe ON pe.id = r.object_id AND pe.kind = 'Project'
  LEFT JOIN ontology_attrs a ON a.entity_id = pe.id AND a.key = 'lifecycle'
  WHERE r.predicate = 'partOf'
  GROUP BY r.subject_id
),
hard_excluded AS (
  SELECT ff.file_id
  FROM file_facts ff
  LEFT JOIN project_lifecycles pl ON pl.file_entity_id = ff.entity_id
  WHERE ff.sensitivity IN ('private', 'restricted')
     OR ff.replaceability = 'irreplaceable'
     OR ff.role IN ('source', 'system', 'asset', 'tool')
     OR pl.lifecycle = 'active'
     OR ff.is_pinned = 1
)
SELECT
  ff.file_id,
  ff.size,
  ff.path,
  /* reason buckets evaluated explicitly */
  CASE
    WHEN ff.role = 'derivative'
         AND ff.replaceability = 'regenerable'
         AND EXISTS (
           SELECT 1 FROM ontology_relations r
           JOIN ontology_entities src ON src.id = r.object_id
           JOIN files srcf ON srcf.id = src.linked_file_id
           WHERE r.predicate = 'derivedFrom'
             AND r.subject_id = ff.entity_id
             AND srcf.deleted_at IS NULL
         )
      THEN 'safe-derivative'
    WHEN ff.role = 'backup'
         AND EXISTS (
           SELECT 1 FROM ontology_relations r
           JOIN ontology_entities org ON org.id = r.object_id
           JOIN files orgf ON orgf.id = org.linked_file_id
           WHERE r.predicate = 'backupOf'
             AND r.subject_id = ff.entity_id
             AND orgf.deleted_at IS NULL
         )
      THEN 'redundant-backup'
    WHEN ff.role = 'scratch' AND ff.role_conf >= 0.9
      THEN 'scratch'
    WHEN ff.role = 'derivative'
         AND EXISTS (
           SELECT 1 FROM project_lifecycles pl
           WHERE pl.file_entity_id = ff.entity_id
             AND pl.lifecycle IN ('finished', 'archived')
         )
         /* AND last_accessed_at < now - 6 months */
      THEN 'finished-project-cruft'
    ELSE NULL
  END AS reason
FROM file_facts ff
WHERE ff.file_id NOT IN (SELECT file_id FROM hard_excluded)
  AND CASE /* same as above */ END IS NOT NULL;
```

Plus exact-duplicate and near-duplicate cleanup eligibility are evaluated separately (existing dedup logic + new pHash logic).

### Cleanup-plan execution

```rust
pub fn execute_cleanup_plan(plan_id: PlanId) -> Result<CleanupResult, CleanupError> {
    // 1. Re-evaluate predicate on each candidate — facts may have changed
    // 2. For each file:
    //    a. Move to recycle bin (platform-specific API)
    //    b. Append to ontology_cleanup_log with full gating-fact snapshot
    //    c. Mark file as deleted in scan index (existing pathway)
    // 3. Update plan status to 'executed'
    // 4. Schedule a retention-window-expiry job
}
```

All cleanup operations are wrapped in:
- A pre-execution preview shown to the user (per file, with gating facts).
- Recycle-bin-first execution (never hard-delete).
- Per-file failure isolation (one failed move does not abort the plan).
- A post-execution summary view.

### Restore from log

```rust
pub fn restore_from_cleanup_log(entry_id: LogEntryId) -> Result<(), RestoreError> {
    // 1. Verify entry is still in 'in_recycle_bin' status
    // 2. Move file back from recycle bin to original_path
    // 3. Mark log entry restore_status='restored'
    // 4. Re-link to scan index if file_id still exists
}
```

Retention expiry: a periodic job marks log entries `restore_status='expired'` once `expires_at` is past. Expired entries can no longer be restored (the recycle bin may have been emptied by the OS or the user).

---

## Discoveries Panel

### Data model

DiscoveryPatterns produced by populators land in `ontology_discoveries`. Each row:

- `kind` — categorical (`derivedFrom-pattern`, `backupOf-pair`, `near-duplicate-cluster`, `theme-suggestion`, `role-suggestion`, ...).
- `payload` — JSON containing the candidate facts and the pattern signature for batching.
- `status` — `pending` until resolved.
- `confidence` — aggregated confidence of the pattern.
- `potential_bytes_unlocked` — estimated bytes the cleanup engine could unlock if the user confirms.

### Pattern-level vs item-level confirmation

The Discoveries UI presents items in groups by pattern signature. For each group:
- "Confirm pattern" → bulk-confirm all candidate facts in the group at conf 1.0, source `user`.
- "Reject pattern" → bulk-add negative assertions for all candidates in the group.
- "Open to review" → drill into per-item list, individual confirm/reject.

Single-item Discoveries (no shared pattern) appear individually with confirm/reject.

### ROI ranking

```
display_priority = log(potential_bytes_unlocked + 1) × confidence × decay(age)
```

Where `decay(age)` mildly downweights very old Discoveries. The top ~10–30 highest-priority entries are surfaced per session. The user can scroll past the "today's diet" cutoff to see lower-priority Discoveries on demand.

### Inline confirm-from-anywhere

The Discoveries panel is not the only entry point. When the user opens a file detail panel that has pending Discovery suggestions involving that file, the suggestions show inline with confirm/reject. Confirmed suggestions populate the appropriate `ontology_attrs` / `ontology_relations` row and disappear from the Discoveries queue.

### Daily-diet enforcement

The panel never shows more than `DAILY_DIET_CAP` (default 30) categories per session by default. The user can request more via "show all." This is Constitutional Defense #6 in action — preventing the wall-of-suggestions failure mode.

---

## Treemap Re-coloring Lenses

The existing `TreemapCanvas.tsx` is extended with a lens selector and color-resolution function. The geometry is unchanged; only the per-node color is parameterized.

| Lens | Color resolution |
|---|---|
| **Size** *(existing)* | Existing palette by byte magnitude |
| **Role** | Per-role palette (source=blue, derivative=green, reference=orange, asset=purple, tool=teal, backup=grey, scratch=yellow, system=dark grey, unclassified=pale) |
| **Replaceability** | irreplaceable=#c0392b, recoverable-with-effort=#e67e22, redownloadable=#f1c40f, regenerable=#2ecc71, unknown=#bdc3c7 |
| **Lifecycle** | active=#3498db, finished=#27ae60, abandoned=#7f8c8d, archived=#95a5a6, planning=#85c1e9, none/unclassified=pale |
| **Reclaimable mass** ⭐ | Cleanup-eligible bytes colored by reason bucket; non-eligible greyed at low opacity |

Color resolution queries the ontology layer for the relevant property/relation; falls back to a "no data" pale color when the file is unclassified. Caching: a per-file color map is computed once per lens-change and cached until the next enrichment update.

---

## Saved Views Library (Wave 1 starter)

Six saved views ship with Wave 1. Each is a parameterized SQL query; UI lists them by friendly name; user can clone/edit/save new ones.

1. **Finished projects untouched 1+ year.** Files where `partOf` a Project with `lifecycle in {finished, archived}` AND `last_accessed_at < now - 365 days`.
2. **Regenerable derivatives over 100 MB.** Files where `role='derivative' AND replaceability='regenerable' AND size > 100MB`.
3. **Files in folders not part of any Project.** Files whose parent folder has no `partOf` to any Project.
4. **Files with no classification yet.** Files lacking any `role` property — invitation for the user to classify.
5. **Sources with no surviving derivatives.** Files where `role='source'` and no inbound `derivedFrom` edges resolve to existing on-disk files. Candidates for archive zones.
6. **Backups whose origin no longer exists.** Files where `role='backup'` and outbound `backupOf` edge resolves to a deleted-from-disk file. **These are protected, not cleanup candidates** — the only-copy case.

---

## Frontend Surfaces

Additions to `frontend/src/`:

### New top-level views

- **`CleanupView.tsx`** — the grouped-by-reason plan UI, plan preview, execute-confirm modal, per-file gating-fact display, post-execution summary.
- **`DiscoveriesView.tsx`** — the pattern-level + item-level confirmation surface.
- **`RecentlyCleanedView.tsx`** — the persistent restore log with one-click restore.
- **`SavedViewsView.tsx`** — saved-view list, cloning UI, results table.

### Existing views extended

- **`TreemapCanvas.tsx`** — add a lens-selector prop and lens-aware color function.
- **File detail panel** (currently embedded in dashboard) — add tabs for "Classifications," "Relations," "Why" (provenance chain), and "Override."
- **`Settings.tsx`** — add toggles for enrichment on/off, performance budget tier, sensitivity zones (path patterns), recycle-bin retention window, quiet-mode toggle.

### Cross-cutting UI rules

- Files with `sensitivity ∈ {private, restricted}` are hidden from global search results, the Discoveries panel, "Recently Cleaned" cross-views, and treemap labels (color block remains). They appear normally only in their parent folder's detail view.
- A persistent "Enrichment progress: X%" pill in the top bar while Phase 2 is running. Click to pause/resume.
- A "Quiet mode" toggle in settings disables Discoveries surfacing, treemap re-coloring proposals, and soft-classification UI.

---

## Backend Additions (Tauri commands)

New commands to expose on top of the existing native API surface:

```rust
#[tauri::command]
fn enrich_index_job(
    index_path: PathBuf,
    populator_set: PopulatorSet,      // 'cheap-only' | 'standard' | 'all-opt-in'
    performance_budget: BudgetTier,
) -> Result<JobId, ApiError>;

#[tauri::command]
fn enrichment_status(job_id: JobId) -> Result<EnrichmentStatus, ApiError>;

#[tauri::command]
fn pause_enrichment(job_id: JobId) -> Result<(), ApiError>;

#[tauri::command]
fn resume_enrichment(job_id: JobId) -> Result<(), ApiError>;

#[tauri::command]
fn discoveries(filter: DiscoveryFilter, limit: u32, offset: u32) -> Result<Vec<Discovery>, ApiError>;

#[tauri::command]
fn confirm_discovery(id: DiscoveryId) -> Result<(), ApiError>;

#[tauri::command]
fn reject_discovery(id: DiscoveryId, reason: Option<String>) -> Result<(), ApiError>;

#[tauri::command]
fn confirm_discovery_pattern(pattern_signature: String) -> Result<u32, ApiError>;  // returns confirmed count

#[tauri::command]
fn reject_discovery_pattern(pattern_signature: String) -> Result<u32, ApiError>;

#[tauri::command]
fn cleanup_plan(scope: CleanupScope) -> Result<CleanupPlan, ApiError>;

#[tauri::command]
fn execute_cleanup_plan(plan_id: PlanId) -> Result<CleanupResult, ApiError>;

#[tauri::command]
fn recently_cleaned(limit: u32, offset: u32) -> Result<Vec<CleanupLogEntry>, ApiError>;

#[tauri::command]
fn restore_from_cleanup_log(entry_id: LogEntryId) -> Result<(), ApiError>;

#[tauri::command]
fn pin_file(file_id: FileId, note: Option<String>) -> Result<(), ApiError>;

#[tauri::command]
fn unpin_file(file_id: FileId) -> Result<(), ApiError>;

#[tauri::command]
fn file_provenance(file_id: FileId) -> Result<FileProvenance, ApiError>;  // gating facts + classification chain

#[tauri::command]
fn override_classification(
    file_id: FileId,
    key: String,
    value: String,
) -> Result<(), ApiError>;  // user-source assertion at conf 1.0

#[tauri::command]
fn saved_views() -> Result<Vec<SavedView>, ApiError>;

#[tauri::command]
fn run_saved_view(view_id: SavedViewId, params: ViewParams) -> Result<ViewResult, ApiError>;
```

### File and module layout

Recommended additions:

```
src/
  ontology/
    mod.rs              // public API
    schema.rs           // migration scripts
    entities.rs         // entity CRUD
    attrs.rs            // attribute CRUD
    relations.rs        // relation CRUD
    populators/
      mod.rs
      rules.rs          // RulePopulator + rule loader
      extractors.rs     // MetadataExtractorPopulator
      heuristics.rs     // StructuralHeuristicPopulator
      phash.rs          // PerceptualHashPopulator
    orchestrator.rs     // populator scheduling, pause/resume, budget
    discoveries.rs      // discovery queue management
    cleanup/
      mod.rs
      predicate.rs      // the v_cleanup_candidates SQL builder
      executor.rs       // plan execution + recycle-bin integration
      restore.rs        // restore from log
    sensitivity.rs      // UI-containment-boundary helpers
  native/
    api.rs              // add the new commands
config/
  ontology_rules.toml   // the starter rule bundle, shipped with the app
```

---

## Defenses, Restated as Testable Invariants

Each constitutional defense becomes one or more automated tests in the test suite. These tests gate every PR that touches the ontology layer.

| # | Invariant | Test |
|---|---|---|
| 1 | No code path moves files outside `execute_cleanup_plan` | Static check + integration test that grep's src for `fs::rename`/`fs::remove_file` outside the cleanup module |
| 2 | `execute_cleanup_plan` always recycle-bins; never hard-deletes | Integration test: invoke cleanup on a temp file, verify recycle-bin presence, verify file is not gone-from-disk |
| 3 | `sensitivity ∈ {private, restricted}` files never appear in cross-cutting query results | Property-based test: insert a sensitive file, run every saved view + search + Discoveries query, assert exclusion |
| 4 | `replaceability=irreplaceable` files never enter the cleanup queue | Property-based test against `v_cleanup_candidates` |
| 5 | Phase 2 enrichment cannot block Phase 1 scan completion | Integration test: start scan, force-block enrichment thread, verify Phase 1 still completes |
| 6 | Vocabulary migrations write new versions, never overwrite user-confirmed facts | Migration test: insert a user-confirmed fact, run a v→v+1 migration that targets the same key, assert old fact survives |
| 7 | `confirm_discovery_pattern` requires median pattern confidence ≥ 0.7 (or per-item review opt-in) | Unit test |
| 8 | First-run rule bundle is loaded for any new index | Integration test: create empty index, assert ≥30 rules registered |
| 9 | Pinned files never appear in `v_cleanup_candidates` | Property-based test |
| 10 | Negative assertions block re-suggestion | Integration test: reject a Discovery, re-run populator, assert no DiscoveryPattern emitted for same pair |
| 11 | Cleanup plan execution is per-file isolated | Integration test: deliberately fail one file move, verify others proceed and log records the failure |
| 12 | `display_in_global_views=0` is honored by every cross-cutting query | Static check: SQL audit of every query that lists files, assert WHERE clause includes the flag |

---

## Migration and Rollback

### First-time enable on an existing index

1. User upgrades to a Birds Eye build with Wave 1 ontology.
2. On opening an existing index, user sees a one-time prompt: *"Birds Eye now supports a Cleanup Intelligence layer. Enable for this index? (Disabling at any time is non-destructive.)"*
3. Yes → ontology tables created via migration script; first-run rule bundle loaded; Phase 2 enrichment queued.
4. No → tables created (cheap), but `ontology_enabled` row not set; UI surfaces hidden; no Phase 2 work.

### Rollback / disable

User disables the layer in Settings:
- All cleanup-engine surfaces and Discoveries panels are hidden.
- Treemap reverts to Size lens; other lenses disabled.
- Phase 2 enrichment job is paused indefinitely.
- All ontology data remains in the database — no destruction.
- Re-enabling later resumes from where it left off.

### Vocabulary migration

When a future build introduces a vocabulary change (e.g., splits `role=tool` into `editor/plugin/installer`):
1. Migration script bumps `current_version` in `ontology_vocabulary_version`.
2. For each affected key, the migration:
   - Re-runs rule-based populators against affected files, producing new-version facts.
   - For user-confirmed facts at the old version, queues a Discovery of kind `vocabulary-migration` asking the user to recategorize.
3. Cleanup predicate reads the *highest-version* fact for each key.

---

## Verification

End-to-end testing scenarios for Wave 1, against the `chapter-2-example-real-dataset/` directory:

### Scenario V1 — Personal Details safety

1. Run a full scan on `chapter-2-example-real-dataset/`.
2. Enable ontology, run Phase 2.
3. Assert: every file under `chapter-2-example-real-dataset/Personal Details/` has `sensitivity=restricted` at confidence 1.0, source `rule:path-prefix-personal-details`.
4. Assert: none of those files appear in `v_cleanup_candidates`.
5. Assert: none appear in global search results or any cross-cutting view.

### Scenario V2 — List.psd protection

1. Assert: `Toonie_world/List.psd` has `role=source` at confidence ≥ 0.85.
2. Assert: `replaceability=irreplaceable` propagated.
3. Assert: hard-excluded from `v_cleanup_candidates`.
4. Place a synthetic `Toonie_world/List_export.png` with timestamp after the PSD.
5. Assert: StructuralHeuristicPopulator emits a `derivedFrom-pattern` Discovery linking the PNG to the PSD.
6. Confirm the Discovery.
7. Assert: `Toonie_world/List_export.png` now has `role=derivative` and a `derivedFrom` relation to the PSD.
8. Assert: the PNG appears in `v_cleanup_candidates` with reason `safe-derivative`.

### Scenario V3 — Backup protection

1. Place a synthetic file in `chapter-2-example-real-dataset/Old HDD-Backup/Practice Work/X.txt`.
2. Place an identical file at `chapter-2-example-real-dataset/Projects/Active/X.txt`.
3. Run enrichment.
4. Assert: a `backupOf-pair` Discovery is emitted linking the two.
5. Confirm.
6. Assert: the backup file appears in `v_cleanup_candidates` with reason `redundant-backup`.
7. Now delete the `Projects/Active/X.txt` (the origin) from the filesystem and rescan.
8. Assert: the backup file is **no longer** in `v_cleanup_candidates` — it's now protected because its origin is gone.
9. Assert: the backup file *does* appear in the "Backups whose origin no longer exists" saved view.

### Scenario V4 — Recycle-bin-first guarantee

1. Construct a small cleanup plan (one file).
2. Execute.
3. Assert: file is in the OS recycle bin.
4. Assert: file is not at its original path.
5. Assert: a row exists in `ontology_cleanup_log` with `restore_status='in_recycle_bin'` and a snapshot of the gating facts.
6. Invoke `restore_from_cleanup_log` on that entry.
7. Assert: file is back at its original path.
8. Assert: log entry now has `restore_status='restored'`.

### Scenario V5 — Sensitivity containment

1. Create a sensitive file with a unique distinctive title in its embedded metadata (e.g., a PDF titled "UNIQUE_TOKEN_12345").
2. Place in `chapter-2-example-real-dataset/Personal Details/`.
3. Run enrichment with PDF extractor enabled.
4. Assert: the extracted title is stored in `ontology_attrs` with `display_in_global_views=0`.
5. Run global search for "UNIQUE_TOKEN_12345".
6. Assert: zero results.
7. Open the parent folder's detail view.
8. Assert: the file's title is visible there (in-context).

### Scenario V6 — Pause/resume

1. Start Phase 2 enrichment.
2. Invoke `pause_enrichment` mid-run.
3. Assert: enrichment progress stops; UI shows "paused at X%".
4. Close the app, reopen.
5. Assert: enrichment is still paused at the same progress.
6. Invoke `resume_enrichment`.
7. Assert: enrichment resumes and completes.

### Performance verification

- Phase 1 scan on a 200K-file directory completes in within ±5% of the pre-Wave-1 baseline (i.e., the ontology layer does not regress the existing scan path).
- Phase 2 enrichment with only cheap populators completes within 30% additional time beyond Phase 1.
- Phase 2 with extractors enabled (PDF + EXIF + ID3) on a 200K-file directory with ~30K extractable files completes within a documented budget (target: under 10 minutes on a mid-range laptop).

### Constitutional defense audit

Before merging Wave 1, run the test suite covering all 12 invariants in §13. All must pass. A single invariant failure blocks the merge.

---

## Open Questions

Four points the spec deliberately leaves for implementation to resolve, because their right answers depend on real-data signals or trade-offs better resolved in code:

1. **Heuristic thresholds for `derivedFrom` and `backupOf`.** The size-ratio bounds [0.05, 50], the name-overlap normalization function, and the timestamp window are all *empirical*. Initial values should be conservative (favor false-negatives over false-positives) and tuned with real-dataset feedback.

2. **Whether to ship `PerceptualHashPopulator` in Wave 1 or defer to Wave 1.1.** It addresses Case 4 (same-image-multiple-themes) directly, but adds ~50MB of dependencies (image decoding + pHash) and meaningful enrichment time. Recommended: include in Wave 1 behind an opt-in toggle (default off), upgrade to default-on in Wave 1.1 once we have user feedback.

3. **First-run rule bundle composition.** The starter rules listed in §6 are a draft. The right set is the *universally useful* subset — paths that almost every user has and that benefit from automatic classification. Validation: run the bundle against the `chapter-2-example-real-dataset/` and a few volunteer users' real drives; trim rules that misclassify often.

4. **Discoveries panel — inline placement.** Where exactly do inline Discovery suggestions appear in the file detail panel? At the top, in a dedicated tab, or as banner badges? UX exploration during implementation, with the requirement that they not nag.

---

## Summary

Wave 1 of the Birds Eye ontology layer ships safer dedup and smarter reorg through a small typed vocabulary (5 classes, 6 relations, 6 properties + replaceability, 3 fact-metadata), a transparent cleanup-decision predicate, a user-in-the-loop Discoveries panel, and four new treemap re-coloring lenses — all gated by 8 constitutional defenses encoded as automated invariants. It is fully opt-in, fully reversible (Recycle-bin-first, persistent restore log), and architecturally separable from Birds Eye's existing scan path. The cognition-side features (Work, Theme, manifestationOf, depicts, language) are schema-present but populator-dormant, ready for Wave 2 to layer on without migration.

This spec is the input to a follow-on `writing-plans` invocation that will produce the step-by-step implementation plan.
