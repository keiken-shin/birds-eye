# Recording the demo

The demo shown in the [README](../README.md) and on the docs landing page lives at
**`docs/assets/demo.gif`**. Replace that file to update the demo everywhere at once.

## What the demo is for

Reasoning doesn't photograph. A treemap screenshot of Bird's Eye is indistinguishable from a
treemap screenshot of twenty free tools — and the thing that actually makes Bird's Eye different
is a *sentence*, not a picture. The demo GIF is the one place that sentence can be forced into
view.

So the demo is **one story, not a feature tour**. Not eight views. One.

> **The frame that must be legible when someone pauses it is the reason line — not the map.**

## The story, in about 25 seconds

| Beat | On screen | Hold |
|---|---|---|
| 1 | A drive that's nearly full — the used bar deep in the red | 2 s |
| 2 | Click **Scan C:**; findings stream past as they're found | 4 s |
| 3 | Land on the headline: **"You can safely free 148.9 GB"** | 3 s |
| 4 | **Hover a row so the reason is readable** — `node_modules · 12.3 GB · untouched 8 months · rebuildable from package.json` | **4 s — the longest hold in the demo** | 
| 5 | Click **Review 6 safe items · 41.2 GB**; the review list shows exactly what will happen | 4 s |
| 6 | Confirm — items go to the Recycle Bin | 2 s |
| 7 | The freed space lands: the used bar drops, the toast says how much came back | 3 s |

Beat 4 is the whole demo. Everything before it is setup and everything after it is proof. If you
have to cut time, cut from beats 1, 2 and 6 — never from 4.

Move deliberately. A demo that races is harder to read than one that breathes.

## What not to record

- **Not the eight views.** A tour of views says "this has a lot of features". The story says
  "this solves your problem". Only one of those makes someone install it.
- **Not the plain map.** If a frame of the demo could belong to WinDirStat, it's a wasted frame.
  Where the map appears at all, it should be coloured by safety — that's the view no competitor
  has.
- **No cursor hunting.** Rehearse the path first so the pointer moves straight to each target.

## Option A — the real desktop app (best)

1. Build and launch: `cd workspace && npm run tauri:dev` (or run a release build).
2. **Maximize** the window on a 1920×1080 (or 2560×1440) display. Keep the aspect 16:9 — don't
   drag it to an odd size. The previous demo was captured on a resized window and looked squashed.
3. Record with [ScreenToGif](https://www.screentogif.com/) (free, Windows): *Recorder* → size the
   capture region to the window → record the story → *Edit* → trim.

Record against a drive that genuinely has something to find. A demo where the headline says
"You can safely free 400 MB" undersells a tool that routinely finds hundreds of gigabytes.

## Option B — the browser dev build (no Rust needed)

The workspace renders identically against mock data, which is handy for a clean, repeatable
capture:

1. `cd workspace && npm run dev` → open the printed localhost URL.
2. Put the browser in a **1920×1080** window (fullscreen `F11`, or DevTools device toolbar set to
   a 1920×1080 custom size at 100%).
3. Record the region with ScreenToGif, as above.

## Export settings

- **GIF** (`docs/assets/demo.gif`): target **~1280–1440 px wide**, ~15 fps, looped. Keep it under
  ~5 MB so pages stay snappy — ScreenToGif's built-in optimizer or `gifsicle -O3` handles this.
  Check the reason line is still readable *after* optimisation; GIF colour quantisation eats small
  text first, and that text is the point of the demo.
- **MP4** (optional, `docs/assets/demo.mp4`): smaller and sharper, and it keeps the reason line
  crisp. If you add one, swap the landing-page `<img>` in `docs/index.md` for a muted,
  autoplaying, looping `<video>`.

## Stills

Screenshots live in `docs/assets/screenshots/` and are referenced from
`docs/guide/the-workspace.md` and `docs/guide/getting-started.md`.

**The hero image** — README, docs landing, store listing — should be **a Clean up row or the
safety-coloured map**, never the plain map. A plain treemap is indistinguishable from twenty free
tools, and using one throws away the only picture that shows what Bird's Eye does differently.

### All nine stills are currently out of date

They were captured before the positioning pass and now contradict the text around them. Every one
needs recapturing. What changed:

- **View names.** Treemap → **Map**, Board → **Findings**, Cleanup → **Clean up**, Timeline →
  **By age**, Catalog → **Organise**. The old shots show the old words.
- **The switcher shows all eight labels now.** The old shots show one label and seven bare icons.
- **Three safety labels, not four.** *Safe to delete · Check first · Don't touch* replace
  safe/review/protected/keep.
- **The Map lands on safety colouring**, not colour-by-type.
- **"Reclaimable" is gone** — headings now read *"You can free"*, and Overview headlines
  *"You can safely free X"*.
- **Clean up rows carry a size, an age and a reason.** That row is the single most valuable thing
  to photograph; make it legible.

The file names (`treemap.png`, `board.png`, `cleanup.png`, `timeline.png`) can stay as they are —
renaming them means touching every reference for no reader-visible gain.

### One is missing entirely

**Organise has no screenshot.** It is view 8 in `docs/guide/the-workspace.md` and the only view
without one. Capture `organise.png` and add it there.

### Capturing

`cd workspace && npm run dev` gives the whole workspace against realistic mock data — no Rust
toolchain, no real drive needed, and repeatable. Window at 1920×1080, then crop per view.

## After recording

- Overwrite `docs/assets/demo.gif` (and `docs/assets/demo.mp4` if used).
- The README and the docs site both point at that path already — no other edits needed.
- Build the docs locally and check the demo renders before pushing (see
  [Building from source](../docs/develop/building.md)).
