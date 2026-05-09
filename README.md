# Birds Eye

Birds Eye is an offline desktop disk space intelligence app. It scans local folders, persists an SQLite index, and presents storage usage through a fast dashboard with treemap exploration, media/category rollups, largest files, indexed search, and duplicate candidates.

## What Works

- Native Tauri desktop shell with folder picker.
- Rust parallel filesystem scanner with cancellation and symlink-safe traversal.
- SQLite index with files, folders, scan sessions, extension stats, media rollups, duplicate groups, and scan history.
- Incremental rescan behavior that marks missing files deleted and rebuilds projections.
- Multi-stage duplicate detection by size, partial hash, and full hash.
- React dashboard with native background scan progress, canvas treemap, drilldown navigation, file search, duplicate detail preview, and browser preview fallback.
- Offline-first behavior: files stay local and indexes are stored under the app data directory.

## Run

Frontend preview:

```powershell
cd frontend
npm run dev -- --host 127.0.0.1
```

Desktop dev shell:

```powershell
cd frontend
npm run tauri:dev
```

Build the desktop executable:

```powershell
cd frontend
npm run tauri:build:app
```

The executable is produced at:

```text
src-tauri/target/release/birds-eye-desktop.exe
```

Full installer bundling with `npm run tauri:build` may require WiX to be available locally on Windows.

## Verify

```powershell
cargo test
cargo check --manifest-path src-tauri\Cargo.toml
cd frontend
npm run build
```

## Project Layout

- `src/scanner/` - Rust filesystem scanner and progress events.
- `src/index/` - SQLite schema, index writer, rollups, search, duplicate details.
- `src/native/` - Tauri-shaped DTO and background job APIs.
- `src-tauri/` - Desktop shell and Tauri commands.
- `frontend/src/` - React dashboard, worker fallback, native client bridge, canvas treemap.
- `docs/` - Architecture notes and original product guide.

## Known Packaging Note

The app currently builds a runnable desktop executable. Installer generation is intentionally separate because Windows MSI bundling depends on the WiX toolchain or a successful WiX download.
