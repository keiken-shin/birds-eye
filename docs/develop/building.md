# Building from source

Bird's Eye is a Rust core (`src/`) with a Tauri desktop shell (`src-tauri/`) and a
React 19 workspace (`workspace/`). You can work on the whole stack, or on the UI alone in
a plain browser.

## Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Node 20+](https://nodejs.org/)
- On Windows, the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/)

## Clone and run

```powershell
git clone https://github.com/keiken-shin/birds-eye.git
cd birds-eye/workspace
npm install
npm run tauri:dev        # dev desktop shell (Vite + Rust backend)
```

## Build a release

```powershell
npm run tauri:build:app  # release executable, no installer bundling
```

The executable lands at `src-tauri/target/release/birds-eye-desktop.exe`. Full installer
bundling (`npm run tauri:build`) needs the WiX toolchain on Windows. For the Microsoft
Store package, see [Releasing](releasing.md).

## Frontend-only development

Most UI work needs **no Rust toolchain**. The workspace runs in a plain browser against a
deterministic mock backend (`workspace/src/dev/mockBackend.ts`) seeded with realistic
fixture data:

```powershell
cd birds-eye/workspace
npm run dev              # http://localhost:5174
```

It's the same interface the desktop shell renders — just driven by fixtures instead of a
real scan. This is also how the documentation's demo and screenshots are produced.

## The scanner CLI

The Rust core ships a standalone binary for indexing without the UI:

```powershell
cargo run --bin birds-eye-scan -- <folder> --index birds-eye.sqlite
```

## Verify

Run the gates before you push:

```powershell
cargo test                                        # Rust: scanner, index, ontology (190+ tests)
cargo check --manifest-path src-tauri\Cargo.toml  # desktop shell compiles
cd workspace
npm run build                                     # tsc + vite
npx vitest run                                    # frontend unit tests
```

## Repository layout

```text
src/            Rust core — scanner, index, native boundary, ontology (intelligence)
src-tauri/      Tauri desktop shell and commands
workspace/      React 19 + Tailwind 4 frontend (bridge/, dev/, components/ui/)
scripts/        build tooling (e.g. build-msix.ps1)
docs/           this documentation site (MkDocs)
```

A deeper walkthrough of each layer is in [Architecture](architecture.md).
