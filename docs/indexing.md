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
4. `FileIndexed` upserts the file, ensures its folder exists, classifies a coarse `media_kind`, and updates `extension_stats`.
5. `FolderIndexed` updates direct folder totals.
6. `Finished` finalizes the scan session, rebuilds Stage 1 duplicate groups by file size, and writes a `timeline_history` snapshot.

Duplicate confidence is currently `0.35` for size-only matches. Later stages should raise confidence only after partial hashing and full hashing.

This is the durable Phase 2 foundation. Next indexing work should improve batching, exact folder rollups, deleted-file cleanup, and partial/full hash duplicate refinement.
