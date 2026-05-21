## Core recommendation

Your current finalization is doing too much **before the scan becomes usable**.

Change the model from:

```text
crawl → finalization → usable scan
```

to:

```text
crawl → commit index → usable scan immediately
          ↓
     async refinement jobs
```

Index first. Prove duplicates later.

## Fastest indexing strategy

### 1. Metadata-first index

During crawl, write only cheap facts:

```text
path
parent_id
name
extension
size
mtime
ctime
file_type
inode/file_id if available
```

Do **not** hash during primary indexing except maybe tiny files.

This gives instant “largest files/folders/search/tree” capability.

---

### 2. Use content hash status fields

Instead of needing hashes before finalization completes, store hash lifecycle state:

```sql
hash_status:
  none
  sampled
  full_xxh3
  full_blake3
  verified
```

Also store:

```sql
sample_hash
sample_scheme
full_hash
hash_algorithm
hash_updated_at
```

Now duplicate detection becomes progressive, not blocking.

---

### 3. Commit scan result before duplicate refinement

After crawl:

```text
commit files
commit folder tree
commit basic folder rollups
commit extension stats
mark scan as indexed
```

Then UI opens workspace immediately.

Duplicate panels can say:

```text
Duplicate analysis running...
```

This is a much better user experience.

---

## New pipeline

```text
Stage 1: Crawl filesystem metadata
Stage 2: Bulk insert files/folders
Stage 3: Basic rollups
Stage 4: Mark scan usable
Stage 5: Background duplicate sampling
Stage 6: Background full hashing only candidate groups
Stage 7: Build duplicate groups incrementally
```

The important shift:

> **Duplicate analysis is not finalization. It is enrichment.**

That one architectural change will remove the “scan feels stuck” problem.

## SQLite indexing strategy

During bulk insert:

```text
disable / defer expensive indexes
insert in batches
commit transaction
then create / refresh indexes
```

Recommended indexes:

```sql
CREATE INDEX idx_files_scan_size ON files(scan_id, size);
CREATE INDEX idx_files_scan_parent ON files(scan_id, parent_id);
CREATE INDEX idx_files_scan_ext ON files(scan_id, extension);
CREATE INDEX idx_files_scan_path ON files(scan_id, path);
CREATE INDEX idx_files_hash_candidate ON files(scan_id, size, sample_hash, full_hash);
```

But do **not** maintain all of them during insert if the scan is huge. Build after insert.

## Big win: candidate table

Do not constantly query the full `files` table for duplicates.

Create a small derived table:

```sql
duplicate_candidates (
  scan_id,
  size,
  file_count,
  total_bytes,
  status
)
```

Populate only sizes with count > 1:

```sql
INSERT INTO duplicate_candidates
SELECT scan_id, size, COUNT(*), SUM(size)
FROM files
WHERE scan_id = ?
GROUP BY size
HAVING COUNT(*) > 1;
```

Then hash only those files.

This is probably your biggest de-dup speedup.

## Separate scan tables from analysis tables

Use this mental model:

```text
files              = truth
folders            = truth
folder_rollups     = derived
extension_stats    = derived
duplicate_candidates = derived
duplicate_groups   = derived
hash_jobs          = work queue
```

The scan should finish when `files` and `folders` are written.

Everything else can trail behind like a comet tail ☄️.

## Background hash job queue

Create:

```sql
hash_jobs (
  id,
  scan_id,
  file_id,
  job_type, -- sample, full, verify
  priority,
  status,
  created_at,
  started_at,
  completed_at
)
```

Priority examples:

```text
small duplicate candidates first
largest potential savings first
visible folder first
user-selected files first
```

This lets the UI feel intelligent instead of trapped in a furnace room.

## Best default behavior

### During scan

```text
crawl metadata
hash files <= 64 KiB inline
write everything
finish scan
```

### After scan

```text
sample duplicate-size files
full-hash only matching sample groups
byte-verify only when user acts
```

## Practical thresholds

Good starting defaults:

```text
inline full hash:
  <= 64 KiB or <= 256 KiB

sample hash:
  files with same size and size > 256 KiB

deeper sample:
  only if first sample group count > 1

full hash:
  only if sample group count > 1
```

## Important change to your current finalization

Move these out of blocking finalization:

```text
Duplicate sampling
Full hashing
Duplicate-group building
Timeline capture
```

Keep only:

```text
folder rollups
extension stats
basic scan summary
transaction commit
```

Even folder rollups can be incremental, but they are usually cheap enough compared to hashing.

## Final architecture

```text
Scanner Thread Pool
    ↓
Metadata Channel
    ↓
Bulk SQLite Writer
    ↓
Usable Index

Background Refinement Workers
    ↓
Duplicate Candidates
    ↓
Sample Hashes
    ↓
Full Hashes
    ↓
Duplicate Groups
```

## My strongest recommendation

Make scan completion mean:

> “Your storage map is ready.”

Not:

> “Every possible duplicate has been fully proven.”

That is the difference between a fast indexing app and a scanner that feels like it is boiling the ocean.

---

## Implementation checkpoint

The backend now has the first progressive-refinement slice:

- `scan_sessions.status = complete` is written after metadata, rollups, extension stats, candidate discovery, and timeline capture.
- `duplicate_candidates` stores same-size candidate groups by scan session.
- `hash_jobs` queues per-file sample work and records completed sample/full hash refinement.
- `IndexWriter::refine_duplicates_with_progress` performs the heavier sampling, full hashing, and duplicate-group rebuild outside scan finalization.
- Background scan jobs emit the completed scan event before duplicate refinement continues.

The next refinement layer can make `hash_jobs` truly resumable/chunked instead of executing the queued work in one refinement call.

