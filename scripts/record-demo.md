# Recording the demo

The demo shown in the [README](../README.md) and on the
[docs landing page](https://keiken-shin.github.io/birds-eye/) lives at
**`docs/assets/demo.gif`**. Replace that file to update the demo everywhere at once.

The one rule: **record at a real 16:9 resolution, unscaled.** The previous demo was
captured on a resized window and looks squashed. Record full-screen (or a maximized window
at a native 16:9 size) so nothing is stretched.

## What to record

A calm ~15–25 s walk through the seven views, in this order — it mirrors the product's own
loop (scan → understand → decide → clean):

1. **Overview** — land on the headline (*“X GB can likely be freed”*), capacity bar, donut.
2. **Treemap** — toggle verdict/category coloring, drill one level.
3. **Board** — pan across a couple of finding clusters.
4. **Files** — apply a saved view (e.g. *Large & regenerable*).
5. **Duplicates** — expand a waste-ranked group.
6. **Cleanup** — multi-select a couple of safe items into the tray.
7. **Timeline** — the age distribution / “large & untouched”.

Move deliberately. Let each view settle for a beat before switching — a demo that races is
harder to read than one that breathes.

## Option A — the real desktop app (best)

1. Build and launch: `cd workspace && npm run tauri:dev` (or run a release build).
2. **Maximize** the window on a 1920×1080 (or 2560×1440) display. Don't drag it to an odd
   size — keep the aspect 16:9.
3. Record with [ScreenToGif](https://www.screentogif.com/) (free, Windows): *Recorder* →
   size the capture region to the window → record the walkthrough → *Edit* → trim.

## Option B — the browser dev build (no Rust needed)

The workspace renders identically against mock data, which is handy for a clean, repeatable
capture:

1. `cd workspace && npm run dev` → open `http://localhost:5174`.
2. Put the browser in a **1920×1080** window (fullscreen `F11`, or DevTools device toolbar
   set to a 1920×1080 custom size at 100%).
3. Record the region with ScreenToGif, as above.

## Export settings

- **GIF** (`docs/assets/demo.gif`): target **~1280–1440 px wide**, ~15 fps, looped. Keep it
  under ~5 MB so pages stay snappy — ScreenToGif's built-in optimizer or `gifsicle -O3`
  handles this.
- **MP4** (optional, `docs/assets/demo.mp4`): a smaller, sharper alternative. If you add
  one, swap the landing-page `<img>` in `docs/index.md` for a muted, autoplaying,
  looping `<video>` — it'll look better and weigh less than the GIF.

## After recording

- Overwrite `docs/assets/demo.gif` (and `docs/assets/demo.mp4` if used).
- The README and the docs site both point at that path already — no other edits needed.
- Preview the docs locally with `mkdocs serve` before pushing.
