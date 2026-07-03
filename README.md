# Bird's Eye

![logo](./docs/birds-eye-logo.svg)

*Bird's Eye* is an offline desktop app that answers the question no disk analyzer does: not just
**"what's big?"** but **"what's safe to delete, and why?"**

It scans local folders into a persistent SQLite index, then (optionally) runs an on-device
**intelligence layer** that classifies every folder — why it exists, whether it's regenerable, what
depends on it — and turns that into safety verdicts, reclaimable-space estimates, and a reviewed,
reversible cleanup flow. Everything runs locally. Nothing ever leaves your machine.

## The Workspace

One persistent shell, three lenses over the same index:

- **Treemap** — squarified map of your storage, colored by safety verdict (safe / review /
  protected / keep), drillable to any depth.
- **Board** — findings from enrichment (derived-from / backup-of relationships) as confirmable
  cards, plus folders you pin from the Inspector. Confirm one finding, or the whole pattern.
- **Results** — the command spine ("old files", "unclassified", "regenerable", or a literal
  search) drops you here.

Around them: an **Inspector** (why it exists · related · safety verdict), a **Cleanup Tray**
(stage from any lens), and a **Review & clean** modal that re-verifies before anything moves —
to the OS recycle bin, restorable for 30 days from the Library, or instantly via the Undo toast.

## Safety model

- Nothing is deleted without an explicit review step; protected folders can never be staged.
- Cleanup goes through the recycle bin with tracked entries — every clean is restorable.
- The intelligence layer is **opt-in per index** and runs entirely on-device.
- Verdicts show their reasoning; unclassified means unclassified, never invented data.

## Run

```powershell
cd workspace
npm install
npm run tauri:dev      # dev desktop shell (vite + Rust backend)
npm run tauri:build:app  # release executable (no installer bundling)
```

The executable lands at `src-tauri/target/release/birds-eye-desktop.exe`. Full installer
bundling (`npm run tauri:build`) needs the WiX toolchain on Windows.

## Verify

```powershell
cargo test                                        # Rust: scanner, index, ontology (188 tests)
cargo check --manifest-path src-tauri\Cargo.toml  # desktop shell
cd workspace
npm run build                                     # tsc + vite
npx vitest run                                    # frontend unit tests
```

## Project layout

- `src/scanner/` — parallel filesystem scanner (cancellation, symlink-safe traversal).
- `src/index/` — SQLite schema, index writer, rollups, search, duplicate detection.
- `src/ontology/` — the intelligence layer: populators (heuristics, metadata extraction,
  perceptual-hash near-duplicates), discoveries, saved views, and the cleanup engine
  (plans → safety predicate → recycle-bin executor → restore).
- `src/native/` — Tauri-shaped DTOs and background job APIs.
- `src-tauri/` — desktop shell and Tauri commands.
- `workspace/` — the React frontend (`src/bridge/` is the typed Tauri bridge).
- `docs/` — architecture notes, the design comps (`docs/goal/`), and the ontology
  specs (`docs/superpowers/` — Wave 1 is shipped; the Wave 2 vision is post-release).

## Motivation

I have a scattered external storage drive, can't find what I need, and what I have. And it was a
trigger to my fake OCD too. Need to organize the drive but didn't know where to start. A live
visualizer turns that chaos into a clear battle plan. A start.

## License

MIT — see [LICENSE](./LICENSE).
