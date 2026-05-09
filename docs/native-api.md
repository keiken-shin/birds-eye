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

These functions use serializable DTOs so they can be wrapped by `#[tauri::command]` once the desktop shell lands.

Next native work:

- Convert synchronous commands into cancellable background tasks.
- Emit scan progress events to the frontend.
- Add Tauri file/folder picker integration.
- Keep query methods separate from long-running scans.

