# Positioning implementation — spec

Source of truth: `birds-eye-positioning-2026-07-31.html` (the research). Branch: `feat/positioning`
off `feat/cataloging`.

**The one idea:** Other tools show you what's big. Bird's Eye tells you what's safe.

**The durable test for every user-facing string:** *would you say this sentence out loud to a
friend?* "Trust every verdict" — no. "It tells you what's safe to delete and why" — yes.

---

## The line between internal and user-facing

The kill list rule from the research is precise: **"if the word came from a file name in `src/`, it
does not belong in front of a user."** It is a rule about *strings a user reads*, not about code.

- **Do not rename** Rust modules, TS types, DB columns, or test names. `ontology/`, `verdict.ts`,
  `reclaimable_bytes` stay. They are correct engineering words and the research explicitly says to
  keep them "in the developer docs where they belong and are genuinely good."
- **Do rename** every string rendered to a user: labels, headings, tooltips, empty states, toasts,
  button text, aria-labels, and all marketing/user-guide prose.

---

## A. Product changes

### A1 — The analysis runs by default (Option A) — blocks everything else

`src/ontology/enabled.rs:27` returns `false` when the `ontology_enabled` row is missing. Missing is
the state of every index that wasn't created through the scan overlay's checkbox, so the median
first run is scan → treemap, which is WinDirStat with better colours.

**Fix at the root:** a missing row means **enabled**. Only an explicit `0` disables. Every caller
routes through `is_enabled`, so this is one predicate, not a guard per call site. The opt-out moves
to Settings ("Just show me sizes — skip the analysis").

Existing indexes that were never enabled will flip on. That is the intent, not a side effect.

### A2 — Switcher labels

`workspace/src/lib/viewRegistry.ts`. Internal `StageView` keys do not change.

| Now | Ship |
|---|---|
| Overview | **Overview** (keep — right word, right default) |
| Treemap | **Map** |
| Board | **Findings** — *superseded, see below* |
| Files · Duplicates · Cleanup | **Files · Duplicates · Clean up** |
| Timeline | **By age** |
| Catalog | **Organise** |

**The `board` label is superseded by `specs/2026-08-14-hardening-and-the-board.md`.** "Findings"
shipped and is correct for what that view does today. That spec repurposes the view into a decision
workspace labelled **Staged**, and re-homes the finding-review half of it — which turns out to be the
only surface that graduates a discovery into a fact the cleanup predicate reads. The rest of A2
stands unchanged.

### A3 — Four safety labels → three

Never ship a fourth. Three states is the ceiling for something read at a glance across hundreds of
rows.

| Ship | Colour | Means | Maps from |
|---|---|---|---|
| **Safe to delete** | green | rebuildable, temporary, or a duplicate | `safe` |
| **Check first** | amber | might matter — here's what it is, you decide | `review` |
| **Don't touch** | grey, **with the reason** | in use, system, or you pinned it | `protected` + `keep` |

`protected` and `keep` merge in the UI. The distinction ("we won't let you" vs "we think you want
this") is ours, not theirs. `canStage` behaviour must not change — merging labels must not make a
protected item stageable.

### A4 — Every recommendation carries three things

**How much space · how long since you touched it · a reason in plain English.** The row is the ad:

```
node_modules · 12.3 GB · untouched 8 months · rebuildable from package.json
```

Age is always a **number** ("untouched 8 months"), never a category ("stale").

### A5 — The Map is coloured by safety by default

The safety-coloured map is the view no competitor has. Colour-by-type stays as a toggle.

### A6 — The first 60 seconds

| Beat | What must be true |
|---|---|
| 0:00 Open | Drives already listed with capacity and a used bar. No empty grey window. One primary button: **"Scan C:"** — names the thing it will do. |
| 0:05 Scanning | Never a bare progress bar. Stream findings as they're found: *"Found 4.2 GB of build caches… 1,120 duplicate files…"* The wait becomes the demo. |
| 0:40 Landing | **One number and one sentence**: *"You can safely free 148.9 GB."* Then the top five reasons as rows with sizes and ages. Not the donut, not the map. |
| 0:55 First action | One obvious next step: **"Review 6 safe items · 41.2 GB."** |

**Verified gaps behind A6.** Neither of these exists today:

- **No drive enumeration anywhere in the codebase.** The scan overlay opens on an empty text input
  reading *"Choose or paste a folder to scan…"* — literally the empty grey window the research says
  never to show. Needs a Rust API returning fixed drives with capacity, free space and label
  (`GetLogicalDriveStringsW` + `GetDiskFreeSpaceExW` + `GetDriveTypeW`). `windows-sys` is already a
  dependency — add the `Win32_Storage_FileSystem` feature rather than a new crate.
- **No landing screen.** There is no "one number, one sentence" moment. The app opens into the full
  workspace chrome with every panel showing at once.

### A7b — Durable undo for relocations

Deletions are **already durable**: `src/ontology/cleanup/restore.rs` keeps an append-only
`cleanup_log` in SQLite with `recently_cleaned()` and `restore_with()`, restorable for 30 days.

Relocations are **not**. `UndoState` is React state and `workspace/src/lib/undo.ts` is four lines
that reverse a list of path pairs in memory — close the app and the move is unundoable. That is the
seam the research means by "durable undo (an append-only log, not session-only)". Give moves the
same log treatment deletions already have.

### A7 — What we say about speed

Never claim fastest, never bury it, never fight WizTree. The line, verbatim:

> The first scan takes a few minutes, because it's reading more than sizes. After that it only
> looks at what changed — so the second scan is seconds.

### A8 — Guardrails (never ship)

- No health score, no "issues found", no red badge, no counter. That is the persuasion grammar the
  FTC sued twice.
- No "AI" in any tagline. *"No AI. No cloud. It reads your own folder structure and tells you what
  it found."* is worth more than the keyword.
- No fourth safety label.
- Organise never becomes the headline. Space sells; tidiness upsells.

---

## B. The jargon kill list

Search-and-replace across app strings, README, docs, store listing.

| Say this | Not this |
|---|---|
| *(cut entirely)* | storage cognition |
| what's safe to delete | safety verdict |
| space you can free / GB you'd get back | reclaimable space, potential bytes unlocked |
| untouched for 8 months | staleness, stale |
| the analysis / what Bird's Eye found | the intelligence layer, opt-in per index |
| findings | discoveries |
| *(never user-facing)* | ontology, populator, predicate, entity, graduation |
| a rebuildable build cache | a regenerable artifact |
| it works offline / nothing is uploaded | fully offline, no telemetry paths in the code |
| Bird's Eye checks before it moves anything | the review gate re-verifies against the index |
| put files where they belong | cataloging, relocation suggestions, learned homes |
| *(cut)* | 190+ Rust tests · 8 views · one persistent index |

---

## C. Copy — the six surfaces

Paste-ready copy lives in the research, section 06. Ship it verbatim:

1. Microsoft Store short description
2. Microsoft Store long description
3. Website hero + the manifesto below the fold
4. GitHub About field (350 chars)
5. README first three paragraphs
6. The one-liner

Always pair the product name with the noun: **"Bird's Eye — disk cleanup for Windows"** in every
store field, page title and social bio.

**Positioning statement.** For developers and IT people on Windows whose drive is full of their own
work, Bird's Eye is a free disk cleanup tool that, unlike WizTree, TreeSize and WinDirStat, tells
you what's safe to delete and why — not just what's big. Safe enough to hand to anyone: everything
goes to the Recycle Bin first, nothing moves until you review it, nothing ever leaves the PC.

**Say what it's not.** Not a PC optimiser. Not an enterprise reporting tool. Not a
fastest-scanner contender. Not an AI product. Naming what you're not is the cheapest credibility
available in a category this compromised.

---

## D. The docs client

Replace MkDocs Material with a small client that reads `docs/**/*.md` and renders it in the
research document's theme.

- **Theme:** lift the tokens from `birds-eye-positioning-2026-07-31.html` verbatim — the near-black
  ramp (`--base #0a0b0d` → `--raised-2 #1f232b`), the single spring-green accent `--primary
  #3ddc84`, Space Grotesk + JetBrains Mono, `--r 14px`. Fonts self-hosted (the research file's
  `@import` from Google Fonts must not survive — the site claims offline-first).
- **Content stays markdown.** `docs/**/*.md` remains the source; the client parses it at build
  time. Frontmatter for title/description/order.
- **Must carry over:** sticky top bar with the bird mark, eyebrow + section title + sub, cards,
  callouts (`.callout` and its warn/crit/good variants), chips, stat tiles, the `kv` definition
  list, code blocks with the green left border, the two-column source list, and the ToC box.
- **The developer docs are the right home** for the architecture, the test count, the eight views
  and the index design. The research says they are "genuinely excellent" there.

---

## Decisions and findings, as they land

**A1 shipped.** `is_enabled` now reads "enabled unless the stored value is explicitly `0`". Missing
row → enabled. 264 Rust tests pass. Three tests that were implicitly asserting "fresh index = off"
now call `disable()` explicitly, which is what they always meant.

- *Fail-open on read error.* A genuine SQL error reading the flag also resolves to enabled. This is
  deliberate and safe: enabling the analysis only classifies, it never deletes, and every deletion
  still passes the review gate. Failing closed would silently return the product to "a nicer
  treemap", which is the exact failure this change exists to prevent.
- *The `birds-eye-scan` CLI never ran the analysis at all* — not before this change and not after.
  Phase 2 is only wired into the async job path in `src/native/jobs.rs`, which only the desktop app
  uses. Not a positioning defect (the CLI is a dev binary, not the product), but it means
  `scripts/bench-rescan.ps1` measures the scan floor rather than the full first-run wait. The
  script says so in its header. Do not quote its first-scan number as "how long Bird's Eye takes".

**A2–A5 shipped.** Verified live in the browser at 1280px and 980px: all eight labels render
(Overview · Map · Findings · Files · Duplicates · Clean up · By age · Organise), the Map lands on
Safety with a three-entry legend, Overview headlines *"You can safely free 148.9 GB"*, and the page
title is paired. Settings has a real opt-out. `canStage` still blocks `protected`.

- *A near-miss the label pass introduced.* `explainFolder` appended one generic clause for anything
  marked `regenerable`, so a **backup** rendered as **"A backup copy · you can rebuild it."** That
  sentence is false — a redundant backup is regenerable because *another copy survives*, not
  because you could recreate it — and it is exactly the kind of line that talks someone into
  deleting their only copy. The clause is now role-aware, and a test pins that a backup's reason
  never contains "rebuild". Pillar 2 is "it can't hurt you"; the reason text is part of that
  promise, not decoration on top of it.
- *A4 is done.* It was not, for a while: every **folder** row read `date unknown`, including the
  research's own hero example, because only files carried a timestamp. The backend rollup landed —
  a folder now reports the newest `modified_at` among every file anywhere beneath it
  (`native/api.rs`), and the landing rows read `OldLaptop · 41.2 GB · untouched 1.8 years`.
  Verified in the running app.
- *The years branch never handled one.* `untouchedFor` rendered anything from 365 to 729 days as
  "untouched 1.0 years" — a trailing `.0` nobody says, and a plural on one. The months branch had
  been getting this right the whole time. Caught by reading the running app rather than the tests,
  which is the only way this class of thing gets caught.

**A6 shipped.** Verified live at 1280px: the scan sheet opens on the drive list
(`C: OS — 294.0 GB free of 966.0 GB` with a used bar), the primary button reads **"Scan C:"**, an
unreadable volume stays listed saying its size is unknown, and the speed line is the research's
verbatim. Overview lands on *"You can safely free 148.9 GB."* with five reason rows and
**"Review 6 safe items · 102.6 GB"**, all above the stat tiles and the donut.

- *Default drive changed from "fullest" to "system".* The fullest-drive rule opened on `D:` for a
  typical developer. The moment that makes someone install this is Windows saying it needs space,
  and Windows only says that about `C:`. A data drive at 80% is normal and nobody is losing sleep
  over it.
- **A7b shipped — the backend half first, and for a while only that half.** Relocations write to an
  append-only `ontology_relocation_log` (`MIGRATION_013`) with a restore path that refuses cleanly
  rather than overwriting. The reviewed-plan path — Organise itself — was passing
  `index_path: None`, so the moves most worth undoing were the ones with no record at all. Every
  move now funnels through one logging point, including the cross-volume copy-then-delete fallback.

  *What "shipped" missed.* `recently_moved` and `restore_from_relocation_log` were implemented,
  registered as commands and tested — and nothing ever called them. `nativeClient.ts` had no
  wrapper for either, so the only undo a user could reach was still the toast, backed by the
  four-line in-memory `reversePairs`. Close the app and the move was still unundoable, which is the
  exact sentence this item exists to delete. A feature is not shipped when the half a person can
  touch is missing; "the tests pass" measured the wrong half. Recently cleaned now lists moved
  files with **Put back**, and the whole round trip was exercised in the browser.

  *And the log could still describe a world that never existed.* Two ways, both found reviewing the
  branch before merge. A reverse move logged a second open entry instead of closing the first, so
  undoing a five-file relocation left ten entries: five whose Put back fails, five offering to redo
  the move just undone. And a failed metadata read at move time records size 0, which — the column
  being NOT NULL, with no way to say "unknown" — refused every later restore of a non-empty file
  while claiming it had changed. Both fixed, both pinned by a test.

**The folder-coherence guardrail shipped.** A folder inside an inbox zone holding ≥10 live files
with ≥60% sharing one kind is left alone, along with everything beneath it. Those are `infer.rs`'s
own `MIN_LEARNED_FILES` / `MIN_LEARNED_SHARE`, reused rather than re-tuned — a folder good enough
for `learned_home` to adopt as a destination should not be dismantled just because it sits in a
zone. Pure set subtraction, no migration, no destination logic touched. The zone root itself can
never be settled: Downloads full of PDFs *is* the problem, not evidence of intent.

**And it exposed a live bug that mattered more.** `is_in_zone`'s drive-root rule — "matches the
root or a *direct* child" — is written for **file** paths, where `D:\installer.exe` really is loose
at the root of D:. But candidacy is decided per **folder**, and `cluster.rs` was passing folder
paths. So under a `D:\` zone the folder `D:\Projects` qualified as a direct child, and every file
directly inside it became a relocation candidate. Confirmed empirically: a `D:\Projects` holding
three documents yielded three candidates. Organise was offering to scatter files out of a folder
the user deliberately made, on a drive they deliberately scanned.

Fixed with `zone_for_folder` in `zones.rs` — for a drive-root zone the inbox is the root folder and
nothing else; every other zone still nests.

**`infer.rs` was folded in after all.** It was left alone at first, on the reasoning that changing
destinations is a different risk class than removing candidates. Looking at what the old behaviour
actually did reversed that. `learned_home` reads `folders.path`, so under a `D:\` zone it struck
out `D:\Photos` as zone-resident: the folder a user's photos already live in could never be adopted
as their home, and it left the outside-only denominator too. The suggestion then fell through to a
`%USERPROFILE%` template — a **cross-volume** move onto the system drive, through the
copy-then-delete fallback, when the right destination was a rename away on the same disk. The
cautious option was the one proposing worse moves. `template_for` moved with it, so "would this
destination come straight back as a candidate?" is the same question `candidates` asks.

The blast radius is pinned rather than argued: a test asserts `zone_for_folder` and `is_in_zone`
agree on every zone that is not a drive root, so the change can only reach an index where a drive
root is a scan root. An ordinary Downloads/Desktop setup is unaffected, bit for bit.

Both tests are mutation-checked — neutering the drive-root branch fails them.

### Honest gaps that remain, and why

| Gap | Why it stands |
|---|---|
| No category totals while scanning (*"Found 4.2 GB of build caches…"*) | Classification runs **after** the walk, so no category has a total mid-scan. We stream files, folders, bytes, phase and the current folder instead. |
| "11,204 files could be duplicates", not "1,120 duplicate files" | The only real number mid-scan is files sharing a size — candidates, not confirmed duplicates. Saying the stronger thing would be inventing it. |
| `Installers → "You can get it back."` | Weakest row on the landing. Needs a **role** from the backend; there is no honest copy fix. The research names "installers you already ran" as a headline category, so this is worth closing. Still true — confirmed live, the row reads `Installers · 15.6 GB · untouched 1 year · You can get it back.` |
| Screenshots and the demo GIF | Recaptured, and `organise.png` added — all ten now ship. Worth a maintainer's eye on the images themselves; a diff proves the bytes changed, not that the picture is right. |

## E. Verification — the loop

Each round checks the tree against this spec, then against the research directly:

1. `cargo test` · `cargo check --manifest-path src-tauri/Cargo.toml`
2. `npx tsc --noEmit` · `npx vitest run` · `npm run build` in `workspace/`
3. Docs client builds and renders every `docs/**/*.md`.
4. **Copy gate:** `node scripts/check-copy.mjs` — fails on a kill-list word in user-facing prose.
5. **Read gate:** every new string passes "would you say it out loud to a friend?"

### What the copy gate does and doesn't look at

It reads prose, not code, because the kill list is a rule about sentences a user sees. It ignores
identifiers, SQL, Rust doc comments, `#[cfg(test)]` modules, crash paths (`.expect`, `panic!`,
`assert!`), fenced code, developer sections (`## Build`, `## Project layout`, `docs/develop/`,
`scripts/`, the `birds-eye-scan` CLI), and disavowals — the approved copy *No "247 issues found"*
must not trip a gate for containing the phrase it exists to reject. `copy-ok` on a line suppresses
a genuine false positive.

**It scans Rust too, and that mattered.** An early version checked only TypeScript and markdown,
and the Files view was shipping **"Regenerable derivatives over 100 MB"** straight out of
`src/ontology/saved_views.rs` — clean on the frontend, wrong in front of the user. Three more
leaked the same way, all crossing `Result<_, String>` into UI toasts and the scan log:

| Was | Now |
|---|---|
| `ontology layer is disabled for this index` | `the analysis is turned off for this index` |
| `populator error: {msg}` | `analysis error: {msg}` |
| `populator aborted: {msg}` | `analysis stopped: {msg}` |
| `phase 2 skipped (ontology disabled for this index)` | `Analysis skipped — it's turned off for this index.` |

A user-facing string that only exists in Rust is still a user-facing string.
