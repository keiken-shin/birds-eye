---
title: Bird's Eye — disk cleanup for Windows
description: Free, offline disk cleanup for Windows that explains what is safe to remove, lets you stage a decision, and reviews every change before it reaches your drive.
hide:
  - navigation
  - toc
---

<div class="be-hero" markdown>

<div class="be-hero__copy" markdown>

<img class="be-hero__logo" src="assets/icon.png" alt="Bird's Eye" />

<h1 class="be-hero__title">See what you can delete. <span class="be-accent">Know why it's safe.</span></h1>

<p class="be-hero__tagline">Bird's Eye is a free, offline disk cleanup tool for Windows. It turns a drive scan into specific decisions: the size, when you last touched it, and the reason it can—or cannot—go.</p>

<div class="be-trust" aria-label="Safety and privacy">
  <span>Recycle Bin first</span>
  <span>Review every change</span>
  <span>0 bytes uploaded</span>
</div>

<div class="be-cta">
  <a class="md-button be-store" href="https://apps.microsoft.com/detail/9NZH5J31GHSL"><svg class="be-store__logo" width="19" height="19" viewBox="0 0 23 23" aria-hidden="true"><path fill="#f25022" d="M1 1h10v10H1z"/><path fill="#7fba00" d="M12 1h10v10H12z"/><path fill="#00a4ef" d="M1 12h10v10H1z"/><path fill="#ffb900" d="M12 12h10v10H12z"/></svg><span class="be-store__text"><span class="be-store__sub">Get it from the</span><span class="be-store__name">Microsoft Store</span></span></a>
  <a class="md-button be-key" href="https://github.com/keiken-shin/birds-eye/releases/latest/download/birds-eye-windows-portable-x64.exe">Download portable .exe</a>
</div>

<p class="be-platform">Windows 10 &amp; 11 · free · MIT licensed · no account</p>

</div>

<div class="be-hero__visual" markdown>

<div class="be-product-frame">
  <img src="assets/screenshots/staged.png" alt="Bird's Eye Staged workspace with grouped files ready for review" />
</div>

<p class="be-hero__caption"><strong>Staged</strong> keeps the files you set aside until you are ready to review them. Closing the app does not clear the decision.</p>

</div>

</div>

<div class="be-recommendation" aria-label="Example Bird's Eye recommendation">
  <span class="be-recommendation__name">node_modules</span>
  <span><b>12.3 GB</b> on disk</span>
  <span>untouched <b>8 months</b></span>
  <span>a build cache that fills itself back in when needed</span>
</div>

## The answer a disk map stops short of

A treemap can show you that a folder is large. It cannot tell you whether removing that folder
breaks a project, deletes the only copy, or simply clears a cache.

Bird's Eye reads the folder structure on your machine, classifies what it can explain, and puts
the evidence beside the recommendation. If it cannot tell, it says so. You make the decision.

<div class="be-contrast" markdown>

<div markdown>

### A map answers

> Where did my space go?

Size, hierarchy, and file type help you investigate.

</div>

<div markdown>

### Bird's Eye continues

> Which of this can I remove, and how do you know?

Size, last touched, reason, safety label, and a reviewed action help you decide.

</div>

</div>

## From recommendation to reviewed action

<div class="be-workflow" markdown>

<div class="be-workflow__step" markdown>

### Read the reason

Start with a real row, not a score. Every recommendation carries a size, an age, and plain-English
reasoning.

</div>

<div class="be-workflow__step" markdown>

### Stage the decision

Set aside files and folders from any view. Staging changes nothing on disk and survives an app
restart.

</div>

<div class="be-workflow__step" markdown>

### Group what belongs together

Use **Staged** as a decision desk: keep related items together, then choose whether to clean or move.

</div>

<div class="be-workflow__step" markdown>

### Review before anything moves

Bird's Eye checks the chosen items again and shows the exact plan. You confirm; it uses the
Recycle Bin or the destination you chose.

</div>

</div>

<div class="be-demo">
  <img src="assets/demo.gif" alt="Bird's Eye workflow from a recommendation to Staged and the Review gate" />
</div>

<p class="be-demo__caption">Recorded against the built-in mock drive: recommendation → stage → Staged → review.</p>

[Follow the staged workflow](guide/stage-and-review.md){ .md-button .md-button--primary }

## Safety you can inspect

<div class="be-assurance" markdown>

### It explains the call

**Safe to delete**, **Check first**, and **Don't touch** are the only three labels. Each comes
with the reason Bird's Eye chose it. Held-back items remain visible.

### It makes actions reversible

Cleanup goes to the Windows **Recycle Bin**. Undo and **Recently cleaned** keep a record of what
happened. Reviewed moves can be put back.

### It stays on your machine

No account, sign-in, telemetry, model, or cloud service. Not a filename, path, hash, or byte is
uploaded. The [MIT-licensed source](https://github.com/keiken-shin/birds-eye) is available to inspect.

</div>

[Read the safety and recovery model](guide/working-safely.md){ .md-button }

## What it finds

- Build output and package caches such as `node_modules`, `target`, `.gradle`, and pip caches
- Installers and large downloads you have not opened in months
- Duplicate files, ranked by the space their extra copies use
- Projects, virtual disks, backups, models, and media that have been sitting untouched
- Files that look like they belong somewhere you already use

The first scan takes a few minutes because Bird's Eye reads more than sizes. Later scans only look
at what changed, so they finish much sooner.

## What it refuses to become

- No “health score” or alarming issue counter
- No registry cleaning or startup “optimisation”
- No automatic deletion, countdown, nag, or upsell
- No claim that it is the fastest scanner
- No AI tagline hiding an upload

## One scan, eight useful views

<div class="be-viewlist" markdown>

- **Overview** — the amount you can likely free and the reasons behind it
- **Map** — size as area, coloured by safety or file kind
- **Staged** — the files and folders you set aside while deciding
- **Files** — ranked search, filters, and saved views
- **Duplicates** — side-by-side groups ranked by wasted space
- **Clean up** — recommendations and findings waiting for your confirmation
- **By age** — activity over time and large files left untouched
- **Organise** — reviewed suggestions for files that belong elsewhere

</div>

The Inspector, the persistent tray, and the Review gate follow you between views.

[Tour the workspace](guide/the-workspace.md){ .md-button }

## Start where you are

<div class="be-paths" markdown>

<div markdown>

### I want to free space

Install the app, scan one folder or drive, and stage a single recommendation.

[Start your first scan](guide/getting-started.md)

</div>

<div markdown>

### I want to understand or change the code

Bird's Eye is a Rust scanner and SQLite index behind a React 19 + Tauri 2 desktop shell.

[Read the architecture](develop/architecture.md) · [Build from source](develop/building.md)

</div>

</div>

<div class="be-close" markdown>

## Make the next deletion a decision, not a guess

Free for Windows 10 and 11. Works with the network switched off.

<div class="be-cta">
  <a class="md-button be-store" href="https://apps.microsoft.com/detail/9NZH5J31GHSL"><span class="be-store__text"><span class="be-store__sub">Get it from the</span><span class="be-store__name">Microsoft Store</span></span></a>
  <a class="md-button be-key" href="https://github.com/keiken-shin/birds-eye/releases/latest/download/birds-eye-windows-portable-x64.exe">Download portable .exe</a>
  <a class="md-button be-cta__tertiary" href="https://github.com/keiken-shin/birds-eye">View source</a>
</div>

</div>
