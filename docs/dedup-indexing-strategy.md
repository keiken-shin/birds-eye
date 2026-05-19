# Dedup Indexing Strategy

## Previous Strategy

Birds Eye previously used a two-step FNV-1a duplicate check after the filesystem crawl finished:

1. Group active files by identical byte size.
2. For files in same-size groups, compute a partial FNV-1a hash from the first and last 64 KiB.
3. For files with the same size and partial hash, compute a full-file FNV-1a hash.
4. Build duplicate groups from `size + partial_hash + full_hash`.

This avoided hashing files with unique sizes, but it still had two important weaknesses:

- Files with identical headers and footers but different middle content advanced to full-file hashing.
- A rescan could keep stale full hashes when same-path files changed without changing size, which could preserve incorrect duplicate groups.

For heavy folders, the first issue is expensive. A few large generated files, videos, archives, model files, or build artifacts with matching edges could force full-file reads even when a cheap middle sample would have separated them.

## Current Strategy

Birds Eye now treats duplicate analysis as post-scan refinement. Scan completion means the storage map, largest-file/folder views, search, extension stats, and timeline are usable. Duplicate candidates and hash jobs are queued at the end of scan finalization, then content hashing runs after the completed scan event has been published.

The XXH3-based refinement flow is:

1. Crawl the filesystem metadata first.
2. Persist file metadata without content hashing during the crawl.
3. Mark the scan complete after rollups, extension stats, candidate discovery, and timeline capture.
4. Store same-size entries in `duplicate_candidates`.
5. Queue per-file `sample` work in `hash_jobs`.
6. In the refinement phase, compute a fast first-and-last XXH3 sample for same-size candidates.
7. Compute a stronger three-point XXH3 sample from first, middle, and last chunks.
8. Full-hash only files that still collide by `size + sample_hash` and are small enough for eager verification.
9. Build duplicate groups from the strongest available evidence.

The current hash states are:

- `0`: metadata only
- `2`: XXH3 sample hash written
- `4`: full-file XXH3 hash written

The stored evidence is:

- `partial_hash`: compatibility first-and-last XXH3 sample
- `sample_hash`: first/middle/last XXH3 sample
- `full_hash`: streaming full-file XXH3 hash
- `duplicate_candidates`: same-size candidate groups for the latest scan session
- `hash_jobs`: queued and completed sample/full hash work

On rescan, Birds Eye clears hashes when a file's size, modified time, or created time changes. This prevents stale hashes from carrying forward after content changes.

## Selectable Strategies

Birds Eye can run duplicate refinement with either `xxh3-progressive` or `fnv1a-legacy`.
New scans default to `xxh3-progressive`. The frontend remembers the user's preferred strategy for new scans, while saved-index rescans reuse the strategy stored in the index's latest scan session.

`fnv1a-legacy` preserves the original `size -> partial FNV-1a -> full FNV-1a` pipeline for compatibility and repeatable legacy comparisons. It is not the recommended default.

## Why We Switched

XXH3 is a better fit for dedup candidate filtering than FNV-1a:

- It is designed as a high-speed non-cryptographic hash.
- It provides 128-bit output for lower collision risk than the old 64-bit FNV value.
- It supports fast streaming full-file hashing through `Xxh3::update` and `digest128`.

The bigger architectural change is the middle sample. First and last chunks are useful, but many real files share headers, footers, padding, or container metadata. Sampling the middle eliminates many false candidates before the scanner reads entire large files.

For large files, Birds Eye now avoids eager full-file hashing during scan finalization. Those groups remain sample-backed candidates unless refinement or a later verified action requests stronger proof. This keeps heavy-folder indexing from spending minutes reading multi-gigabyte files before the app becomes usable.

## Benefits

Heavy folders should finalize faster because fewer large files reach full-file hashing. The difference is strongest for folders containing archives, media, model files, build outputs, dependency caches, and generated artifacts.

Duplicate groups are safer because sampled groups do not receive full confidence unless they survive full-file hashing. Files changed during rescans have stale hashes invalidated before duplicate groups are rebuilt.

The scanner remains responsive because the filesystem crawler still emits metadata events first. The expensive content work is now an explicit post-crawl refinement stage. The job manager emits `Completed` for the scan before duplicate refinement progresses, then continues reporting duplicate-analysis progress as completed-state background events.

Finalization now emits staged progress events for folder rollups, extension statistics, duplicate-analysis preparation, and timeline capture. Metadata writes also run inside a scan-wide SQLite transaction, reducing per-file commit overhead during large crawls.

## Safety Rule

Sampled duplicates are candidates, not deletion-safe proof. Before any destructive action, Birds Eye should require either:

- matching full-file XXH3 hashes, or
- byte-by-byte confirmation.

Byte comparison is intentionally deferred until delete/export workflows so normal indexing stays fast.
