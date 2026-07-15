---
title: Bird's Eye — storage cognition for your own machine
hide:
  - navigation
  - toc
---

<div class="be-hero" markdown>

<img class="be-hero__logo" src="assets/icon.png" alt="Bird's Eye" />

<h1 class="be-hero__title">Bird's <span class="be-accent">Eye</span></h1>

<p class="be-hero__tagline">See every folder. Trust every verdict.</p>

<p class="be-hero__sub">Bird's Eye classifies what's on your disk — size, staleness, and a plain-language reason — then stages cleanup that's fully reversible.</p>

<div class="be-cta">
  <a class="md-button be-store" href="https://apps.microsoft.com/detail/9NZH5J31GHSL"><svg class="be-store__logo" width="19" height="19" viewBox="0 0 23 23" aria-hidden="true"><path fill="#f25022" d="M1 1h10v10H1z"/><path fill="#7fba00" d="M12 1h10v10H12z"/><path fill="#00a4ef" d="M1 12h10v10H1z"/><path fill="#ffb900" d="M12 12h10v10H12z"/></svg><span class="be-store__text"><span class="be-store__sub">Get it from the</span><span class="be-store__name">Microsoft Store</span></span></a>
  <a class="md-button be-key" href="https://github.com/keiken-shin/birds-eye/releases/latest/download/birds-eye-windows-portable-x64.exe"><svg class="be-btn__icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Download portable .exe</a>
  <a class="md-button be-cta__tertiary" href="https://github.com/keiken-shin/birds-eye"><svg class="be-btn__icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>View source on GitHub</a>
</div>

<div class="be-trust">
  <span>Recycle bin first</span>
  <span>Restorable 30 days</span>
  <span>Never leaves your machine</span>
</div>

<p class="be-platform">Windows 10 &amp; 11 · x64 · ~14 MB · MIT · fully offline</p>

<div class="be-stats">
  <div class="be-stat"><span class="be-stat__num">100%</span><span class="be-stat__label">offline, always</span></div>
  <div class="be-stat"><span class="be-stat__num">0 bytes</span><span class="be-stat__label">ever uploaded</span></div>
  <div class="be-stat"><span class="be-stat__num">7 views</span><span class="be-stat__label">one persistent index</span></div>
  <div class="be-stat"><span class="be-stat__num">30-day</span><span class="be-stat__label">restore window</span></div>
  <div class="be-stat"><span class="be-stat__num">190+</span><span class="be-stat__label">Rust tests</span></div>
</div>

<div class="be-demo">
  <img src="assets/demo.gif" alt="Bird's Eye walkthrough — Overview, Treemap, Board, Files, Duplicates, Cleanup, and Timeline views of a scanned drive" />
</div>

</div>

<p class="be-eyebrow">Why Bird's Eye</p>

<p class="be-manifesto">Storage tools tell you what's big. Bird's Eye tells you what's <span class="be-accent">safe to delete</span> — every folder classified, quantified, and reversible, without a single byte leaving your machine.</p>

A disk map answers one question — *where did the space go?* Bird's Eye answers the one that
actually unblocks you: **which of this is safe to remove, and on what evidence?**

It scans your folders into a persistent on-device index, then runs an opt-in
**intelligence layer** that reasons about every folder — why it exists, whether it's
regenerable, what depends on it — and turns that into safety verdicts, reclaimable-space
estimates, and a reviewed, fully reversible cleanup flow.

No accounts. No telemetry. No upload. The index, the reasoning, and every decision stay on
your disk.

<p class="be-eyebrow">How it works</p>

## The loop

<div class="grid cards" markdown>

-   :material-radar:{ .lg .middle } **Scan**

    ---

    A parallel Rust scanner walks your drive — cancellable, symlink-safe — and streams
    results into a persistent SQLite index. Rescans are incremental: unchanged files are
    skipped, so the second look is fast.

-   :material-brain:{ .lg .middle } **Understand**

    ---

    The intelligence layer classifies each folder by category, age, and purpose — build
    caches, media, installers, abandoned projects — using on-device heuristics. No ML, no
    cloud, and it shows its reasoning.

-   :material-shield-check:{ .lg .middle } **Decide**

    ---

    Every candidate carries a verdict — <span class="be-chip be-chip--safe">safe</span>
    <span class="be-chip be-chip--review">review</span>
    <span class="be-chip be-chip--protected">protected</span>
    <span class="be-chip be-chip--keep">keep</span> — paired with its size, staleness, and
    a plain-language reason. Nothing is invented; unclassified means unclassified.

-   :material-backup-restore:{ .lg .middle } **Clean — reversibly**

    ---

    Staged items pass a review gate, then go to the OS Recycle Bin with a tracked entry —
    restorable for 30 days, or instantly via Undo. Or move a file to a better home instead
    of deleting it; the index heals itself.

</div>

<p class="be-eyebrow">The workspace</p>

## One workspace, seven lenses

There are no “pages.” A single persistent workspace holds one index, and the top-bar
switcher flips between views of it — the Inspector, Cleanup Tray, and Review gate stay
with you the whole time.

<div class="grid cards" markdown>

-   :material-view-dashboard-outline:{ .lg .middle } **Overview**

    ---

    The hub: capacity bar, category donut, top consumers, an age snapshot, and a headline —
    *“X GB can likely be freed.”*

-   :material-grid:{ .lg .middle } **Treemap**

    ---

    A squarified space map colored by **type** or by **safety verdict**, drillable to any
    depth.

-   :material-graph-outline:{ .lg .middle } **Board**

    ---

    An open canvas of the investigation: findings cluster around shared-source hubs with
    labeled edges; marquee-select, group-drag, auto-arrange.

-   :material-file-search-outline:{ .lg .middle } **Files**

    ---

    Ranked search with category filters, size/date sorting, staleness tags, and curated
    saved views like *“Large & regenerable.”*

-   :material-content-copy:{ .lg .middle } **Duplicates**

    ---

    Waste-ranked groups with side-by-side previews — keep the newest, stage the rest, or
    move a copy where it belongs.

-   :material-broom:{ .lg .middle } **Cleanup**

    ---

    Risk-labeled recommendations (safe · review · caution) with multi-select staging into
    the tray.

-   :material-chart-timeline-variant:{ .lg .middle } **Timeline**

    ---

    Monthly activity, file-age distribution, and *“large & untouched”* candidates.

</div>

[Tour the workspace :material-arrow-right:](guide/the-workspace.md){ .md-button }

<p class="be-eyebrow">Safety</p>

## Safety is the default, not a setting

Bird's Eye is deliberately **anti-scareware**. It never nags, never auto-deletes, and never
pressures you toward a “clean now” button.

- **Recycle bin first, always.** Every clean goes to the OS Recycle Bin with a tracked
  entry, restorable for 30 days from *Recently cleaned* — or reverted instantly with Undo.
- **Held-back items are shown, never dropped.** If the safety predicate holds something
  back, you see it and its reason — and you can still remove it through an explicit,
  clearly-marked override.
- **The intelligence layer is opt-in per index**, heuristic, and transparent. It reasons in
  the open and never fabricates data.

[How the safety model works :material-arrow-right:](guide/working-safely.md){ .md-button }

<p class="be-eyebrow">Privacy</p>

## Private by design

Bird's Eye is an offline desktop app. There is no server to sign in to, no account to
create, and no path in the code that uploads your file paths, metadata, hashes, or
contents. Verify it yourself — [the source is MIT-licensed and public](https://github.com/keiken-shin/birds-eye).

<p class="be-eyebrow">Get it</p>

## Get Bird's Eye

<div class="be-cta">
  <a class="md-button be-store" href="https://apps.microsoft.com/detail/9NZH5J31GHSL"><svg class="be-store__logo" width="19" height="19" viewBox="0 0 23 23" aria-hidden="true"><path fill="#f25022" d="M1 1h10v10H1z"/><path fill="#7fba00" d="M12 1h10v10H12z"/><path fill="#00a4ef" d="M1 12h10v10H1z"/><path fill="#ffb900" d="M12 12h10v10H12z"/></svg><span class="be-store__text"><span class="be-store__sub">Get it from the</span><span class="be-store__name">Microsoft Store</span></span></a>
  <a class="md-button be-key" href="https://github.com/keiken-shin/birds-eye/releases/latest/download/birds-eye-windows-portable-x64.exe"><svg class="be-btn__icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Download portable .exe</a>
  <a class="md-button be-cta__tertiary" href="develop/building/"><svg class="be-btn__icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>Build from source</a>
</div>

### On the Microsoft Store { #windows-store }

Bird's Eye is [**live on the Microsoft Store**](https://apps.microsoft.com/detail/9NZH5J31GHSL) —
one-click install, automatic updates, and a Store-signed package. Prefer no install? The
[portable `.exe`](https://github.com/keiken-shin/birds-eye/releases/latest/download/birds-eye-windows-portable-x64.exe)
is on [GitHub Releases](https://github.com/keiken-shin/birds-eye/releases/latest). Maintainers
can read how the Store package is built and submitted in [Releasing](develop/releasing.md).
