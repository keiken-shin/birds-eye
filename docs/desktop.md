# Desktop Shell

The Tauri shell lives in `src-tauri/` and wraps the Rust scanner/index modules.

Useful commands from `frontend/`:

```powershell
npm run tauri:dev
npm run tauri:build
```

Current desktop behavior:

- Uses the native folder picker through `@tauri-apps/plugin-dialog`.
- Starts persisted background scans through `start_scan_job`.
- Polls buffered scan job events through `scan_job_events`.
- Queries the SQLite index through `query_index`.
- Browser preview still falls back to the File API worker.

The current index file is created as `.birds-eye.sqlite` inside the selected folder. This is simple for development; production should move indexes into app data storage and map scan roots to index records.

