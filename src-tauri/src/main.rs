use birds_eye::native::api::{
    index_metadata, refresh_index_paths as refresh_native_index_paths,
    validate_cleanup_files as validate_native_cleanup_files,
    duplicate_group_files as query_duplicate_group_files, query_index_overview,
    search_files as search_index_files, DuplicateFileSummaryDto, DuplicateGroupFilesRequest,
    FileSearchResultDto, IndexMetadataDto, IndexOverviewDto, IndexQueryRequest,
    RefreshIndexPathsRequest, RefreshIndexPathsResponse, ScanToIndexRequest, ScanToIndexResponse,
    SearchFilesRequest, ValidateCleanupFilesRequest, ValidateCleanupFilesResponse,
};
use birds_eye::native::{
    JobEventDto, JobStatusDto, ScanJobManager, StartScanJobRequest, StartScanJobResponse,
};
use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

struct AppState {
    jobs: Mutex<ScanJobManager>,
}

#[derive(Debug, Serialize)]
struct RecycleFilesResponse {
    moved: usize,
}

#[tauri::command]
fn scan_to_index(request: ScanToIndexRequest) -> Result<ScanToIndexResponse, String> {
    birds_eye::native::api::scan_to_index(request)
}

#[tauri::command]
fn query_index(request: IndexQueryRequest) -> Result<IndexOverviewDto, String> {
    query_index_overview(request)
}

#[tauri::command]
fn search_files(request: SearchFilesRequest) -> Result<Vec<FileSearchResultDto>, String> {
    search_index_files(request)
}

#[tauri::command]
fn duplicate_group_files(
    request: DuplicateGroupFilesRequest,
) -> Result<Vec<DuplicateFileSummaryDto>, String> {
    query_duplicate_group_files(request)
}

#[tauri::command]
fn refresh_index_paths(
    request: RefreshIndexPathsRequest,
) -> Result<RefreshIndexPathsResponse, String> {
    refresh_native_index_paths(request)
}

#[tauri::command]
fn validate_cleanup_files(
    request: ValidateCleanupFilesRequest,
) -> Result<ValidateCleanupFilesResponse, String> {
    validate_native_cleanup_files(request)
}

#[tauri::command]
fn list_indexes(app: tauri::AppHandle) -> Result<Vec<IndexMetadataDto>, String> {
    let index_dir = index_dir(&app)?;
    let mut entries = Vec::new();
    if !index_dir.exists() {
        return Ok(entries);
    }

    for entry in fs::read_dir(index_dir).map_err(|error| format!("failed to read index directory: {error}"))? {
        let entry = entry.map_err(|error| format!("failed to read index entry: {error}"))?;
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) == Some("sqlite") {
            if let Ok(metadata) = index_metadata(path) {
                entries.push(metadata);
            }
        }
    }

    entries.sort_by(|a, b| b.last_scanned_at.cmp(&a.last_scanned_at));
    Ok(entries)
}

#[tauri::command]
fn delete_index(app: tauri::AppHandle, index_path: PathBuf) -> Result<(), String> {
    let index_dir = index_dir(&app)?;
    let canonical_dir = index_dir
        .canonicalize()
        .map_err(|error| format!("failed to resolve index directory: {error}"))?;
    let canonical_index = index_path
        .canonicalize()
        .map_err(|error| format!("failed to resolve index path: {error}"))?;

    if !canonical_index.starts_with(canonical_dir) {
        return Err("refusing to delete an index outside the app index directory".to_owned());
    }

    fs::remove_file(canonical_index).map_err(|error| format!("failed to delete index: {error}"))
}

#[tauri::command]
fn reveal_path(path: PathBuf) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        fn normalize_explorer_path(path: PathBuf) -> PathBuf {
            let raw = path.to_string_lossy();
            if let Some(stripped) = raw.strip_prefix(r"\\?\UNC\") {
                return PathBuf::from(format!(r"\\{}", stripped));
            }
            if let Some(stripped) = raw.strip_prefix(r"\\?\") {
                return PathBuf::from(stripped);
            }
            path
        }

        let mut command = Command::new("explorer.exe");
        let resolved = normalize_explorer_path(path.canonicalize().unwrap_or(path));
        let looks_like_file = resolved.is_file() || resolved.extension().is_some();
        if looks_like_file {
            command.arg("/select,").arg(resolved);
        } else {
            command.arg(resolved);
        }
        command
            .spawn()
            .map_err(|error| format!("failed to open Explorer: {error}"))?;
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|error| format!("failed to open file manager: {error}"))?;
        Ok(())
    }
}

#[tauri::command]
fn recycle_files(paths: Vec<PathBuf>) -> Result<RecycleFilesResponse, String> {
    if paths.is_empty() {
        return Ok(RecycleFilesResponse { moved: 0 });
    }

    for path in &paths {
        if !path.exists() {
            return Err(format!("file does not exist: {}", path.display()));
        }
        if path.is_dir() {
            return Err(format!("refusing to recycle a directory from staged cleanup: {}", path.display()));
        }
    }

    recycle_paths(&paths)?;
    Ok(RecycleFilesResponse { moved: paths.len() })
}

#[cfg(target_os = "windows")]
fn recycle_paths(paths: &[PathBuf]) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::null_mut;
    use winapi::um::shellapi::{
        SHFileOperationW, FO_DELETE, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT,
        SHFILEOPSTRUCTW,
    };

    let mut encoded_paths = Vec::new();
    for path in paths {
        encoded_paths.extend(path.as_os_str().encode_wide());
        encoded_paths.push(0);
    }
    encoded_paths.push(0);

    let mut operation = SHFILEOPSTRUCTW {
        hwnd: null_mut(),
        wFunc: FO_DELETE as u32,
        pFrom: encoded_paths.as_ptr(),
        pTo: null_mut(),
        fFlags: FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT,
        fAnyOperationsAborted: 0,
        hNameMappings: null_mut(),
        lpszProgressTitle: null_mut(),
    };

    let result = unsafe { SHFileOperationW(&mut operation) };
    if result != 0 {
        return Err(format!("Recycle Bin operation failed with code {result}"));
    }
    if operation.fAnyOperationsAborted != 0 {
        return Err("Recycle Bin operation was aborted".to_owned());
    }

    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn recycle_paths(_paths: &[PathBuf]) -> Result<(), String> {
    Err("safe recycle-bin cleanup is currently implemented for Windows only".to_owned())
}

#[tauri::command]
fn start_scan_job(
    state: tauri::State<'_, AppState>,
    request: StartScanJobRequest,
) -> Result<StartScanJobResponse, String> {
    let jobs = state
        .jobs
        .lock()
        .map_err(|_| "job manager lock poisoned".to_owned())?;
    jobs.start_scan_job(request)
}

#[derive(Debug, Serialize)]
struct StartScanJobForRootResponse {
    job_id: u64,
    index_path: PathBuf,
}

#[tauri::command]
fn start_scan_job_for_root(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    root: PathBuf,
) -> Result<StartScanJobForRootResponse, String> {
    let index_path = default_index_path(&app, &root)?;
    let jobs = state
        .jobs
        .lock()
        .map_err(|_| "job manager lock poisoned".to_owned())?;
    let event_app = app.clone();
    let response = jobs.start_scan_job_with_listener(
        StartScanJobRequest {
            root,
            index_path: index_path.clone(),
        },
        Some(Arc::new(move |event| {
            let _ = event_app.emit("scan-job-event", event);
        })),
    )?;

    Ok(StartScanJobForRootResponse {
        job_id: response.job_id,
        index_path,
    })
}

#[tauri::command]
fn cancel_scan_job(state: tauri::State<'_, AppState>, job_id: u64) -> Result<(), String> {
    let jobs = state
        .jobs
        .lock()
        .map_err(|_| "job manager lock poisoned".to_owned())?;
    jobs.cancel_job(job_id)
}

#[tauri::command]
fn scan_job_events(
    state: tauri::State<'_, AppState>,
    job_id: u64,
    offset: usize,
) -> Result<Vec<JobEventDto>, String> {
    let jobs = state
        .jobs
        .lock()
        .map_err(|_| "job manager lock poisoned".to_owned())?;
    jobs.job_events_since(job_id, offset)
}

#[tauri::command]
fn scan_job_status(state: tauri::State<'_, AppState>, job_id: u64) -> Result<JobStatusDto, String> {
    let jobs = state
        .jobs
        .lock()
        .map_err(|_| "job manager lock poisoned".to_owned())?;
    jobs.job_status(job_id)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            jobs: Mutex::new(ScanJobManager::new()),
        })
        .invoke_handler(tauri::generate_handler![
            scan_to_index,
            query_index,
            search_files,
            duplicate_group_files,
            refresh_index_paths,
            validate_cleanup_files,
            list_indexes,
            delete_index,
            reveal_path,
            recycle_files,
            start_scan_job,
            start_scan_job_for_root,
            cancel_scan_job,
            scan_job_events,
            scan_job_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running Birds Eye desktop shell");
}

fn default_index_path(app: &tauri::AppHandle, root: &Path) -> Result<PathBuf, String> {
    let index_dir = index_dir(app)?;
    fs::create_dir_all(&index_dir)
        .map_err(|error| format!("failed to create index directory: {error}"))?;

    let mut hasher = DefaultHasher::new();
    root.hash(&mut hasher);
    let root_hash = hasher.finish();
    Ok(index_dir.join(format!("{root_hash:016x}.sqlite")))
}

fn index_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve app data dir: {error}"))?
        .join("indexes"))
}
