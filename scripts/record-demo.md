# Recording the docs workflow

The landing page and README use `docs/assets/demo.gif`. The current Staged screen lives at
`docs/assets/screenshots/staged.png`.

Both assets come from the browser-mode mock app. That keeps the capture repeatable, avoids putting
a real person's paths in the repository, and lets a docs update run without the Rust desktop shell.

## What the recording proves

The recording is one decision, not a tour of eight views:

| Beat | What the viewer should notice | Hold |
|---|---|---:|
| Overview | The result is a sentence: **You can safely free 148.9 GB.** | 1.8 s |
| Clean up | A row has a name, size, last-touched age, reason, and safety label. | 2.6 s |
| Persistent tray | Selected items are staged; nothing on disk changed. | 1.8 s |
| Staged | The items survive as a named group on the decision desk. | 2.6 s |
| Review | The exact chosen set reaches the Review gate. | 2.8 s |

The old recording showed the retired Findings canvas. Do not recreate it. Finding confirmation now
lives at the top of **Clean up**, and view 3 is **Staged**.

## Capture with the deterministic scripts

Start the mock workspace:

```powershell
cd workspace
npm run dev -- --host 127.0.0.1 --port 5174
```

In another terminal, from the repository root:

```powershell
node scripts/capture-doc-assets.cjs
python scripts/assemble-demo.py
```

`capture-doc-assets.cjs` expects Playwright and a matching Chromium install. If the browser
binary is in a non-default location, set `BIRDS_EYE_CHROMIUM` to its full path. If Vite uses a
different URL, set `BIRDS_EYE_CAPTURE_URL`.

The capture script:

1. Opens a fresh 1600 × 1000 browser context.
2. Selects two real recommendation rows from the mock index.
3. Stages them and opens Staged.
4. Groups them as **Build leftovers**.
5. Opens the clean review.
6. Writes the still and five workflow PNGs.

The assembler resizes the frames to 1280 pixels wide, uses a constrained GIF palette, and writes a
looping `demo.gif`. The result should stay well below 5 MiB; the current five-frame recording is
about 0.5 MiB.

Temporary frames live in `.capture/docs-workflow/` and are ignored by Git.

## Capture manually

Use a manual recording only when the workflow itself needs motion that the deterministic capture
does not show.

1. Run the browser-mode workspace or the real Tauri app.
2. Use a 16:10 or 16:9 window at 100% scale; do not stretch a capture afterwards.
3. Start on Overview, move deliberately through Clean up → Stage selected → Staged → Review.
4. Hold the recommendation long enough to read the reason.
5. Keep the pointer path direct. Rehearse before recording.
6. Export at 1280–1440 pixels wide, about 15 fps, looped, under 5 MiB.

A manual capture must use synthetic or non-sensitive data. Paths, account names, and file names are
part of the picture.

## Other screenshots

The view references live in `docs/assets/screenshots/`:

- `overview.png`
- `treemap.png`
- `staged.png`
- `files.png`
- `duplicates.png`
- `cleanup.png`
- `timeline.png`
- `organise.png`
- `scans.png`
- `new-scan.png`

`board.png` is retained only as history and is no longer referenced by the docs. Do not use it in
new copy or social previews.

## Check the result

After capture:

```powershell
cd docs-site
npm run build
npm test
```

Then inspect the landing page at desktop and mobile widths. Confirm:

- Staged is legible in the top switcher.
- The recommendation reason survives GIF quantization.
- The screenshot shows the current grouped workspace, not the retired canvas.
- The demo reaches Review without confirming a destructive action.
- No personal path or file name appears.
- The image keeps its aspect ratio and has no clipped app chrome.
