---
title: Bird's Eye — disk cleanup for Windows
hide:
  - navigation
  - toc
---

<div class="be-hero" markdown>

<img class="be-hero__logo" src="assets/icon.png" alt="Bird's Eye" />

<h1 class="be-hero__title">Know what's <span class="be-accent">safe to delete</span>.</h1>

<p class="be-hero__tagline">Bird's Eye scans your Windows drive, works out what each folder is actually for, and tells you what you can safely remove — with the size, the age, and the reason.</p>

<div class="be-trust">
  <span>Recycle Bin first</span>
  <span>Restorable for 30 days</span>
  <span>Nothing leaves your PC</span>
</div>

<div class="be-cta">
  <a class="md-button be-store" href="https://apps.microsoft.com/detail/9NZH5J31GHSL"><svg class="be-store__logo" width="19" height="19" viewBox="0 0 23 23" aria-hidden="true"><path fill="#f25022" d="M1 1h10v10H1z"/><path fill="#7fba00" d="M12 1h10v10H12z"/><path fill="#00a4ef" d="M1 12h10v10H1z"/><path fill="#ffb900" d="M12 12h10v10H12z"/></svg><span class="be-store__text"><span class="be-store__sub">Get it from the</span><span class="be-store__name">Microsoft Store</span></span></a>
  <a class="md-button be-key" href="https://github.com/keiken-shin/birds-eye/releases/latest/download/birds-eye-windows-portable-x64.exe"><svg class="be-btn__icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Download portable .exe</a>
  <a class="md-button be-cta__tertiary" href="https://github.com/keiken-shin/birds-eye"><svg class="be-btn__icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>View source on GitHub</a>
</div>

<p class="be-platform">Free · MIT · Windows 10 &amp; 11 · ~14 MB · works offline</p>

<p class="be-hero__sub"><strong>0 bytes ever uploaded.</strong> No account, no sign-in, no telemetry — not a filename, not a hash.</p>

<div class="be-demo">
  <img src="assets/demo.gif" alt="Bird's Eye walking through a scanned drive — what's on it, what's safe to delete, and the reviewed clean-up" />
</div>

</div>

<p class="be-eyebrow">Why Bird's Eye</p>

<p class="be-manifesto">Other tools show you what's big. Bird's Eye tells you what's <span class="be-accent">safe</span>.</p>

A disk map answers *"where did my space go?"* Bird's Eye answers the question that actually
unblocks you: **"which of this can I delete, and how do you know?"**

12.4 GB of build cache, untouched 8 months, rebuildable in one command. That's a sentence you
can act on. A coloured rectangle isn't.

<p class="be-eyebrow">What you get</p>

## It explains itself

Every recommendation carries three things: **how much space**, **how long since you touched
it**, and **a reason in plain English**. Not a score, not a grade — a sentence.

```text
node_modules · 12.3 GB · untouched 8 months · rebuildable from package.json
```

## It can't hurt you

Nothing is deleted until you review a list of exactly what will happen. Everything goes to the
**Recycle Bin**, restorable for 30 days — or undone instantly right after the action. Things
Bird's Eye won't touch are shown to you with the reason, never silently hidden, and you can
still remove them yourself if you disagree.

Everything is labelled one of three ways, and never a fourth:

| Label | Means |
|---|---|
| **Safe to delete** | Rebuildable, temporary, or a duplicate. |
| **Check first** | Might matter — here's what it is, you decide. |
| **Don't touch** | In use, system, or you pinned it — shown with the reason. |

## It never phones home

No account. No sign-in. No telemetry. Nothing uploaded — not a filename, not a hash. It works
with the network switched off, on a machine that has never seen the internet. The source is
public and [MIT-licensed](https://github.com/keiken-shin/birds-eye), so you can check rather
than believe.

There is no AI and no cloud in here. Bird's Eye reads your own folder structure and tells you
what it found.

<p class="be-eyebrow">The specifics</p>

## What it finds

- Build outputs and package caches — `node_modules`, `target`, `.gradle`, pip
- Installers you already ran, sitting in Downloads
- Duplicate files, ranked by how much space they waste
- Projects you finished and haven't opened in a year
- Old backups, VM disks and model files you forgot about

## What it will never do

- No "health score." No "247 issues found."
- No registry cleaning. No startup "optimisation."
- No nagging, no countdowns, no upsell.
- No account, and no data leaving your machine.

## How long a scan takes

The first scan takes a few minutes, because it's reading more than sizes. After that it only
looks at what changed — so the second scan is seconds.

<p class="be-eyebrow">The workspace</p>

## Eight ways to look at one scan

There are no "pages." One scan sits underneath, and the top-bar switcher flips between views of
it — the Inspector, the Cleanup Tray and the Review gate stay with you the whole time.

| View | What it gives you |
|---|---|
| **Overview** | Where you stand: capacity bar, what's taking the space, an age snapshot, and a headline — *"X GB can likely be freed."* |
| **Map** | A space map where area is size, coloured by safety or by kind of file, drillable to any depth. |
| **Findings** | An open canvas of what the scan turned up — findings cluster around shared sources with labelled links. |
| **Files** | Ranked search with filters, size and date sorting, and saved views for the questions you ask every time. |
| **Duplicates** | Groups ranked by how much space they waste, with side-by-side previews. |
| **Clean up** | The recommendations, each labelled and each with a size, an age and a reason. |
| **By age** | Monthly activity, how old your files are, and the large-and-untouched items that are usually the easiest wins. |
| **Organise** | Grouped "these files belong somewhere else" suggestions, reviewed before anything moves. |

[Tour the workspace](guide/the-workspace.md){ .md-button }

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
