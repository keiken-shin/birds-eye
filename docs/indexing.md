# Indexing Pipeline

The Rust scanner can now stream events into a SQLite index.

Run a persisted scan:

```powershell
cargo run --bin birds-eye-scan -- <folder> --index birds-eye.sqlite
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

This is the durable Phase 2 foundation. Next indexing work should improve batching and expose these queries through the native app boundary.

Read API currently exposed by `IndexWriter`:

- `largest_folders(limit)`
- `largest_files(limit)`
- `extension_summaries(limit)`
- `duplicate_groups(limit)`
