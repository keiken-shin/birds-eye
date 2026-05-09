# Native API Boundary

The native boundary is implemented as serializable Rust DTOs that are wrapped by Tauri commands in `src-tauri/src/main.rs`.

Module:

```text
src/native/api.rs
```

Commands:

- `scan_to_index({ root, index_path })`
  - Runs the Rust scanner.
  - Streams scanner events into SQLite through `IndexWriter`.
  - Returns final file, folder, and byte counts.
- `query_index_overview({ index_path, limit })`
  - Returns largest folders, largest files, extension summaries, duplicate groups, media summaries, and per-folder media rollups.
- `search_files({ index_path, query, limit })`
  - Searches active indexed files by file name or path.
  - Escapes SQLite `LIKE` wildcard characters and orders matches by size.
- `duplicate_group_files({ index_path, group_id, limit })`
  - Returns the files inside a duplicate group for previewing reclaimable candidates.

Background job API:

- `ScanJobManager::start_scan_job({ root, index_path })`
  - Starts a scan on a background thread.
  - Streams events into SQLite.
  - Stores progress/completion/failure events in memory for polling or later Tauri event forwarding.
- `ScanJobManager::cancel_job(job_id)`
  - Requests cancellation through the scanner controller.
- `ScanJobManager::job_events_since(job_id, offset)`
  - Returns buffered job events after the given offset.
- `ScanJobManager::job_status(job_id)`
  - Returns `Running`, `Completed`, `Cancelled`, or `Failed`.

Desktop-only command helpers:

- `start_scan_job_for_root(root)`
  - Resolves the app data index path for the selected root and starts a background scan.
- `scan_job_events(job_id, offset)`
  - Lets the frontend poll buffered scan progress without blocking the UI.

The frontend talks to this boundary through `frontend/src/nativeClient.ts`. Browser preview mode uses the File API worker instead of native commands.
