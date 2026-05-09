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
6. `Finished` marks files under the scan root as deleted when they were not seen in the current run, recomputes folder rollups, rebuilds extension statistics, rebuilds Stage 1 duplicate groups by file size, and writes a `timeline_history` snapshot.

Duplicate confidence is currently:

- `0.35` for size-only matches when partial hashing could not be computed.
- `0.65` for same-size files with matching partial hashes.

Later stages should raise confidence only after full hashing.

This is the durable Phase 2 foundation. Next indexing work should improve batching and full-hash duplicate refinement.

Read API currently exposed by `IndexWriter`:

- `largest_folders(limit)`
- `largest_files(limit)`
- `extension_summaries(limit)`
- `duplicate_groups(limit)`
