# Indexing Pipeline

The Rust scanner can now stream events into a SQLite index.

Run a persisted scan:

```powershell
cargo run --bin birds-eye-scan -- <folder> --index birds-eye.sqlite
```

Inspect an existing index:

```powershell
cargo run --bin birds-eye-scan -- query birds-eye.sqlite 10
```

Current flow:

1. `Scanner` emits `Started`, `FileIndexed`, `FolderIndexed`, `Progress`, `Finished`, and `Cancelled` events.
2. `IndexWriter` applies schema migrations on open.
3. `Started` creates a `scan_sessions` row.
4. `FileIndexed` upserts the file, ensures its folder exists, and classifies a coarse `media_kind`.
5. `FolderIndexed` updates direct folder totals.
6. `Finished` marks files under the scan root as deleted when they were not seen in the current run, recomputes folder rollups, rebuilds extension statistics, refines duplicate candidates through partial and full hashes, and writes a `timeline_history` snapshot.

Duplicate confidence is currently:

- `0.35` for size-only matches when partial hashing could not be computed.
- `0.65` for same-size files with matching partial hashes.
- `1.0` for same-size files with matching full hashes.

The same indexing APIs are exposed through the native boundary and Tauri commands for the desktop app.

Read API currently exposed by `IndexWriter`:

- `largest_folders(limit)`
- `largest_files(limit)`
- `search_files(query, limit)`
- `extension_summaries(limit)`
- `duplicate_groups(limit)`
- `duplicate_group_files(group_id, limit)`
- `media_summaries()`
- `folder_media_summaries(limit)`
