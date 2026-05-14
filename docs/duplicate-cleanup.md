# Duplicate Cleanup Workflow

Birds Eye treats duplicate cleanup as a staged review workflow. It should help the user understand the duplicate relationship, choose a retained copy, stage the cleanup, validate that the files are still safe to touch, and only then move duplicate copies to the operating system trash.

## Lifecycle

1. A scan groups duplicate candidates by size, partial hash, and full hash.
2. The duplicate list ranks groups by cleanup score, reclaimable bytes, confidence, folder spread, and media kind.
3. The detail panel shows duplicate files, folder relationships, a suggested retained copy, and side-by-side comparison.
4. The user chooses the retained copy and stages deletion of the other copies.
5. The Review Queue displays retained copy, copies to recycle, affected folders, confidence, reason, and rollback notes.
6. Before commit, the app validates that every expected file still exists and still has the indexed size and modified timestamp.
7. Valid staged items can be committed independently. Stale items remain blocked until refresh or rescan.

## Safety Model

No duplicate cleanup deletes files immediately from the detail panel. Staged actions are review records until the user commits them.

Exact duplicate groups are the safest path. A group marked `Safe` has matching full-file hashes, so keeping any one copy preserves file content. Size-only or partial-hash groups remain review candidates and should not be batch-cleaned.

Pre-commit validation blocks stale cleanup when:

- a file is missing
- a file path is no longer a regular file
- file size changed since scan
- modified timestamp changed since scan
- validation metadata is unavailable

## Retained Copy Selection

The app suggests a retained copy using a conservative score:

- prefer the newest modified timestamp
- prefer organized paths such as Photos, Pictures, Sorted, Archive, Library, Media, or Documents
- penalize temporary paths such as Downloads, Temp, Cache, Trash, or Recycle
- prefer shorter, cleaner paths as a tie-breaker

The suggestion is always user-overridable. Changing the retained copy updates the staged cleanup plan.

## Folder Relationships

Duplicate groups expose folder paths so the UI can explain whether duplicates are random one-offs or part of a copied folder/library. The folder-pair summary lets users filter duplicate groups to the folders that share duplicate content.

## Refresh

`refresh_duplicate_group` refreshes only the files from the selected duplicate group. It rechecks file existence and metadata, refreshes the index rows, rebuilds duplicate projections, and returns the best matching replacement group if the original group still exists after refresh.

## Preview Limitations

The frontend preview resolver maps indexed files to image, video, audio, document, or generic previews. Unsupported or failed previews fall back to useful metadata cards so the detail panel does not appear empty.

Native preview commands resolve files by indexed file ID and validate that the file still belongs to the indexed scan root. Thumbnail IDs are cached by file ID, modified timestamp, and size. Failed previews are cached temporarily to avoid repeated retry loops.

Rich media metadata depends on what the index has extracted. If dimensions, duration, or codec values are unavailable, the UI should show a clean unavailable state rather than blocking cleanup review.

## Platform Trash Limitations

Recycle Bin commit support is currently implemented for Windows. On other operating systems, Birds Eye can stage and validate cleanup actions, but commit is disabled until a safe platform trash implementation is added.

