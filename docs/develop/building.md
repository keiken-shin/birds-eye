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

## Platform support

Bird's Eye ships for **Windows 10 and 11 (x64)**. That is a distribution decision, not an
architectural one — the Rust core, the Tauri shell and the workspace all build on macOS and Linux
today, and the platform-specific code is properly gated rather than assumed.

What is genuinely Windows-only right now:

| Feature | Elsewhere |
|---|---|
| Drive list on the scan screen (`src/native/drives.rs`) | Returns an empty list. Scanning a path you type or pick still works; only the "pick a drive" shortcut is missing. |
| Naming the process holding a locked file (Restart Manager) | Not available. A locked file is still reported, just without saying which program has it. |

Everything else already branches per platform — `reveal_in_explorer` calls `explorer.exe`,
`open -R` and the Linux file manager respectively, and the Recycle Bin path goes through the
`trash` crate, which speaks Trash on Linux and macOS too.

### Why there are no macOS or Linux downloads yet

Not a technical blocker — a distribution one, and the three platforms are not equally hard:

- **Linux** needs no signing at all. An AppImage, a `.deb` or a tarball can be published as-is, and
  Flathub costs nothing. This is the cheapest platform to add and nothing is standing in the way
  except the drive-list gap above and the work of setting up the build.
- **macOS** can be distributed unsigned — the user right-clicks and chooses *Open*, or clears the
  quarantine attribute — but Gatekeeper will warn them first, and Homebrew Cask installs carry the
  same friction. Removing that warning means notarisation, which requires the Apple Developer
  Program at $99/year. For a free MIT project that is a real cost with no revenue behind it, so
  the honest position is: unsigned builds are possible and documented friction is acceptable;
  paying for notarisation is not currently planned.
- **Windows** is already solved. The Microsoft Store signs the uploaded MSIX, so no certificate is
  needed (see [Releasing](releasing.md)).

If you want Bird's Eye on macOS or Linux now, build it from source with the steps above — the
toolchain is the same. Contributions that close the drive-list gap or add a Linux packaging target
are welcome.

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
src/            Rust core — scanner, index, native boundary, ontology (the analysis)
src-tauri/      Tauri desktop shell and commands
workspace/      React 19 + Tailwind 4 frontend (bridge/, dev/, components/ui/)
scripts/        build tooling (e.g. build-msix.ps1)
docs/           this documentation site (markdown)
docs-site/      the generator that renders docs/ into site/
```

A deeper walkthrough of each layer is in [Architecture](architecture.md).
