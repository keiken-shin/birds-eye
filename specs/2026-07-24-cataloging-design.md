# Cataloging — design spec

- **Date:** 2026-07-24
- **Branch:** `feat/cataloging`
- **Status:** design approved; revised after a code-verification pass (see Revision note)
- **Workspace placement:** settled — Catalog is its own switcher segment (see Placement)

## Revision note

The first draft assumed more reuse than the codebase offers. A verification pass against the
real code corrected it in five load-bearing places: the folder-classification guardrail has no
data behind it, discovery confirm/reject rejects unknown kinds outright, the cleanup tray and
review modal are delete-only in a way that makes a mixed tray unsafe, "select all N matching"
has no backing query, and the proposed `undo_relocation` was unnecessary. Each is corrected
below with the evidence inline.

## Problem

Bird's Eye can tell you what is safe to *remove*. Cataloging is the second half of storage
cognition: what should live *somewhere else*. The app suggests where scanned files should
actually live, and gives the user the tools to arrange files their own way — with the system
learning from every correction.

## Decisions

1. **Grounding:** suggestions are learned from the user's own existing structure first, with
   convention templates as the cold-start fallback. No training period — suggestions appear
   from the first enriched scan, and the user's review actions (accept / edit / reject) are
   the training signal.
2. **Unit:** grouped suggestion cards — one cluster of similar files, one destination, one
   decision. No per-file rows, no whole-tree restructure proposals.
3. **User arrangement:** system suggestions by default. Manual arrangement lives in the Files
   view (search → multi-select → move / create folder). A "Save as rule" offer after acting
   turns behavior into a persistent rule; there is no upfront rule-builder UI.
4. **Architecture:** cataloging is an ontology populator inside the opt-in intelligence
   layer. When intelligence is off, the Catalog surface shows an enable CTA. No standalone
   fallback engine.
5. **Safety:** accepting a card stages it; nothing moves without the review gate. Same
   promise as cleanup: *nothing moves without a review step, ever.*
6. **Guardrail (revised):** the engine only proposes moves for files in **inbox zones**, and
   within those excludes files carrying a protective `role` attribute. It cannot reason about
   "folder coherence" in V1 — no populator produces a folder classification today
   (`ensure_folder_entity` in `src/ontology/populators/mod.rs:269` has no non-test caller;
   `EntityKind::Project` is constructed only in tests). The guardrail is therefore expressed
   **positively by zone** rather than negatively by folder kind. Folder-level `folderKind`
   classification is a named follow-up, and the honest consequence is stated in V1
   simplifications.

## Suggestion engine — `CatalogPopulator`

New populator in `src/ontology/populators/`, appended to `PopulatorOrchestrator::default()`'s
vec (`src/ontology/orchestrator.rs:163-171`) at `CostTier::Cheap`. `ordered()` is a stable
sort by cost tier alone (`orchestrator.rs:182`, `cost_rank` at `:310`) — there is no
dependency mechanism, so "runs after `RulePopulator`" is guaranteed by cost tier plus vec
position, pinned by a regression test on the emitted order. Reads the index only, never
touches disk. Resumable via the orchestrator's existing cursor.

### Zone resolution (net-new)

No `dirs` / `directories` / `home` crate is in `Cargo.toml`, and `windows-sys` carries only
`Win32_Foundation` + `Win32_System_RestartManager` — none of this exists yet.

- Home from `USERPROFILE` (fallback `HOME`) via `std::env::var`.
- **V1 accepts the `%USERPROFILE%\Downloads` / `\Desktop` approximation.** Both folders are
  relocatable per-user; resolving them properly needs `SHGetKnownFolderPath`
  (`Win32_UI_Shell`). Recorded as a known limitation rather than silently assumed.
- "Drive root" is defined against the indexed tree (`folders.depth` / `parent_id`), not the
  filesystem — a scan rooted at `D:\Projects` contains no drive root and must yield no
  root-zone candidates.
- Matching is against OS-native backslash paths.

### Candidate set

Files whose folder is inside an inbox zone, **minus** files whose resolved `role` attribute is
`system`, `scratch`, `source`, or `asset` (asserted by `RulePopulator`, which runs first —
`src/ontology/populators/rules.rs:92-152`). This is what replaces the folder-coherence
guardrail: a checked-out repo or a scratch/build directory sitting in Downloads is protected
by its files' roles, not by a folder classification.

### Clustering

Kind starts from `files.media_kind`, computed and stored at scan time
(`src/index/writer.rs:1574-1586`). The closed set is:

`photo, video, music, archive, document, code, installer, model, other`

There is **no `image`** value, and classification is a plain extension whitelist — `.psd`,
`.svg`, `.epub`, `.iso` and extensionless files all land in `other`, which will be the largest
cluster in a typical Downloads folder. The name-pattern refinement (screenshot names,
`IMG_`/`DSC_` camera files, invoice / receipt / resume keywords) therefore carries real weight
and is not cosmetic. Note this vocabulary is **distinct from the ontology `role`** —
`rule:ext-installer` maps exe/msi to role `tool`, not to `installer`.

Clusters are grouped by *zone × refined kind*.

### Destination inference

First match wins:

1. **User rule** (`catalog_rules`) — highest confidence.
2. **Learned home** — the folder outside inbox zones already holding the dominant share of
   same-kind files. Thresholds: ≥ 10 existing files and ≥ 60% share; confidence scales with
   share. **The share denominator is same-kind files outside inbox zones** (not all
   same-kind files) — for a Downloads-heavy user the two differ sharply, and the outside-zone
   denominator is the one that answers "where do you actually keep these". Reason text shows
   the evidence ("87% of your PDFs already live here").
   - Query runs against `files` joined to `folders`, with zone-subtree exclusion applied at
     the `folders` level.
   - Requires `CREATE INDEX idx_files_kind_folder ON files(media_kind, folder_id)` in the
     same migration — there is no index on `media_kind` today
     (`src/index/schema.rs:103-110,122`), so without it this is up to nine full scans of
     `files` per run on a 500k-file index.
   - `folder_media_stats` cannot substitute: it is `(folder_path, media_kind, total_bytes)`
     with **no `file_count`** (`schema.rs:483-487`).
3. **Template fallback** — conventional destination (e.g. `Pictures\Screenshots`), possibly a
   folder that does not exist yet, explicitly marked "will be created".

### Output

One cluster = one `discoveries` row, kind `relocation`. Payload JSON: destination,
destination-exists flag, source (`rule` | `learned` | `template`), human-readable reason,
`fingerprint` and `member_hash` as **top-level keys**, `member_count`, `total_bytes`, and the
**first 50 members only**. A 500-file cluster would otherwise be ~60 KB of escaped JSON per
card, re-fetched on every list (`list_pending_by_kind` SELECTs `payload` for every row and it
crosses IPC as a string). The expandable member list is served lazily by a
`relocation_members(discovery_id)` command.

`potential_bytes_unlocked` is written with the cluster's total bytes, meaning "bytes moved"
for this kind. This is deliberate: the column is the primary `ORDER BY` key
(`src/ontology/discoveries.rs:117`), so all-zero rows would tie and make the server-side
`LIMIT` an arbitrary cut — "top N by impact" would be a re-rank of a random subset.

### Feedback loop

- **Accept** → staged in the UI. The discovery is marked confirmed only at execute time.
- **Reject** → status `rejected`, then suppression. The populator skips re-emitting a card
  whose `fingerprint` matches a rejected row with an unchanged `member_hash`; changed
  membership may re-emit. This needs a new reader `list_by_kind_and_status(conn, kind,
  status)` — `discoveries.rs` today exposes only `get_discovery`, `list_pending_by_kind`
  (status hardcoded to `pending`) and `count_pending` — plus an index on `(kind, status)`;
  the existing `idx_discoveries_status_roi` is `(status, bytes, confidence)` and does not
  serve it. `insert_discovery_if_absent` (`populators/heuristics.rs:295-316`) matches on
  whole-payload string equality and is **unusable** here, since the payload embeds the member
  list.
- **Edit destination then accept**, or a manual bulk move in Files → the app offers
  **"Save as rule"**. A saved rule outranks learned/template on every subsequent run.

## Data model & API

### Migration

Everything new ships as `MIGRATION_011`: bump `CURRENT_SCHEMA_VERSION` to 11 and the pinned
`ALL_MIGRATIONS.len()` assertion (`src/index/schema.rs:1`). **`open_index_connection`
(`src/index/mod.rs:13-20`) sets WAL and a busy timeout but never migrates**, and every native
command uses it — so commands touching new tables must tolerate a pre-migration index
(`CREATE TABLE IF NOT EXISTS` on first use, or an explicit "rescan required" error) rather
than surfacing a raw `no such table`.

### Tables

- **Cards: no new table.** A card is a `discoveries` row (kind `relocation`).
- **`catalog_rules` (new):** id, name, match criteria JSON (kind / name-pattern / zone),
  destination, source (`saved-after-move` | `saved-after-edit`), enabled, created_at. It
  shares nothing with the ontology `RulePopulator` beyond the word "rule".
- **`ontology_relocation_plans` + `ontology_relocation_items` (new):** a plan is an explicit
  `(file_id, from, to)` list. Cleanup persists a *scope predicate* and recomputes
  (`src/ontology/cleanup/plans.rs:3-25`); a per-file destination list is not expressible as a
  `CleanupScope`, so reused cleanup code is ≈ 0.

### Commands

- **Listing** reuses `list_pending_by_kind` unchanged, kind-filtered.
- **Confirm / reject need a code change.** `graduation_plan`
  (`src/ontology/discoveries_resolve.rs:119-151`) matches exactly three Wave-1 kinds and its
  catch-all returns `Err("discovery kind {other} is not user-confirmable in Wave 1")`. Both
  `confirm_discovery` (`:160`) and `reject_discovery` (`:182`) call it **before** `set_status`
  (which is private, `:51`). Today `reject_discovery_cmd` on a `relocation` row errors and
  leaves it `pending`. Fix: a non-graduating branch — `NON_GRADUATING_KINDS` short-circuiting
  to `set_status` in both functions. A relocation must **never** graduate to ontology facts:
  it has no subject/predicate/object triple, and user-sourced role assertions at confidence
  1.0 feed `v_cleanup_candidates`. `confirm_discovery_pattern` / `reject_discovery_pattern`
  are not usable (their median-confidence floor is meaningless here).
- **`count_pending` has no kind filter** (`discoveries.rs:126-133`) and drives the Board badge
  (`CommandSpine.tsx:54`), while `BoardView` renders only `derivedFrom-pattern` and
  `backupOf-pair` (`workspace/src/lib/discoveries.ts:9`). Add `count_pending_by_kind` and
  split the badge, or exclude `relocation` — otherwise the Board reads 47 and renders 2. Add
  a `relocation` entry to `DISCOVERY_KIND_LABELS`.
- **`relocation_plan`** (new) — takes staged card ids + per-file exclusions/edits,
  re-verifies, persists the plan, returns the from → to listing. A parallel plan/execute pair
  with the same command naming as cleanup, **not** a mirror of its internals.
- **`execute_relocation_plan`** (new) — performs the moves, marks the discoveries confirmed,
  returns executed from → to pairs. It does **not** queue the rescan: the caller refreshes and
  calls `scanController.enqueue(root, "metadata")` as MoveDialog does. Unlike MoveDialog
  (which skips the rescan while a scan is running, `MoveDialog.tsx:108`), relocation always
  enqueues — the queue FIFOs.
- **No `undo_relocation`.** `move_files` already takes `Vec<MoveSpec { from, to }>`
  (`src/native/api.rs:263-274`) with a per-file destination each, so undo is
  `moveFiles(pairs.map(({from, to}) => ({from: to, to: from})))` from the frontend. The
  single-destination shape is MoveDialog's UI, not the command's.
- **`catalog_rules` CRUD** (new, thin).

**Frontend bridge:** wrappers in `nativeClient.ts`; mock cards/rules in `dev/mockBackend.ts`.

## UI

**Catalog surface** — `views/CatalogView.tsx`, a new top-level switcher segment (see
Placement). Written as a **body component with its own `ViewHeader` inside the default
export**, so that if Cleanup and Catalog are ever merged behind one header the toggle drops
into a parent and the body is untouched.

- **Intelligence off:** copy BoardView's `if (ontology && !ontologyEnabled)` guard so the CTA
  does not flash during startup. Catalog needs a full-view centered empty state that does not
  exist yet; closest precedent is `CleanupView`'s wrapped `Card`
  (`views/CleanupView.tsx:282-289`). Note the gate is **frontend-only** — `discoveries()` has
  no `is_enabled` check (`api.rs:1028-1031`), so cards emitted before a disable are still
  returned.
- **Card list**, ranked by impact × confidence: destination (+ "will be created" badge),
  reason line with evidence, source badge (rule / learned / template), member count + bytes,
  expandable member list (lazy) with per-file exclude, editable destination.
- **Accept** stages into a **separate `stagedMoves` store field — not `staged`**.
  `StagedItem` (`state/types.ts:31-39`) has no action discriminant and no destination (`kind`
  already means folder-vs-file), and `ReviewModal` feeds *every* staged path to
  `buildCleanupPlan` as a delete scope prefix (`ReviewModal.tsx:63-70`). A relocate item in
  the shared array would be consumed as deletion scope.
- **Empty states** must distinguish "still working" from "never got there" by reading
  `ontology_populator_state` via `ontology_status`, not orchestrator progress alone (see
  Error handling). `ontology` is refetched only inside `refreshData()` — there is no polling
  loop, so either watch the scan job the way Board does, or accept refresh-on-navigation.

**Cleanup Tray — required change, easy to miss.** `CleanupTray.tsx` reads **only** `staged`:
it hardcodes the label "Cleanup tray", the button "Review & clean", `disabled={!staged.length}`
and the empty text "Nothing staged — select something and add it here." With `stagedMoves`
populated and `staged` empty, accepted relocations would be invisible *and* unexecutable. It
must render both kinds (relocate chips carry `→ destination`), branch its label, total and
button ("Review & clean" / "Review & move", both when both arrays are populated). ~30 lines.
`WorkspaceShell.tsx:40-43` needs **zero** changes — ⌘Enter already calls `openReview()`, and
the discrimination lives in the store.

**Review gate** — a new `RelocateReviewModal` (~150-250 lines) reusing `OverlayShell`, the
skeleton rows, and the request-id/abort pattern from `ReviewModal`. Nothing else transfers:
the plan type, `ALL_REASONS`, the protected-hold-back partition, the recycle-bin override
block, the disposal-mode radios and the 30-day retention copy are all cleanup-specific.
`workspaceStore.review: boolean` becomes a discriminated flag so both gates can coexist.
Warnings render inline (file changed since suggestion, name collision, folder will be
created), with per-item deselect.

**Files view**

- Multi-select via a local `Set<string>` mirroring `CleanupView`'s `picked`
  (`CleanupView.tsx:100, 175-196`) — not a store global. The row body keeps driving Inspector
  single-select; the checkbox is a separate hit target.
- **"Select all loaded"**, capped at `SEARCH_LIMIT` (500), with an honest "showing first 500
  matches" note. True select-all-N is not possible: `search_files` has no `OFFSET` and returns
  no total (`src/index/writer.rs:765-773`); regex mode drops the LIMIT and truncates in memory
  (`:789-792`). This also fixes the existing count line, which already reports `rows.length`
  and so silently under-reports past 500 (`FilesView.tsx:339`).
- **Move to…** opens the existing MoveDialog with an added optional "New folder" name input;
  on confirm the destination becomes `joinDest(dest, newFolderName)` (helper already at
  `MoveDialog.tsx:28-32`). No backend work — `move_files` already `create_dir_all`s the
  destination parent (`api.rs:304-312`). The destination field stays `readOnly` in native mode
  (`:203`); in browser mode a typed path is already created, so this is convenience, not new
  capability.
- After a filter-derived bulk move, a one-line "Save as rule?" prompt.

## Error handling

- **Re-verification is new work.** Cleanup never stats the filesystem; per-file
  `fs::metadata` checking is new, and it must run at **execute** time as well as plan time —
  plan-time collision checks are advisory, and the only real guard is `to.exists()` at
  execute. Also drop members whose `files` row now has `deleted_at IS NOT NULL` (an earlier
  move marks sources deleted without inserting destinations, `api.rs:246-261, 327-329`).
- **Orphan copies.** `move_files` falls back to `copy` + `remove_file` on *any* rename error
  (`api.rs:313-317`). Copy-succeeds/remove-fails — the common Windows locked-source case —
  reports failure while leaving a full duplicate at the destination, and retry then hits
  `to.exists()` permanently. Fix at the source: restrict the fallback to
  `ErrorKind::CrossesDevices`, or delete the orphan destination on that path.
- **Concurrency with scanning.** `move_files`' index bookkeeping is `let _ = conn.execute(…)`
  (`api.rs:256`) and `mark_missing_files_deleted` only touches rows with `indexed_at <
  started_at`, so a relocation during a scan can leave ghost source rows no scan heals. Either
  gate `execute_relocation_plan` on `scanView.status`, or surface that index-update error and
  always enqueue the rescan. The scan writer holds `BEGIN IMMEDIATE` across ~10k files against
  a 5s busy timeout.
- **Partial failures** reuse MoveDialog's per-file failure list with reasons and
  retry-or-dismiss; `SHOWN_LIMIT = 5` must be raised when the failure list *is* the content.
  Lock diagnostics via `file_lock_holders` are **new wiring** (only `ScansView.tsx:102` calls
  it today) and are a no-op off Windows.
- **Populator failure** marks the row `failed`, rewinds to the last *paused* cursor (in-run
  progress is lost) and **aborts the remaining chain** for that pass
  (`orchestrator.rs:255, 266, 278`). Since Catalog sits last in the Cheap tier, a cancel or an
  earlier populator's failure yields zero cards — which is exactly why the empty state must
  read populator state rather than infer "nothing to suggest".

## Testing

- **Rust**, on synthetic index fixtures: clustering over the real `media_kind` vocabulary,
  learned-home thresholds and denominator, rule precedence, rejection-fingerprint
  suppression, zone resolution (including the no-drive-root case), plan re-verify (missing
  file / collision), executor partial failure.
- **Move seam:** cleanup's partial-failure tests work because the destructive call is injected
  (`trait Trasher`, `src/ontology/cleanup/executor.rs:24-35`). `move_files` has no such seam —
  either add a `Mover` trait or drive the tests through tempdir fixtures.
- **TS:** mock-backend parity and card-ranking helpers, following `domain.test.ts`. The mock
  move handler never fails or collides (`dev/mockBackend.ts:1000-1012`), so it needs
  injectable failures or the review-gate error states are unreachable in the browser.
- One native smoke test on a scratch folder.

## V1 simplifications (deliberate)

- **No folder-coherence guardrail.** The engine is scoped to inbox zones plus role exclusion.
  The consequence, stated plainly: a coherent folder that happens to sit in Downloads is
  protected only if its files carry protective roles. `folderKind` classification is the
  follow-up that closes this, and it is the highest-value one on this list.
- **Known-folder approximation.** `%USERPROFILE%\Downloads` / `\Desktop` rather than
  `SHGetKnownFolderPath`; wrong for users who have relocated those folders.
- **Undo is in-session only** — `UndoState` widens to
  `{ kind: "clean"; entryIds; freed } | { kind: "relocate"; pairs }` and `UndoToast` branches
  its action and copy (~30 lines); `restoreCleanupEntry` does not apply to moved files. A
  persistent "Recently arranged" log is a follow-up.
- **Accepted-but-unexecuted cards are session-only** — `staged` is plain `useState` with no
  persistence, and acceptance is UI-side, so a reload returns them to the pending card list.
- Inspector hints and the Overview "N files look misplaced" headline chip are follow-ups.

## Placement (settled)

**Catalog is its own top-level switcher segment, key 8, labeled "Catalog", after Cleanup. It
is not a tab, intent, lens, or mode inside another view.** The floated Cleanup + Catalog
"Act" merge is rejected — deferred, not killed.

Why the merge loses:

- **It deletes a discriminant the shell already has and needs.** `CleanupTray`,
  `WorkspaceShell`'s ⌘Enter, and `CommandSpine`'s `setView` all need to tell remove from
  relocate. With separate views they branch on `view === "catalog"` for free; merged, they
  need a second nav dimension (`actIntent`) threaded through `workspaceStore`'s state, setter,
  value and dep array.
- **Nothing is actually shared behind the frame.** By this spec's own findings: reused cleanup
  code ≈ 0, a mandatory separate `stagedMoves`, a separate `RelocateReviewModal`, a
  discriminated `review` flag, no shared table, and a discovery kind cleanup's resolver
  rejects. A header toggle over two entirely separate stacks is a shared frame, not a shared
  skeleton.
- **It is equally cheap later.** The toggle is ~45 lines whether written now or after Catalog
  ships — but later it wraps a component that exists rather than one being designed. The
  body-component structure above preserves that option at zero cost.

Nav wiring that ships with Catalog: one `viewRegistry.ts` row (`FolderTree` is unused in the
switcher); `"catalog"` added to `StageView`; one `intent.ts` `STAGE_TRIGGERS` row
(`catalog, organize, tidy, sort, misplaced, arrange`) plus an `intent.test.ts` case —
without it, typing "organize" runs a filename search; a Catalog tile in `OverviewView`'s quick
actions, since a brand-new noun has no muscle memory; a `MiscOverlay` shortcut row; and the
README view table.

## Adjacent, not part of this feature

The views review found the real cause of "too many views" is legibility, not count:
`CommandSpine.tsx:113` renders **only the active segment's label**, so six of seven
destinations are bare glyphs — and `Sparkles` means Cleanup in the switcher while also being
the Cleanup empty-state icon and Overview's "Clean up" tile. Eight *words* is calmer than
seven unguessable glyphs. That fix (label every segment at wide widths, hairline dividers
banding orient / look / act, no band labels) is ~60 net lines, ships **independently and
before** Catalog, and is tracked separately so this feature is not sized as if it included an
IA overhaul. Two duplications found in passing and worth folding in there: the age-bucket
constants (`TimelineView` carries the comment "keep values identical" as a maintenance
contract) and a byte-identical stale-giants list in `TimelineView:218-224` and
`CleanupView:140-161`.
