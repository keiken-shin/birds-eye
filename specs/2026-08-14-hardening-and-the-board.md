# Hardening and the Board — spec

Source: the ChatGPT thread *"Branch · AI Architectural Review"* (second audit + a branched thread
reimagining the Board). Verified against `main` @ `e82e93e`, which already contains
`feat/positioning`.

An audit is a set of **claims**, not findings. Part 0 is the claim-by-claim check; the work items
below only exist for claims that survived.

**Revision 2** — cross-verified by a second reviewer reading the tree independently. Eight claims in
revision 1 were wrong and are corrected in place; the corrections are collected in Part 5 so the
diff is auditable. The most serious: **deleting BoardView silently disables two of the four cleanup
reasons** (B1). That inverts the Board section — it is no longer a deletion, it is a re-homing.

**The one idea in this document:** the audit's two biggest items are the same item. Cleanup executes
a *query* while the user believes they reviewed a *list* — and the Board redesign's whole premise is
"these eleven files **I** chose." You cannot build the second on the first. H2 is a prerequisite for
B5, not a parallel nicety.

---

## Part 0 — What the audit claimed, and what is actually there

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 4 | Crash between the filesystem move and the DB record | **True, narrower than stated.** The re-run path is already handled — an item still `planned` whose source is gone gets marked `skipped`, and `record_move` falls back to a note. The residual is exactly one thing: the **undo log entry** is lost. The window is inside `move_files`, between the `rename` and `reconcile_index_after_move` → `log_move`. | [executor.rs:60-114](src/ontology/catalog/executor.rs:60), [:147](src/ontology/catalog/executor.rs:147), [api.rs:387-402](src/native/api.rs:387) |
| 5 | `restore_move_with` can strand the DB | **True.** Move → `UPDATE relocation_log` → `UPDATE files`, with only `moved`/`restored` in the CHECK. If the move lands and the UPDATE fails, the row still reads `moved` and never converges. **The refusal it hits is the destination check, not the old-location one:** the file is back at `from_path`, so `fs::metadata(&entry.to_path)` fails first and returns *"it is no longer where it was moved to"*. | [relocation_log.rs:130-135](src/ontology/catalog/relocation_log.rs:130), [:164-180](src/ontology/catalog/relocation_log.rs:164), [schema.rs:680](src/index/schema.rs:680) |
| 6 | `move_files` is a powerful primitive callers could bypass review with | **True, and worse than stated.** Not a future risk — a registered Tauri command invoked straight from the renderer today. Exactly three callers: MoveDialog, UndoToast, `SystemMover`. | [main.rs:457](src-tauri/src/main.rs:457), [nativeClient.ts:320](workspace/src/bridge/nativeClient.ts:320) |
| 7 | Cross-volume copy can leave ambiguous state after power loss | **True.** `copy_then_remove` rolls back on a returned error; it cannot roll back a process that died. The partial file at `to` then blocks every retry via the `to.exists()` guard. | [api.rs:370](src/native/api.rs:370), [:416](src/native/api.rs:416) |
| 8 | Cleanup plans are query recipes, not selections | **True, verbatim.** `CleanupScope { reasons, max_size, path_prefix }`; `candidates_for_plan` re-runs the live predicate, and both the preview and the executor route through it — no third path. | [cleanup/plans.rs:13-25](src/ontology/cleanup/plans.rs:13), [:79](src/ontology/cleanup/plans.rs:79), [cleanup/executor.rs:69](src/ontology/cleanup/executor.rs:69) |
| 9 | Cleanup crash semantics are good | **True for the clean path.** `INSERT pending` → trash → `UPDATE log` → `UPDATE files`, pending row retained on bookkeeping failure. But the **restore** path has the same non-convergent stranding as #5, which the audit missed — see H7. | [cleanup/executor.rs:85-142](src/ontology/cleanup/executor.rs:85), [cleanup/restore.rs:41-56](src/ontology/cleanup/restore.rs:41) |
| 16 | Symlink safety unproven | **Half wrong.** The guard exists and is correct: `DirEntry::metadata()` does not traverse, and Rust's Windows `is_symlink()` is true for every name-surrogate reparse tag — which includes **directory junctions**. The recursive rescan probe carries the same guard, and those are the only production traversal sites. What is missing is a **test**. The genuinely uncovered case is **hard links**, counted once per name. | [worker.rs:310-326](src/scanner/worker.rs:310), [writer.rs:459](src/index/writer.rs:459) |
| 20 | Tauri commands need a mutation classification | **True in substance.** 47 commands in one flat list; `move_files` and `trash_files` sit undifferentiated beside `query_index`. Note the irony: `allow_preview_root` — three lines below `move_files` — carries a comment boasting that "the webview never gets to name an arbitrary path", which is exactly what `move_files` lets it do. | [main.rs:439-487](src-tauri/src/main.rs:439), [:252](src-tauri/src/main.rs:252) |
| 3 | Identity check is best-effort, not content identity | **True and already reasoned about in-tree.** `identity_unknown` handles the size-0 case. Only the *doc wording* needs fixing. | [relocation_log.rs:145](src/ontology/catalog/relocation_log.rs:145) |
| 12 | "fail open" is the wrong name for the analysis default | **True.** A presentation default, not a gate. Rename in prose only. | — |
| 15 | Unify Cleanup and Catalog behind `ActionCandidate` | **Rejected**, with numbers. See Part 3. |

**Claims the audit got right that need no work:** persistent relocation plans, refusal-based restore,
recycle-bin-first cleanup, injected actuators, backend-side paging, three UI labels over four
internal verdicts, no AI/no cloud.

---

## Part 1 — Hardening

### H1 — Close the `move_files` door (not a one-line deletion)

The README says: *"no path to disk mutation that skips the review gate"* ([README.md:166](README.md:166)).
That sentence is currently false. `move_files` accepts arbitrary `from`/`to` from the renderer,
`create_dir_all`s the parent, and moves.

The reviewed path already exists — `relocation_plan` re-verifies each move and reports `dropped`
([api.rs:1492](src/native/api.rs:1492)) — but routing MoveDialog through it is **not free**, and
revision 1 was wrong to call this a pure deletion. Three real pieces of work:

1. **File ids do not reach MoveDialog.** `relocation_plan` looks up `SELECT size, deleted_at FROM
   files WHERE id = ?1` and drops anything it cannot find ([api.rs:1504](src/native/api.rs:1504)),
   but every source feeding MoveDialog is path-only: `FileSearchResultDto`
   ([api.rs:103](src/native/api.rs:103)), `NativeDuplicateFile`
   ([nativeClient.ts:111](workspace/src/bridge/nativeClient.ts:111)) and the Inspector's
   `SelectedRef` ([types.ts:24](workspace/src/state/types.ts:24)). Either add `file_id` to those DTOs
   or add a path→id resolution step. **Adding the id to the DTOs is the smaller change** and pays for
   itself again in H2/B5, which need the same ids.
2. **UndoToast needs log-entry ids.** `restore_from_relocation_log` takes an `entry_id`
   ([api.rs:479](src/native/api.rs:479)), but the undo state carries `(from, to)` pairs and
   `RelocationResult` has no ids to give it ([executor.rs:50-58](src/ontology/catalog/executor.rs:50)).
   Add the entry ids to `RelocationResult`. Revision 1 claimed this was already wired; it is not.
3. **The capability that dies.** `ontology_relocation_log.file_id` is nullable specifically because
   *"a manual move can name a path the current scan never indexed"* ([schema.rs:669](src/index/schema.rs:669)).
   Post-H1 an unindexed path can no longer be moved. That is acceptable — the app only offers moves
   from indexed views — but it is a deliberate narrowing and belongs in the commit message.

Then remove `move_files` from `generate_handler!` and drop it to `pub(crate)`. `SystemMover` keeps
calling the Rust function directly; it is inside the gate.

*Do not* build `RawMover` / `ReviewedMoveExecutor`. Two traits with one implementation each is
ceremony; removing the door is smaller than posting a guard at it.

**What H1 does not fix.** `trash_files` has the same shape — arbitrary renderer-named paths, no index
verification, gated only by a frontend modal ([main.rs:243](src-tauri/src/main.rs:243),
[ReviewModal.tsx:143](workspace/src/components/ReviewModal.tsx:143)). It is a materially milder door
— the Recycle Bin is a 30-day undo, an arbitrary relocation is not — but the README sentence is still
a convention afterwards, with one fewer door. **Say that in the README rather than leaving the
absolute claim standing.**

**The classification (audit #20)** rides along: after H1 the user-file mutation surface is
`trash_files`, `execute_cleanup_plan`, `execute_relocation_plan`, `restore_from_cleanup_log`,
`restore_from_relocation_log`. Group them under one comment in `generate_handler!` and define
"mutating" explicitly as **user-file** mutation — otherwise `delete_index`, which really does delete
files from disk, makes the comment the next thing that is subtly wrong.

### H2 — A cleanup plan carries the file ids it was reviewed with

Today: user reviews 17 files, presses go, and the executor deletes whatever satisfies the scope *at
that moment*. A rescan in between silently changes the set. The scope was never wrong as a safety
device — recomputing means stale facts never become stale deletions — it is wrong as a **record of
consent**.

Both properties are wanted, and both fit in one field:

```rust
pub struct CleanupScope {
    pub reasons: Vec<String>,
    pub max_size: Option<i64>,
    pub path_prefix: Option<String>,
    /// The exact rows the user reviewed. None = a legacy plan, scope-only.
    #[serde(default)]
    pub file_ids: Option<Vec<i64>>,
}
```

`candidates_for_plan` intersects the live predicate result with `file_ids` when present. Selection
integrity from the snapshot, safety integrity from the live re-run, and the intersection can only
ever *shrink* the set. Verified: `scope` is a plain TEXT column round-tripped through `serde_json`
([schema.rs:280](src/index/schema.rs:280)), so `#[serde(default)]` genuinely needs **no migration** —
old plans deserialize to `None` and behave exactly as they do now. `filter_candidates` is already the
right shape for one more filter ([predicate.rs:24](src/ontology/cleanup/predicate.rs:24)).

**But the ids have to get there.** `StagedItem` carries `path`/`kind`, no `fileId`
([types.ts:32-40](workspace/src/state/types.ts:32)), and `CleanupPlanRequest` has no `file_ids` field.
(`StagedMove` *does* carry `fileId` — relocations were built with ids from the start.) Same root gap
as H1's item 1, and the same fix serves both.

**Tests:** a file that stopped qualifying is not deleted; a file that newly qualifies is not deleted
either.

### H3 + H4 + H7 — one migration, three convergence fixes

These ship together because they are one table rebuild.

**The migration is not free, and revision 1 did not price it.** `restore_status` is constrained by
`CHECK (restore_status IN ('moved','restored'))` ([schema.rs:680](src/index/schema.rs:680)) and
SQLite cannot alter a CHECK. The repo has already done exactly this dance once —
**MIGRATION_008 rebuilt `ontology_cleanup_log` to admit a transient `pending`**, with a comment
saying why ([schema.rs:419-448](src/index/schema.rs:419)). That is the template *and* the precedent:
the pattern H3/H4 want is one this codebase already proved.

`MIGRATION_014` rebuilds `ontology_relocation_log`, recreates `idx_relocation_log_moved_at`, bumps
`CURRENT_SCHEMA_VERSION` 13→14 and the hardcoded schema test ([schema.rs:710](src/index/schema.rs:710)).

**H3 — make restore converge.** Write `restore_pending` *before* the move:

```
UPDATE ... SET restore_status = 'restore_pending'
  → mover.move_one(to → from)
  → UPDATE ... SET restore_status = 'restored'
```

The convergence branch must be inserted **before** the `fs::metadata(&entry.to_path)` check at
[relocation_log.rs:130](src/ontology/catalog/relocation_log.rs:130) — not at the `from_path.exists()`
guard, as revision 1 said. After a stranded restore the file is already back at `from_path`, so the
destination check fails first and returns *"no longer where it was moved to"*, which is both wrong
and unrecoverable. For a `restore_pending` row: if `to_path` is gone and `from_path` holds a file
matching the logged identity, the restore already happened — close the row as `restored`.

**H4 — log the move before the bytes move.** Insert `(from, to, file_id)` as `move_pending` before
`mover.move_one`, then fill size/mtime and flip to `moved`. Size is `NOT NULL` — write `0` with a
`NULL` `modified_at`, which the existing `identity_unknown` branch already treats as unknown rather
than empty ([relocation_log.rs:145](src/ontology/catalog/relocation_log.rs:145)).

**H4 has a placement problem revision 1 missed.** The log write lives inside `move_files`, via
`reconcile_index_after_move` → `log_move` ([api.rs:309-333](src/native/api.rs:309)) — *not* at the
mover seam. Pre-inserting `move_pending` in the executor while `SystemMover { index_path: Some(_) }`
still routes through `move_files` writes **two rows per move**, and `log_move`'s reversed-entry check
only closes opposite-direction rows, so it will not collapse them
([relocation_log.rs:54-70](src/ontology/catalog/relocation_log.rs:54)). Pick one owner of the log
write. **Move logging into the executor and make `SystemMover` always pass `index_path: None`** — the
index reconciliation stays in `move_files`, the log write does not. After H1 the executor is the only
caller that logs anyway.

**H7 — the cleanup restore strands the same way, and nobody noticed.** `restore_with` does
bin-restore → `UPDATE ontology_cleanup_log`. If the UPDATE fails the row stays `in_recycle_bin`, the
Library keeps offering it, and every retry fails with *"no recycle-bin item matches original path"*
([cleanup/restore.rs:41-56](src/ontology/cleanup/restore.rs:41), [:103-123](src/ontology/cleanup/restore.rs:103)).
Identical shape to H3, same fix, and `ontology_cleanup_log`'s CHECK already has four values so
adding `restore_pending` there is a second rebuild in the same migration.

**Four sites silently mishandle a new status value** — all four are part of this work, not follow-up:

| Site | What breaks |
|---|---|
| [LibraryOverlay.tsx:107](workspace/src/components/LibraryOverlay.tsx:107) | filters `restore_status === "moved"`, so a `move_pending` row is **invisible** — which directly contradicts H4's whole point |
| [relocation_log.rs:124](src/ontology/catalog/relocation_log.rs:124) | refuses any non-`moved` row with *"Bird's Eye already put this file back."* — a false sentence for a pending row |
| [relocation_log.rs:57](src/ontology/catalog/relocation_log.rs:57) | reversed-entry close matches `'moved'` only |
| [mockBackend.ts:641](workspace/src/dev/mockBackend.ts:641) | types the log as `"moved" \| "restored"` |

### H5 — Cross-volume copy writes to a temp name

Power loss mid-`fs::copy` leaves a truncated file at `to`, and the `to.exists()` guard at
[api.rs:370](src/native/api.rs:370) then refuses the retry forever — a permanent failure caused by
the safety check.

Copy to `to` + `.beparked`, then `rename` into place. Rename is atomic within a volume, so `to`
either does not exist or is complete. Roughly three lines inside `copy_then_remove`.

**Residual, stated rather than hidden:** a crash *after* the rename and *before* `remove_file(from)`
leaves a complete file at both ends, and `to.exists()` still refuses the retry. That is duplication,
not truncation or loss — materially milder, and closing it is what a real move journal is for.

```rust
// ponytail: temp-then-rename covers crash-during-copy. Crash-after-rename
// leaves a duplicate, not a truncation. A move journal only earns its keep if
// multi-GB moves become routine.
```

### H6 — Prove the traversal guard, and say what it does not cover

The guard is correct. It has no test, and "symlink-safe" in the docs is doing more work than the code
promises ([README.md:147](README.md:147), [architecture.md:13](docs/develop/architecture.md:13)).

**Test (Windows, CI-safe):** build `root/real/data/huge.bin` and a **junction** `root/link → real`
via `cmd /c mklink /J`. Junctions need no privilege; `symlink_dir` needs Developer Mode and would
skip on a default runner. Assert `huge.bin` is indexed exactly once and nothing under `link/`
appears. Mirror it for `writer.rs`.

**Hard links are the real gap.** Not reparse points, so both names are indexed and the bytes counted
twice — drive totals overstate, and content-hash dedup reports a "duplicate" that frees nothing when
deleted. Not fixed here; fixing it means reading `FILE_ID_INFO`/`nNumberOfLinks`, which is real work.
Fixed in the **docs**: replace "symlink-safe traversal" with *"symbolic links and junctions are never
followed, so nothing is counted twice through one. Hard links are counted once per name."*

---

## Part 2 — The Board

The branched thread's proposal: the Board should stop being a relationship canvas and become *"a
workspace for decisions"* — collect → group → destination → review → execute. The direction is right.
Three facts in this codebase change the design, and one of them makes the Board section a **re-homing
rather than a deletion**.

### B0 — What `Pin` already means, and what it doesn't

`pin_file` writes to `ontology_pinned_files`, which lands in `hard_excluded` of
`v_cleanup_candidates` and merges into the **Don't touch** label
([pinning.rs:7](src/ontology/pinning.rs:7), [schema.rs:585](src/index/schema.rs:585),
[:608](src/index/schema.rs:608)). So the thread's *"make Pin mean bring-this-into-my-workspace"*
would mean *"mark it undeletable because you were unsure"*. **Pin does not change meaning.**

Two honest qualifications revision 1 overstated:

- It is **reversible** — `unpin_file` is a registered command. "Permanent exclusion" is the UX
  framing; the mechanism is a row you can delete.
- **No UI can pin.** `pinFile`/`unpinFile` exist in `nativeClient.ts` and have **zero callers**. The
  only pin a user can perform today is `pinToBoard` — *the Board's own pin*, which this section
  removes. ReviewModal's *"…or you pinned it"* copy ([ReviewModal.tsx:344](workspace/src/components/ReviewModal.tsx:344))
  describes a state no user can currently reach.

So the collision B0 guards against is **latent, not live** — and the live word-collision runs the
other way: the button that says "Pin to Findings" today is the *staging* pin, not the safety one.
Resolving that is part of B2's label work, and the conclusion stands: the staging verb is **stage**,
which is already the word in the code and on screen
([CleanupTray.tsx:52](workspace/src/components/CleanupTray.tsx:52),
[workspaceStore.tsx:79](workspace/src/state/workspaceStore.tsx:79)).

### B1 — Re-home finding review FIRST. This gates everything else in Part 2.

**BoardView is the only surface that graduates findings into facts, and two of the four cleanup
reasons depend on those facts.**

The chain, verified end to end:

1. `heuristics.rs` only ever **proposes** — it inserts `derivedFrom-pattern` and `backupOf-pair`
   discoveries and asserts no relations ([heuristics.rs:104](src/ontology/populators/heuristics.rs:104),
   [:376](src/ontology/populators/heuristics.rs:376)).
2. `confirm_discovery` is what **graduates** a discovery into `assert_user_role` +
   `assert_user_relation` ([discoveries_resolve.rs:164-182](src/ontology/discoveries_resolve.rs:164)).
3. `v_cleanup_candidates` gates `safe-derivative` on an existing `derivedFrom` relation and
   `redundant-backup` on a `backupOf` relation ([schema.rs:616-637](src/index/schema.rs:616)).
4. `confirmDiscovery` / `confirmDiscoveryPattern` / `rejectDiscoveryPattern` / `listDiscoveries` have
   **exactly one caller in the entire frontend: `BoardView.tsx`**
   ([:162](workspace/src/components/views/BoardView.tsx:162), [:1026](workspace/src/components/views/BoardView.tsx:1026),
   [:1185](workspace/src/components/views/BoardView.tsx:1185), [:1495](workspace/src/components/views/BoardView.tsx:1495)).
   CatalogView only *rejects* relocation cards.

Delete BoardView as revision 1 proposed and `safe-derivative` and `redundant-backup` go dark
permanently — no user can ever confirm one again. Revision 1 waved this away with *"relationships
belong to the Inspector and the discoveries surface"*: the Inspector is read-only provenance, and
there is no other discoveries surface. **That was the single worst error in the document**, because
it would have quietly broken the exact feature the rest of the spec exists to make trustworthy.

**So B1 ships before any deletion:** a finding-review surface — a list, not a canvas. Per kind, per
pair: *what Bird's Eye thinks, why, and Confirm / Not this one*, plus the existing confirm-all and
reject-all per pattern. This is the genuinely load-bearing 10% of a 1,930-line view, and it does not
need a canvas, positions, hulls, edges or a minimap to do its job.

Where it lives is a decision (see Open decisions): its own view, or a section inside Overview next to
the other things Bird's Eye found.

### B2 — What ships

`board` keeps its internal `StageView` key. The switcher label changes, superseding the positioning
spec's A2 row for this one view (`specs/2026-07-31-positioning-implementation.md`); the other seven
labels stand:

| Now | Ship |
|---|---|
| Findings (`board`) | **Staged** |

**Watch the copy gate here.** *discoveries* and *graduation* are both on the kill list, so the
re-homed review surface in B1 cannot be called either of those in front of a user. "Findings" is the
approved word and is now free, which is convenient: B1 takes the name B2 gives up.

The view is the tray's contents at full size, grouped, with one question at the top: *what do you
want to do with these?* The 60px tray stays as the persistent footer.

The Inspector's **"Pin to Findings"** button becomes **"Stage"** ([Inspector.tsx:333](workspace/src/components/Inspector.tsx:333)),
which also removes the live collision named in B0.

Guardrail from the thread, adopted verbatim: **no columns.** No To do / Doing / Done. The moment it
grows a status per card it is project-management software, and every one of these files still has to
pass a review gate before anything happens to it.

### B3 — One table, and it must hold folders

Revision 1 keyed this on `file_id REFERENCES files(id)`. That is wrong: **the tray is
folder-capable today and folders are how the treemap feeds it.** `StagedItem.kind` is
`"folder" | "file"` ([types.ts:39](workspace/src/state/types.ts:39)), ReviewModal's entire flow is
folder-scoped path-prefix plans ([ReviewModal.tsx:64](workspace/src/components/ReviewModal.tsx:64)),
and `PinnedCard` is documented as *"A folder collected onto the Board"*
([types.ts:66](workspace/src/state/types.ts:66)). A files-only table silently drops half of how the
app is used.

```sql
CREATE TABLE IF NOT EXISTS ontology_staged_items (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('file','folder')),
  path       TEXT NOT NULL UNIQUE,   -- idempotent staging, for both kinds
  file_id    INTEGER,                -- set for files; NULL for folders
  group_name TEXT,                   -- NULL = ungrouped
  note       TEXT,
  added_at   INTEGER NOT NULL
);
```

`path` carries the UNIQUE constraint because it is the only identifier both kinds have — the same
reason `ontology_relocation_log.file_id` is nullable. `file_id` is populated for files so H2's
intersection and B5's plan-building get their ids without a second lookup.

Groups are a **string column**, not an entity. `Archive`, `Game Projects`, `Investigate` are names a
person typed, and a group with no members is not worth persisting. A group **becomes** a draft
relocation plan only when a destination is chosen, through `relocation_plan`, which already
re-verifies and already reports `dropped`.

### B4 — The loop

```
Staged (durable)  →  group  →  choose destination  →  relocation_plan  →  RelocateReviewModal  →  execute
                                     ↘  delete      →  cleanup_plan (H2)  →  ReviewModal        →  execute
```

Every box after "choose" already exists and is tested. This is wiring, not architecture — with the
id-threading from H1/H2 as its one real prerequisite.

### B5 — Delete-from-Board depends on H2

The Board's promise is *"these eleven, because I picked them."* Routed through today's
`cleanup_plan`, that becomes a scope and the executor deletes whatever currently matches. Handing the
user a hand-picked list and then acting on a query is the exact mismatch the audit named, made
maximally visible because the user chose the files one at a time.

**H2 lands before B5 lands.** Folder staging keeps using `path_prefix` (that is what a folder scope
*means*); file staging passes `file_ids`. The live predicate still gets the last word either way.

### B6 — What gets deleted, and what must not be

**Deleted:** the canvas half of [BoardView.tsx](workspace/src/components/views/BoardView.tsx) — drag,
positions, connections, hulls, minimap, `SourceCard`, `DupCard`, `PinCard`; `be.board2.pos:`;
[undo.ts](workspace/src/lib/undo.ts) and its test, once H1 lands.

**Kept and re-homed:** everything in B1.

**User-authored text — not silently dropped.** Two keys, not one:

- `be.board2.notes:` — free notes. Any note carrying a path becomes that item's `note`; the rest
  render once as unattached notes to keep or clear.
- `be.board2.edits:` — revision 1 called this "positions" and deleted it. It is **not**: `BoardEdits`
  holds user-typed card renames (`overrides[id].label`) and user-drawn edges with typed labels
  ([BoardView.tsx:104-118](workspace/src/components/views/BoardView.tsx:104)). Positions are
  `be.board2.pos`. Renames carry over onto staged items; user-drawn edges have nowhere to go and are
  surfaced once before the key is dropped.

**Collateral that must move in the same commit** — none of it is caught by `check-copy.mjs`, which is
a kill-list gate and knows nothing about stale view references:

`pinned` / `pinToBoard` / `unpinCard` / `isPinned` in the store
([workspaceStore.tsx:55-57](workspace/src/state/workspaceStore.tsx:55)); `boardBadge`
([CommandSpine.tsx:116](workspace/src/components/CommandSpine.tsx:116)); and user-facing copy naming
"Findings" in [EnableIntelligence.tsx:53](workspace/src/components/EnableIntelligence.tsx:53),
[ScanOverlay.tsx:367](workspace/src/components/ScanOverlay.tsx:367),
[FilesView.tsx:369](workspace/src/components/views/FilesView.tsx:369),
[MiscOverlay.tsx:25](workspace/src/components/MiscOverlay.tsx:25).

**Net: roughly −1,500 lines of frontend, +1 table, +1 view, +1 re-homed review surface.** Revision 1
claimed −1,900 by counting the part that cannot be deleted.

---

## Part 3 — What this spec deliberately does not do

**The `ActionCandidate` unification (audit #15/#22).** One pipeline —
`Finding → ActionCandidate → ReviewGate → Actuator` — with `CleanupAction`, `MoveAction`,
`ArchiveAction`, `CompressAction`, `DeduplicateAction`. Three of those five do not exist: Archive and
Compress appear only as vocabulary strings, and there is no dedup *actuator*. Building it means an
interface for two real implementations and three speculative ones.

Now with numbers. Non-test parallel code is ~560 lines (cleanup `plans`/`executor`/`restore`) against
~515 (catalog `plans`/`executor`/`relocation_log`). The genuinely congruent skeleton — plan CRUD,
executed-flip, per-file failure isolation, log listing, `deleted_at = NULL` relink — is **~120–150
lines total**. Unification saves ~10% of the module code and couples two different risk profiles to
do it.

And the semantic cores differ exactly where it matters: predicate re-run vs per-item disk/index
re-verify; log-after vs log-before, each with a documented reason
([relocation_log.rs:38-42](src/ontology/catalog/relocation_log.rs:38) vs
[cleanup/executor.rs:82-84](src/ontology/cleanup/executor.rs:82)); bin-restore vs identity-checked
move-back. A shared gate would be a switch on kind wearing a trait.

What is actually shared is *one property*, and H2 delivers it: **a plan records what the user
consented to, and re-verifies before it acts.** That is the convergence worth having, and it costs
one field. Revisit if a third real actuator appears.

```rust
// ponytail: cleanup and relocation keep separate executors. ~130 lines of
// congruent skeleton is not worth coupling two risk profiles. Unify only when a
// third real actuator ships — Archive/Compress are vocabulary, not code.
```

**Also declined, with reasons:**

| Proposal | Why not now |
|---|---|
| Content hash for restore identity | The metadata check already refuses on any mismatch; the residual is an edit preserving both size and mtime. Costs a full read of every moved file. Fix the **wording** — "best-effort identity check" — not the code. |
| Full crash-injection harness (`FaultPoint::*`) | H3/H4/H7 close all three windows that lose something. Take the cheap half: one test per new state asserting a row left there resolves on retry. |
| "Push harder toward declarative rules" | Agreed as a **contributing rule**, not a refactor. One line in `contributing.md`: new classification behaviour is a row in `rules`; a new Rust module needs a reason in the PR. |
| Shared log-listing/status helpers across the two executors | The one middle ground that survives Part 3's own logic — and still optional. Not scheduled. |
| Renaming Board → Workspace/Desk/Collection | "Staged" is already the word in the code and on screen. |

---

## Part 4 — Verification

Same loop as the positioning spec, which stays in force.

1. `cargo test` · `cargo check --manifest-path src-tauri/Cargo.toml`
2. `npx tsc --noEmit` · `npx vitest run` · `npm run build` in `workspace/`
3. `node scripts/check-copy.mjs` — the kill-list gate, which scans Rust too
4. Read gate: every new string passes *"would you say it out loud to a friend?"*
5. Driven in the browser at 1280px and 980px. Not "the tests pass" — the positioning branch already
   recorded what that measures: `recently_moved` was implemented, registered and tested while
   nothing called it.

**Every backend change needs its `mockBackend.ts` twin.** `move_files`, `relocation_plan`,
`cleanup_plan` and `recently_moved` all have mock implementations
([mockBackend.ts:1064](workspace/src/dev/mockBackend.ts:1064) onward), and step 5 runs against the
mock. H2's intersection, H3/H4/H7's statuses and B3's staged store each need mirroring or the browser
pass is verifying the wrong program.

| Item | What proves it |
|---|---|
| H1 | `move_files` absent from `generate_handler!`; no `invoke("move_files")` in `workspace/src`; a move from Files still works end to end and appears in Recently moved; undo works after an app restart |
| H2 | A file that stopped qualifying is not deleted; a file that newly qualifies is not deleted either |
| H3 | A restore whose bookkeeping fails, retried, converges instead of refusing |
| H4 | A `move_pending` row is **visible** in Recently moved and its Put back succeeds; exactly one log row per move |
| H7 | Same as H3, for the cleanup log |
| H5 | A failed copy leaves no file at `to`; the retry succeeds |
| H6 | Junction test passes on a non-elevated runner; docs no longer say "symlink-safe" unqualified |
| B1 | Confirm a `derivedFrom-pattern` from the new surface; the file appears as `safe-derivative` in cleanup candidates. **Run before and after the BoardView deletion — the counts must match.** |
| B2–B6 | Stage a file and a folder from three views, close the app, reopen — still there, still grouped. Group → destination → review → execute → Put back, in the running app |

---

## Decisions and findings, as they land

Branch: `feat/hardening` off `main` @ `e82e93e`.

**H2's backend shipped.** `CleanupScope` carries `file_ids`, `filter_candidates` intersects, and
`candidates_for_plan` passes it through. 299 Rust tests pass, 2 ignored. No migration, confirmed by a
test that inserts a plan row whose JSON has no `file_ids` key and asserts it reads as `None` and
behaves scope-only — the claim is pinned rather than argued.

- *The mutation check caught a test that proved nothing.* `a_reviewed_file_that_stopped_qualifying`
  passed with the intersection deleted, because pinning removes a row from `v_cleanup_candidates`
  outright — so it was pinning behaviour that already worked, while reading like it covered the new
  filter. The fixture now also holds a live candidate that was never picked, so the test fails in
  both directions: selection-too-wide and predicate-ignored. Three of the four new tests now fail
  under mutation; the fourth asserts the legacy `None` path, where the filter is a no-op by design.

**Everything in Parts 1 and 2 shipped.** 308 lib tests plus 8 suites green, `tsc` clean, 53 frontend
tests, `npm run build` clean, copy gate clean over 144 files. Net **−979 lines** (1,300 in, 2,279
out). Order taken: ids → H2 → H1+H3/H4/H7 → B1 → B2–B6 → H5 → H6.

*Decisions taken without asking, and why.*

- **Finding review lives in Clean up, not Overview.** Revision 2 leaned Overview. Wrong on reflection:
  Overview is the landing the positioning work fought to keep down to one number and one sentence,
  and a review queue there dilutes exactly that. Clean up is where the *consequence* lands — say yes
  to a finding and the space appears in the list directly below it. Same screen, visible cause and
  effect, no new view.
- **The switcher rename freed the right word.** With the board view relabelled **Staged**, "Findings"
  is available again — and it is the approved term for precisely what B1 re-homes.

*What the browser pass proved that the tests could not.* H2: staging two files and opening the gate
shows exactly those two, resolved by id — before the change those paths produced prefix plans
matching nothing. H1: Move-to-folder now goes through a plan, both files land in the durable log with
**Put back**, one row each, and the put-back removes the row. B1: confirming a finding drops the
queue 6 → 5. B3: two items grouped as *Archive*, full page reload, still there, still grouped.

*Two mutation checks changed the work.*

- A cleanup test passed with the intersection deleted — pinning removes a row from
  `v_cleanup_candidates` outright, so it was pinning behaviour that already worked while reading like
  it covered the new filter. The fixture now also holds a live candidate that was never picked, so it
  fails in both directions.
- **The junction test does not fail when the `is_symlink()` guard is deleted**, and that is worth
  recording rather than hiding: Rust's Windows `FileType::is_dir()` is itself
  `!is_symlink() && is_directory()`, so a name surrogate already falls through both branches. The
  guard is the belt, `is_dir()` is the braces. The test *does* fail on the regression that could
  realistically happen — swapping the non-traversing `entry.metadata()` for `fs::metadata()`, which
  follows the link — catching the walked junction and the double-index together. Verified by running
  that mutation, not assumed.

*One item deliberately left as documentation.* Hard links are still counted once per name. The fix
means reading `FILE_ID_INFO`/`nNumberOfLinks`, which is real work; the README and architecture doc
now say what is true instead of "symlink-safe".

### The original blocker, for the record

**H2's frontend half was blocked, and the block was H1's item 1.** Confirmed by reading every one of
the seven `toggleStaged` call sites: **not one of them has a file id in scope.** `RecItem`
([recommendations.ts:14](workspace/src/lib/recommendations.ts:14)) is a view model built from folder
and stale-file recommendations; `NativeDuplicateFile`
([nativeClient.ts:111](workspace/src/bridge/nativeClient.ts:111)) and the file-search DTO carry paths
only. So `ReviewModal` has nothing to put in `file_ids` yet and still builds one path-prefix plan per
staged path ([ReviewModal.tsx:64](workspace/src/components/ReviewModal.tsx:64)).

Wiring `fileId` through `StagedItem` first would have added a field every call site sets to `null` —
the "registered, tested, and called by nothing" shape this project has already been bitten by once.
So the DTO id plumbing went first, and paid for H1 at the same time.

### Open decisions, as resolved

| | Resolution |
|---|---|
| Where finding review lives | **Clean up**, above the list — see above |
| Does staging survive a restart | **Yes** — `ontology_staged_items`, proven by reload |
| Switcher label | **Staged** — already the word in the code and the tray |
| Order | ids → H2 → H1+H3/H4/H7 → B1 → B2–B6 → H5 → H6 |

---

## Part 6 — What the branch review found, and what it cost

The finished branch went back to the same independent reviewer, told to find what was wrong. It did.
The gates were green through every one of these — which is the point of running a reviewer over the
work rather than over the test output.

| | Found | Fix |
|---|---|---|
| **R1** | **A confirmed clean erased the entire desk.** `ReviewModal` still called `clearStaged()` on success, and `clearStaged` was now wired to `DELETE FROM ontology_staged_items` — every row. Park twelve things in a group, clean one unrelated file, and the twelve were gone with their group. The *files* were gated; a person's *arrangement* was not. The durable-staging feature deleted its own contents as a side effect of its sibling. | The review is now scopeable: `openReview(paths?)`, and a confirmed clean takes off exactly what it reviewed. Proven live — 5 staged, 1 selected, cleaned, **4 left**, and still 4 after a reload. |
| **R6** | *Review & delete* sat in the selection toolbar and silently reviewed the whole desk. | Scoped to the selection, and the button says which: *Review & delete 1* vs *…all*. |
| **R5** | Two escaped-backslash regressions I introduced through a shell heredoc: `\setup-0.exe` lost its escape, and `` `\${m.name}` `` suppressed interpolation so every mock relocation wrote a literal `${m.name}` into the log. `tsc` cannot see either. | Both restored. The browser pass had been verifying a subtly different program. |
| **R2** | The carryover destroyed hand-drawn **edge labels** without ever showing them — the exact thing the module exists to prevent — and claimed renames "carry over onto staged items" when they are shown once and dropped. | Edge labels are read and shown. The doc now says what it does: shown, not migrated, because there are no cards to rename and no edges to redraw. |
| **R3** | The reworded README invariant was sharper and still false: `trash_files` *is* a raw delete-these-paths command the webview reaches, with neither a plan nor a restore log. | Rewritten to name it as the exception, with its real gate (the review UI) and its real undo (the Recycle Bin). |
| **R4** | The "user-file mutation" comment in `main.rs` sat above ~35 commands, most of them reads. | Scoped to the five it means, with an explicit end marker. |
| **U1** | Interrupted rows showed a hardcoded `MOVED` tag. | They read **INTERRUPTED** — the one row where the state is genuinely uncertain should not claim otherwise. |
| **U2** | Two concurrent restores could interleave so the loser's rollback resurrected a dead Put back. | Both rollbacks are now compare-and-set on `restore_pending`. One line each. |
| **U3** | `log_move_pending(...)?` aborted a whole plan mid-flight on a transient DB error, losing the entry ids for moves that had already happened — while its two neighbours were deliberately best-effort. | Best-effort, like them. |
| **U4/U5/U6** | Dead `note` column; the mock's `file_ids` branch ignored `reasons`, making the held-back path unreachable in the browser; mojibake, an orphaned type, unused imports. | All fixed. |
| **D2** | `entry_ids` were in hand and MoveDialog dropped them, so a move offered no toast undo. | Wired — one line. |

**And one the reviewer did not catch.** Chasing R6 turned up a stray **NUL byte** inside the
`UNGROUPED` sentinel in `StagedView.tsx` — which is why `grep` had been reporting that file as
binary. The fix removes the sentinel rather than repairing it: a `Map` takes `null` as a key, so
there is no magic string to collide with a group someone actually named.

**What the reviewer confirmed as correct**, having tried to break it: the single-owner move log (one
row per move, nothing else writes one), all twelve cells of the `restore_move_with` state walk, the
H2 intersection and its one choke point, `abandon_move`'s interaction with H5's temp-name copy, both
migrations as table rebuilds, the staging upsert, and command/mock parity.

---

## Part 5 — What revision 1 got wrong

Kept so the corrections are auditable rather than quietly absorbed.

| # | Revision 1 said | Actually |
|---|---|---|
| 1 | Deleting BoardView loses nothing; relationships live in the Inspector | It is the **only** surface that graduates discoveries into the relations `safe-derivative` and `redundant-backup` require. B1 now gates the whole section. |
| 2 | H1 is "a deletion, everything needed already exists" | `relocation_plan` needs `file_id`s that MoveDialog's DTOs do not carry, and `restore_from_relocation_log` needs entry ids `RelocationResult` does not return. Real plumbing. |
| 3 | UndoToast rewiring "is now wired" | It is not. Conflated with the positioning branch's *Recently moved* work. |
| 4 | H3's retry trips the `from_path.exists()` guard | It trips the `to_path` metadata check first. The convergence branch goes earlier. |
| 5 | Only H2's migration cost was priced | H3/H4/H7 need a table-rebuild migration (SQLite cannot alter a CHECK) plus four sites that mishandle a new status. |
| 6 | The staged table is keyed on `file_id` | The tray stages **folders** too. Files-only would delete the treemap path. |
| 7 | `be.board2.edits` is positions, delete it | It holds user-typed renames and edge labels. Positions are `be.board2.pos`. |
| 8 | 48 Tauri commands; H1 makes the invariant compiler-enforced | 47. And `trash_files` keeps the same shape, so it stays a convention with one fewer door. |

---

## Open decisions

1. **Where finding review lives after B1.** Its own view (keeps the eight-slot switcher full), or a
   section inside Overview. I lean Overview — it is *"what Bird's Eye found"*, which is what Overview
   already answers, and it keeps the switcher at eight with Staged taking slot 3.
2. ~~**Does staging survive a restart?**~~ **Answered: yes.** B3's table ships; staging is durable.
3. **"Staged" as the switcher label.** Already the word in the code and on screen, and the audience
   is developers and IT. Alternatives from the thread: Workspace, Shelf, Desk.
4. **Order — revised.** `H1 → H2 → H3/H4/H7 (one migration) → B1 → B2–B6 → H5 → H6`. Revision 1 put
   the crash work last as "least likely to affect anyone". That was wrong once B5 exists: the Board
   deliberately drives more traffic through the delete and move pipelines, so the stranding bugs get
   fixed *before* the thing that exercises them, not after.
