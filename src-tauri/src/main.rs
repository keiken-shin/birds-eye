use birds_eye::native::api::{
    query_index_overview, IndexOverviewDto, IndexQueryRequest, ScanToIndexRequest,
    ScanToIndexResponse,
};
use birds_eye::native::{
    JobEventDto, JobStatusDto, ScanJobManager, StartScanJobRequest, StartScanJobResponse,
};
use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;

struct AppState {
    jobs: Mutex<ScanJobManager>,
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
    let response = jobs.start_scan_job(StartScanJobRequest {
        root,
        index_path: index_path.clone(),
    })?;

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
    let index_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve app data dir: {error}"))?
        .join("indexes");
    fs::create_dir_all(&index_dir)
        .map_err(|error| format!("failed to create index directory: {error}"))?;

    let mut hasher = DefaultHasher::new();
    root.hash(&mut hasher);
    let root_hash = hasher.finish();
    Ok(index_dir.join(format!("{root_hash:016x}.sqlite")))
}
