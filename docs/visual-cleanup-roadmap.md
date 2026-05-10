# Visual Cleanup Workbench Roadmap

This branch tracks the next Birds Eye product push: faster scan feedback, richer search, safer cleanup actions, and visual prioritization.

## Foundation First

- [x] Replace scan polling with pushed Tauri scan events.
- [x] Add richer indexed search filters: media kind, extension, min/max size, optional regex.
- [ ] Add safe recycle-bin integration for staged cleanup commits.
- [ ] Keep every destructive or move operation staged first. No direct delete/move from visual surfaces.

## P0

- [x] Color-coded treemap blocks by dominant category using the same palette as the filter tabs.
- [x] Staging area / commit queue for all move/delete suggestions.
- [x] Open in Explorer action for folders and files.

## P1

- [x] Duplicate overlap graph: folders as bubbles, shared duplicate edges weighted by reclaimable bytes or duplicate count.
- [x] Action heatmap replacing text-only cleanup cards.
- [ ] Smart suggested moves panel for scattered media, grouped by dates and destination folders.
  First pass exists: scattered media categories can be staged into review destinations. Date grouping remains for EXIF/timestamp extraction.

## P2

- [ ] Lazy thumbnail hover previews for visible/hovered photo/video folders with a small cache.
  First pass exists: treemap hover tooltips show lazy photo previews or media placeholders from indexed samples.
- [x] Timeline scatter for photos/videos by EXIF or file timestamp, colored by folder.
  Supports cluster zoom and selected-media preview from indexed photo/video samples.
- [x] Depth-based sunburst chart for folder hierarchy.

## P3

- [ ] Lasso / paintbrush batch selection on visual blocks.
- [ ] Before/after cleanup simulation slider.
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
