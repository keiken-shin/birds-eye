# Birds Eye Architecture

Birds Eye is a native, offline storage intelligence platform. The product should feel like a fast scanner, a media-aware catalog, and an analytical command center rather than a plain folder walker.

## 1. Full Architecture Plan

The app is split into five layers:

- Native shell: Tauri desktop wrapper for filesystem access, OS integration, packaging, updater, and secure command boundaries.
- Scanner engine: Rust worker pool that streams filesystem facts as events and never waits for a full scan to finish before publishing progress.
- Index store: SQLite database with append-friendly scan sessions, file/folder facts, aggregate tables, and invalidation metadata.
- Intelligence services: duplicate detection, media classification, cleanup recommendations, search indexing, and timeline snapshots.
- Frontend: React + Vite + TypeScript dashboard using virtualized lists, canvas/WebGL treemap rendering, and event-driven scan state.

Data flow:

1. User starts or resumes a scan.
2. Scanner streams `FileIndexed`, `FolderIndexed`, `Progress`, and `Error` events.
3. Index writer batches events into SQLite transactions.
4. Aggregators update folder/category/extension/session projections.
5. UI receives throttled progress and query-ready snapshots.

## 2. Backend Module Structure

Current implementation:

```text
src/
  index/
    mod.rs
    schema.rs
    writer.rs
  native/
    api.rs
    jobs.rs
  scanner/
    mod.rs
    types.rs
    worker.rs
  lib.rs
  main.rs
src-tauri/
  src/main.rs
frontend/
  src/
    main.tsx
    nativeClient.ts
    scanWorker.ts
    TreemapCanvas.tsx
```

Future native backend modules can be split further as the app grows:

```text
src-tauri/src/
  commands/          Tauri command handlers beyond the current main.rs
  media/             optional metadata extraction
  search/            filters, regex, FTS integration
  cleanup/           rules, simulations, recycle-bin moves
  events/            pushed frontend event contract
```

## 3. Database Schema

Initial SQLite schema:

```sql
CREATE TABLE scan_sessions (
  id INTEGER PRIMARY KEY,
  root_path TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL,
  files_scanned INTEGER NOT NULL DEFAULT 0,
  folders_scanned INTEGER NOT NULL DEFAULT 0,
  bytes_scanned INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE folders (
  id INTEGER PRIMARY KEY,
  parent_id INTEGER REFERENCES folders(id),
  path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  depth INTEGER NOT NULL,
  direct_bytes INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  direct_files INTEGER NOT NULL DEFAULT 0,
  total_files INTEGER NOT NULL DEFAULT 0,
  modified_at INTEGER,
  indexed_at INTEGER NOT NULL
);

CREATE TABLE files (
  id INTEGER PRIMARY KEY,
  folder_id INTEGER NOT NULL REFERENCES folders(id),
  path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  extension TEXT,
  size INTEGER NOT NULL,
  modified_at INTEGER,
  accessed_at INTEGER,
  created_at INTEGER,
  partial_hash TEXT,
  full_hash TEXT,
  hash_algorithm TEXT,
  media_kind TEXT,
  indexed_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE duplicate_groups (
  id INTEGER PRIMARY KEY,
  size INTEGER NOT NULL,
  partial_hash TEXT,
  full_hash TEXT,
  confidence REAL NOT NULL,
  reclaimable_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE duplicate_group_files (
  group_id INTEGER NOT NULL REFERENCES duplicate_groups(id),
  file_id INTEGER NOT NULL REFERENCES files(id),
  PRIMARY KEY (group_id, file_id)
);

CREATE TABLE media_metadata (
  file_id INTEGER PRIMARY KEY REFERENCES files(id),
  width INTEGER,
  height INTEGER,
  duration_ms INTEGER,
  codec TEXT,
  bitrate INTEGER,
  camera_make TEXT,
  camera_model TEXT,
  title TEXT,
  artist TEXT,
  album TEXT
);

CREATE TABLE extension_stats (
  extension TEXT PRIMARY KEY,
  file_count INTEGER NOT NULL,
  total_bytes INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE timeline_history (
  id INTEGER PRIMARY KEY,
  root_path TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  total_bytes INTEGER NOT NULL,
  file_count INTEGER NOT NULL,
  folder_count INTEGER NOT NULL
);
```

Indexes:

```sql
CREATE INDEX idx_files_size ON files(size DESC);
CREATE INDEX idx_files_folder ON files(folder_id);
CREATE INDEX idx_files_extension_size ON files(extension, size DESC);
CREATE INDEX idx_files_modified ON files(modified_at);
CREATE INDEX idx_files_hash ON files(size, partial_hash, full_hash);
CREATE INDEX idx_folders_total_bytes ON folders(total_bytes DESC);
CREATE INDEX idx_folders_parent ON folders(parent_id);
```

## 4. API and Event Contract

Backend commands:

- `start_scan_job_for_root(root) -> { job_id, index_path }`
- `scan_job_events(job_id, offset) -> JobEvent[]`
- `scan_job_status(job_id) -> JobStatus`
- `cancel_scan_job(job_id)`
- `query_index({ index_path, limit }) -> IndexOverview`
- `search_files({ index_path, query, limit }) -> FileSearchResult[]`
- `duplicate_group_files({ index_path, group_id, limit }) -> DuplicateFile[]`
- `scan_to_index({ root, index_path }) -> ScanToIndexResponse`

Event stream:

- `Started`
- `Progress`
- `FileIndexed`
- `FolderIndexed`
- `Error`
- `Finished`
- `Cancelled`

The desktop frontend currently polls buffered scan job events. A pushed Tauri event stream remains a good follow-up for lower-latency progress updates.

## 5. Frontend Component Hierarchy

```text
App
  ShellLayout
    SidebarNav
    TopCommandBar
    Dashboard
      ScanHero
      LiveScanMetrics
      CategoryCards
      RecommendationStrip
    ScanManager
    TreemapExplorer
      Breadcrumbs
      TreemapCanvas
      SelectionInspector
    DuplicateFinder
    LargestFiles
    MediaLibrary
    CleanupRecommendations
    TimelineAnalytics
    Settings
```

## 6. Worker-Thread Design

Rust scanner workers share a queue of directories. Workers pop directories, read entries, enqueue child directories, and publish file/folder events. The scanner reports queue depth, active workers, files/sec, bytes/sec, current path, and inaccessible entries. Pause and cancellation are atomic controls shared by all workers.

The index writer should run separately from scanners and batch events into SQLite every N events or M milliseconds. This keeps crawling responsive and avoids one transaction per file.

## 7. Treemap Rendering Strategy

Use a canvas renderer with a compact rectangle list instead of DOM-heavy nodes. Keep a compact node array with numeric indexes instead of object-heavy recursive nodes. Render only visible nodes at the current zoom. Hit testing uses a spatial index or sorted rectangle list. Labels are density-gated so small cells draw color only.

Targets:

- 50,000 visible nodes without DOM layout cost.
- Smooth zoom by interpolating viewport transform.
- Breadcrumb-based drill-down.
- Tooltip content fetched lazily from indexed aggregates.

## 8. Scan Engine Pseudocode

```text
start_scan(root):
  queue.push(root)
  spawn N workers
  while not done:
    emit progress snapshot every 250ms

worker_loop:
  while not cancelled:
    wait if paused
    dir = queue.pop()
    for entry in read_dir(dir):
      if symlink: skip
      if directory: queue.push(entry)
      if file:
        emit FileIndexed(path, size, timestamps, extension)
    emit FolderIndexed(path, direct_files, direct_bytes)
```

## 9. State Management Strategy

Use a small app store for active scan state, selected root/session, route, and filters. Query results should live in async query caches keyed by filter input. Large datasets stay in the backend and are paged or aggregated before reaching React.

## 10. Incremental Indexing Strategy

For each indexed path, store size, modified time, folder parent, hashes, and `indexed_at`. On rescan:

- Skip unchanged files when size and modified time match.
- Mark missing paths as deleted.
- Invalidate hashes when size or modified time changes.
- Recalculate folder totals bottom-up only for affected folders.
- Preserve scan session history for timeline comparisons.

## 11. Performance Optimization Plan

- Stream scan events instead of accumulating full trees in memory.
- Batch SQLite writes with prepared statements.
- Store repeated strings through normalized folder IDs.
- Avoid hashing until size grouping proves it may matter.
- Use virtualized tables and canvas visualizations.
- Throttle UI progress updates to animation-frame or 250ms cadence.
- Keep media metadata extraction optional and queued after base indexing.

## 12. Security Considerations

- Operate fully offline.
- Never upload file paths, metadata, hashes, or content.
- Skip symlinks initially; later support safe canonical-path loop detection.
- Use least-privilege Tauri command allowlists.
- Move deletions to recycle bin by default.
- Require preview and confirmation for cleanup plans.
- Protect configured system folders from automated cleanup.

## 13. Packaging and Distribution Strategy

Use Tauri for Windows, macOS, and Linux packages. Ship the scanner/index engine inside the app bundle, with optional integrations detected at runtime:

- ffmpeg for video metadata.
- exiftool for rich photo metadata.
- platform recycle-bin APIs for safe deletion.

Current status:

1. Scanner core: implemented.
2. Database/indexing: implemented.
3. UI shell: implemented.
4. Treemap visualization: implemented with canvas and drilldown.
5. Duplicate engine: implemented with staged hashing and group details.
6. Media intelligence: implemented as extension-based media rollups.
7. Optimization and polish: ongoing.
