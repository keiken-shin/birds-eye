# Desktop Shell

The Tauri shell lives in `src-tauri/` and wraps the Rust scanner/index modules.

Useful commands from `frontend/`:

```powershell
npm run tauri:dev
npm run tauri:build:app
npm run tauri:build
```

Current desktop behavior:

- Uses the native folder picker through `@tauri-apps/plugin-dialog`.
- Starts persisted background scans through `start_scan_job`.
- Polls buffered scan job events through `scan_job_events`.
- Queries the SQLite index through `query_index`.
- Browser preview still falls back to the File API worker.

Index files are created under the app data directory in an `indexes/` folder, keyed by the selected root path.

`npm run tauri:build:app` compiles the desktop executable without producing installer bundles. On Windows, `npm run tauri:build` may need WiX available locally for MSI generation.
