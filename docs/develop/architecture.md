# Architecture

Bird's Eye is a native, offline disk cleanup app: a parallel scanner, a persistent index,
and an analysis layer that turns that index into "what's safe to delete, and why" — not a
plain folder walker. This page is the map a developer needs before touching the code.

## Layers

The system is five layers, from disk to pixels:

| Layer | Where | Responsibility |
|---|---|---|
| **Scanner engine** | `src/scanner/` | Parallel, cancellable, symlink-safe filesystem crawl that *streams* facts as events — it never waits for a full scan to publish progress. |
| **Index store** | `src/index/` | SQLite schema, batched writer, rollups, search, timeline/age aggregates, and staged-hash duplicate detection. |
| **Analysis** | `src/ontology/` | The reasoning that produces safety labels: heuristic populators, discoveries, saved views, and the cleanup engine (plans → safety predicate → recycle-bin executor → restore). Runs by default. |
| **Native boundary** | `src/native/`, `src-tauri/` | Serializable Rust DTOs and background-job APIs, wrapped by Tauri commands in the desktop shell. |
| **Frontend** | `workspace/` | React 19 + Tailwind 4 workspace — the typed Tauri bridge, the browser-mode mock backend, and the design-system primitives. |

## Data flow

1. The user starts or resumes a scan.
2. The scanner streams `Started`, `Progress`, `FileIndexed`, `FolderIndexed`, `Error`,
   `Finished`, and `Cancelled` events.
3. The index writer batches those events into SQLite transactions — every N events or M
   milliseconds — instead of one transaction per file.
4. Aggregators update folder / category / extension / session projections.
5. The UI receives throttled progress and query-ready snapshots.

## Rust core (`src/`)

```text
src/
  scanner/        parallel crawl — mod.rs, types.rs, worker.rs
  index/          SQLite — schema.rs, writer.rs, algorithms/ (xxh3)
  native/         DTOs + background jobs — api.rs, jobs.rs, phase_timer.rs
  ontology/       the analysis (see below)
  lib.rs          library crate (birds_eye)
  main.rs         birds-eye-scan CLI binary
```

### Scanner

Workers share a queue of directories: pop a directory, read its entries, enqueue child
directories, publish file/folder events. The scanner reports queue depth, active workers,
files/sec, bytes/sec, current path, and inaccessible entries. Pause and cancellation are
atomic controls shared by all workers. The writer runs separately from the crawlers so
disk I/O never blocks traversal.

### Index

SQLite with append-friendly scan sessions, file/folder facts, aggregate tables, and
invalidation metadata. The schema captures every timestamp (modified/accessed/created),
which is what lets the **By age** view exist without a re-scan. Duplicate detection
is staged — size grouping → partial hash → full hash — using xxHash (`index/algorithms/`)
so files with unique sizes are never hashed.

### Analysis (`ontology/`)

The reasoning that turns an index into safety verdicts:

```text
ontology/
  populators/     heuristics, metadata extractors, perceptual-hash near-dupes
  discoveries*    findings surfaced to the Findings, Clean up, and Organise views
  cleanup/        plans → predicate (safety) → executor (recycle bin) → restore
  catalog/        inference (zones, rules, learned homes) → plans → executor (mover)
  saved_views     the curated Files presets
  entities, relations, vocabulary, sensitivity, pinning, …
  enabled.rs      the per-index on/off switch
```

Everything here is **heuristic and on-device** — no ML, no network, no model ever reads a
file's contents. The `cleanup/predicate` is the safety gate in code: it decides what's held
back, and it is the thing a contributor must never route around.

**It runs by default.** `enabled.rs` is an opt-*out*, surfaced in Settings for people who
want a plain size scanner; it is not something a user has to discover. The analysis is the
whole product thesis, so an index that hasn't been told otherwise gets it.

The internal `Verdict` type has four states — `safe`, `review`, `protected`, `keep`. The UI
shows **three**: `protected` and `keep` both render as **Don't touch**, with the reason. The
distinction between "we won't let you" and "we think you want this" is ours, not the user's.
Merging the labels must never make a `protected` item stageable — `canStage` is driven by the
verdict, not by the label.

| Internal verdict | User-facing label |
|---|---|
| `safe` | **Safe to delete** |
| `review` | **Check first** |
| `protected`, `keep` | **Don't touch** |

## Native boundary

The boundary is serializable Rust DTOs wrapped by Tauri commands in `src-tauri/src/main.rs`.
Representative commands:

- `start_scan_job_for_root(root) -> { job_id, index_path }`
- `scan_job_events(job_id, offset) -> JobEvent[]` · `scan_job_status(job_id)` · `cancel_scan_job(job_id)`
- `query_index({ index_path, limit }) -> IndexOverview`
- `search_files({ index_path, query, limit }) -> FileSearchResult[]`
- `duplicate_group_files({ index_path, group_id, limit }) -> DuplicateFile[]`

The overview payload carries the `timeline` (monthly modified-time buckets) and
`age_buckets` used by the Overview and **By age** views.

## Frontend (`workspace/`)

React 19 + Vite + TypeScript + Tailwind 4.

```text
workspace/src/
  bridge/         the typed Tauri bridge (the real backend)
  dev/            browser-mode mock backend with realistic fixtures
  components/     views + ui/ design-system primitives
  state/          app store — active scan, selection, filters
  hooks/, lib/    shared logic
  index.css       the design tokens (colors, type, spacing)
```

Large datasets stay in the backend and are paged or aggregated before they reach React;
progress updates are throttled to animation-frame / 250 ms cadence. The **mock backend**
(`dev/`) implements the native client surface, so the entire workspace renders in a plain
browser with no Rust toolchain — the basis for UI iteration and CI screenshots.

## Incremental indexing

For each path the index stores size, modified time, parent folder, hashes, and
`indexed_at`. On rescan:

- Skip unchanged files when size and modified time match.
- Mark missing paths as deleted.
- Invalidate hashes when size or modified time changes.
- Recompute folder totals bottom-up, only for affected folders.
- Preserve scan-session history for **By age** comparisons.

## Safety & privacy invariants

These are architectural guarantees, not preferences — treat them as invariants when
changing code:

- **Fully offline.** No file paths, metadata, hashes, or contents ever leave the machine.
- **Recycle bin first.** Deletions go through `trash` to the OS Recycle Bin by default.
- **Review before mutation.** Cleanup plans require preview + confirmation; the safety
  predicate holds back protected paths.
- **Least privilege.** Tauri command allowlists are scoped in `src-tauri/capabilities/`.

See [Working safely](../guide/working-safely.md) for the user-facing view of the same model.
