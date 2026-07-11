# Bird's Eye — Workspace frontend

The React frontend realizing the **Synthesis** design in `docs/goal/`: one persistent workspace,
three lenses (Treemap · Board · Results), a command spine, and a shared Inspector + Cleanup Tray.
This is the only frontend; `src/bridge/` holds the typed Tauri bridge (`nativeClient.ts`,
`domain.ts`), aliased as `@bridge`.

## The loop

> scan → enable intelligence → enrich → inspect (why / verdict / reclaimable) → stage →
> Review & clean (recycle bin) → Undo / restore from Library

All of it is wired to the real backend — no mock data. With intelligence off, the treemap is
size-only and verdicts read "Enable intelligence"; nothing is invented.

## Run

```powershell
npm install
npm run tauri:dev    # desktop shell (vite on 5174 + Rust backend)
npm run dev          # browser-only preview (native calls resolve to empty states)
```

## Verify

```powershell
npm run build        # tsc + vite, must be clean
npx vitest run       # unit tests (verdict mapping, squarify, intent routing, icicle, discoveries)
```

## Layout

- `src/components/` — the shell and its panels; one file per design region.
- `src/state/` — `workspaceStore` (selection, tray, nav), `indexData` (fetch layer),
  `scanController` (scan queue).
- `src/hooks/` — scan job and enable-intelligence flows.
- `src/lib/` — pure logic with tests (verdicts, squarify, intent parsing, folder tree).
- `src/bridge/` — the typed Tauri command bridge (`@bridge` alias).
