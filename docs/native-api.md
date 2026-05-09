# Native API Boundary

The current native boundary is intentionally Tauri-shaped without requiring the Tauri shell yet.

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
  - Returns largest folders, largest files, extension summaries, and duplicate groups.

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

These functions use serializable DTOs so they can be wrapped by `#[tauri::command]` once the desktop shell lands.

Next native work:

- Emit scan progress events to the frontend.
- Add Tauri file/folder picker integration.
- Keep query methods separate from long-running scans.
