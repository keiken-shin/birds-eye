# Bird's Eye — Workspace frontend

A from-scratch frontend realizing the **Synthesis** design in `docs/goal/` (one persistent
workspace · three lenses · command spine · shared Inspector + Cleanup Tray). It lives alongside
the original `frontend/` (which is untouched) and reuses the backend bridge via a Vite alias —
`@bridge` → `../frontend/src` (so `nativeClient.ts` / `domain.ts` are shared, never copied).

## Status — Milestone 1 (working vertical slice)

The full cleanup loop is **built and wired** to the real backend:

> scan → enable intelligence → enrich → inspect (why / verdict / reclaimable) → stage →
> Review & clean (quarantine) → Undo (restore from recycle bin)

**What is verified:** the workspace builds clean (tsc + vite), unit + integration tests pass
(verdict mapping, squarify, and the `query_index ⋈ treemap_lens_data` join on both path
separators), a browser smoke test renders the shell with zero JS errors, and the desktop app
**compiles and launches** via the override config (vite on 5174, Rust backend running).

**Not yet exercised:** the live data path and the destructive steps. The browser smoke test ran
with no Tauri runtime (every native call rejected into empty states), and the desktop launch was
confirmed at the window-open level only — no real scan rendered a treemap and
`execute_cleanup_plan` (which trashes files) has not run. See **Confirm the loop** below.

## Confirm the loop (needs the GUI — please run once)

1. Launch: `./frontend/node_modules/.bin/tauri dev --config src-tauri/tauri.workspace.conf.json`
2. **Scan** a folder containing a `node_modules` or build/cache dir (Smart strategy).
3. After it finishes, the **Enable intelligence** prompt appears → enable & let enrichment run.
4. Confirm the **treemap colors** appear (green = safe, amber = protected) and the Inspector shows
   a verdict + reclaimable for a selected folder.
5. **Stage** one safe folder → it lands in the Cleanup Tray → **Review & clean** → confirm those
   files leave disk (into the OS recycle bin).
6. **Undo** from the toast → confirm the files return. (Everything goes to the recycle bin with a
   30-day retention, so this is fully recoverable.)

- Persistent shell: brand bar, command spine + lens switcher, activity rail, scope tree +
  recent scans, center stage, Inspector, Cleanup Tray.
- **Treemap lens** over `query_index` folders, squarified, colored by the real verdict taxonomy
  (`treemap_lens_data` → `lib/verdict.ts`), with reclaimable badges.
- Honest empty states: with intelligence off, the treemap is size-only and verdicts read
  "Enable intelligence" — no invented data.
- Scan sheet exposes only real capabilities (Smart / Metadata strategies, local source);
  unsupported sources/algorithms are marked **future**.

Board lens, Results lens, command-spine routing, and the Library/Settings overlays are
later milestones (M2–M5).

## Run (desktop, against the real backend)

The new shell runs in Tauri via a partial override config that leaves the default
`tauri.conf.json` (pointed at `frontend/`) untouched:

```bash
# from the repo root
./frontend/node_modules/.bin/tauri dev --config src-tauri/tauri.workspace.conf.json
```

This starts the workspace dev server (vite, port 5174) and launches the desktop window.

## Verify

```bash
cd workspace
npm install
npm run build        # tsc + vite, must be clean
npx vitest run       # lib/verdict + lib/squarify unit checks
```

The original app is unaffected: `cd frontend && npm run build` and the default
`tauri.conf.json` are unchanged.
