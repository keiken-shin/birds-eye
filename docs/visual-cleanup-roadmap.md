# Visual Cleanup Workbench Roadmap

This branch tracks the next Birds Eye product push: faster scan feedback, richer search, safer cleanup actions, and visual prioritization.

## Current Checkpoint

- Duplicate candidates were simplified into summary metrics plus a decision table. The folder overlap graph now highlights top pairs and most affected folders, but it is hidden as an experimental detail until it can explain the next cleanup decision better.
- Before/after simulation now uses exact duplicate candidate reclaim totals, with folder-specific overlap data when available and proportional estimates as a fallback. It also lists the top simulated folder changes so the effect is visible even when treemap geometry changes are subtle.
- Timeline is pinned for repair and hidden from the primary workflow. Do not build on it until its interaction model is redesigned and validated.
- Exact duplicate groups can stage a Windows Recycle Bin commit that keeps the newest indexed copy and recycles the extra copies. Broader move/delete actions are still review-only.
- Exact duplicate details now let the user choose the retained copy before staging a Recycle Bin commit.
- Smart suggested moves now show top source folders, timestamp-derived year buckets, and a clearer destination preview before staging a review action. They remain non-destructive.
- Sunburst hierarchy is intentionally behind a disclosure because the current version is not yet strong enough to be a primary cleanup surface.

## Foundation First

- [x] Replace scan polling with pushed Tauri scan events.
- [x] Add richer indexed search filters: media kind, extension, min/max size, optional regex.
- [ ] Add safe recycle-bin integration for staged cleanup commits.
  First pass exists for exact duplicate groups on Windows only. Retained-copy control exists in duplicate details; index refresh after commit now auto-runs when possible, and non-Windows commits are blocked in the UI while cross-platform support remains pending.
- [ ] Keep every destructive or move operation staged first. No direct delete/move from visual surfaces.

## P0

- [x] Color-coded treemap blocks by dominant category using the same palette as the filter tabs.
- [x] Staging area / commit queue for all move/delete suggestions.
- [x] Open in Explorer action for folders and files.

## P1

- [ ] Duplicate overlap graph: folders as bubbles, shared duplicate edges weighted by reclaimable bytes or duplicate count.
  First pass exists; a second pass now surfaces top overlap pairs and most affected folders with a reclaim/files weighting toggle, but it is still treated as an experimental detail behind a disclosure.
- [x] Action heatmap replacing text-only cleanup cards.
  Heatmap cells can stage review actions; all file operations remain non-destructive.
- [ ] Smart suggested moves panel for scattered media, grouped by dates and destination folders.
  Second pass exists: scattered media categories show source-folder previews, destination hints, and timestamp-derived year buckets (with overflow counts) before staging review destinations. EXIF grouping and executable move plans remain pending.

## P2

- [ ] Lazy thumbnail hover previews for visible/hovered photo/video folders with a small cache.
  First pass exists: treemap hover tooltips show lazy photo previews or media placeholders from indexed samples; a small hover cache now reduces re-filtering.
- [ ] Timeline scatter for photos/videos by EXIF or file timestamp, colored by folder.
  Pinned. The current implementation is broken enough to stay out of the primary workflow until redesigned.
- [ ] Depth-based sunburst chart for folder hierarchy.
  First pass exists behind a disclosure. Now shows hover details (path, bytes, files, depth) to improve clarity, but it still needs stronger interaction before it should be considered complete.

## P3

- [ ] Lasso / paintbrush batch selection on visual blocks.
- [ ] Before/after cleanup simulation slider.
  First pass exists: duplicate simulation renders before/after treemaps with a confidence slider and falls back to proportional reclaim estimates when folder overlap data is incomplete.
- [ ] Keyboard-first power mode for treemap/search/filter navigation.
  First pass exists: `/` focuses search, `1-0` switch filters, `W/I` switch workspace/index, `Esc` clears folder focus.
- [ ] Customizable layout: let users reorder, hide, and resize workbench panels.

## Trust And Explainability

- [x] Confidence labels on every cleanup action: Safe, Medium, Risky, Manual review.
- [x] "Why this suggestion?" panel explaining evidence, retained copy, and staged target.
- [ ] Audio/video metadata summaries when metadata extraction exists: duration, bitrate, average episode length.

## Notes

The intended core combination is:

1. Color-coded treemap for instant orientation.
2. Duplicate overlap graph for instant priority.
3. Action heatmap for instant action.

The cleanup model should stay offline-first and reversible until explicit commit.
