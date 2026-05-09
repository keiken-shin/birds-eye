use birds_eye::native::api::{
    query_index_overview, IndexOverviewDto, IndexQueryRequest, ScanToIndexRequest,
    ScanToIndexResponse,
};
use birds_eye::native::{
    JobEventDto, JobStatusDto, ScanJobManager, StartScanJobRequest, StartScanJobResponse,
};
use std::sync::Mutex;

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
            cancel_scan_job,
            scan_job_events,
            scan_job_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running Birds Eye desktop shell");
}
