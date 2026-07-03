use birds_eye::native::api::{
    index_metadata,
    duplicate_group_files as query_duplicate_group_files, query_index_overview,
    search_files as search_index_files,
    reveal_in_explorer as do_reveal_in_explorer,
    // Plan 3 cleanup
    cleanup_plan as do_cleanup_plan, execute_cleanup_plan as do_execute_cleanup_plan,
    recently_cleaned_log as do_recently_cleaned_log,
    restore_from_cleanup_log as do_restore_from_cleanup_log,
    pin_file as do_pin_file, unpin_file as do_unpin_file,
    list_cleanup_candidates as do_list_cleanup_candidates,
    treemap_lens_data as do_treemap_lens_data,
    CleanupPlanRequest, CleanupPlanResponse, ExecuteCleanupPlanRequest,
    RecentlyCleanedRequest, RestoreCleanupRequest, PinFileRequest, UnpinFileRequest,
    // Plan 4 discoveries / saved views / provenance / toggle
    discoveries as do_discoveries,
    confirm_discovery_cmd as do_confirm_discovery, reject_discovery_cmd as do_reject_discovery,
    confirm_discovery_pattern as do_confirm_discovery_pattern,
    reject_discovery_pattern as do_reject_discovery_pattern,
    saved_views as do_saved_views, run_saved_view_cmd as do_run_saved_view,
    file_provenance as do_file_provenance, override_classification as do_override_classification,
    ontology_status as do_ontology_status, set_ontology_enabled as do_set_ontology_enabled,
    run_ontology_enrichment as do_run_ontology_enrichment,
    DiscoveriesRequest, ResolveDiscoveryRequest, ResolveDiscoveryKindRequest,
    RunSavedViewRequest, FileProvenanceRequest, FileProvenanceDto,
    OverrideClassificationRequest, OntologyStatusRequest, OntologyStatusDto,
    RunOntologyEnrichmentRequest, RunOntologyEnrichmentResponse, SetOntologyEnabledRequest,
    TreemapLensFolderDto, TreemapLensRequest,
    DuplicateFileSummaryDto, DuplicateGroupFilesRequest,
    FileSearchResultDto, IndexMetadataDto, IndexOverviewDto, IndexQueryRequest,
    SearchFilesRequest,
};
use birds_eye::ontology::cleanup::executor::CleanupResult;
use birds_eye::ontology::cleanup::restore::CleanupLogEntry;
use birds_eye::ontology::cleanup::CleanupCandidate;
use birds_eye::ontology::discoveries::Discovery;
use birds_eye::ontology::saved_views::{SavedView, SavedViewRow};
use birds_eye::native::{
    JobEventDto, JobStatusDto, ScanJobManager, StartScanJobRequest, StartScanJobResponse,
};
use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

struct AppState {
    jobs: Mutex<ScanJobManager>,
}

#[tauri::command(async)]
fn query_index(request: IndexQueryRequest) -> Result<IndexOverviewDto, String> {
    query_index_overview(request)
}

#[tauri::command(async)]
fn search_files(request: SearchFilesRequest) -> Result<Vec<FileSearchResultDto>, String> {
    search_index_files(request)
}

#[tauri::command(async)]
fn duplicate_group_files(
    request: DuplicateGroupFilesRequest,
) -> Result<Vec<DuplicateFileSummaryDto>, String> {
    query_duplicate_group_files(request)
}

#[tauri::command(async)]
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

#[tauri::command(async)]
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

#[tauri::command(async)]
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

#[tauri::command(async)]
fn start_scan_job_for_root(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    root: PathBuf,
    scan_strategy: Option<String>,
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
            scan_strategy,
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

#[tauri::command(async)]
fn cancel_scan_job(state: tauri::State<'_, AppState>, job_id: u64) -> Result<(), String> {
    let jobs = state
        .jobs
        .lock()
        .map_err(|_| "job manager lock poisoned".to_owned())?;
    jobs.cancel_job(job_id)
}

#[tauri::command(async)]
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

#[tauri::command(async)]
fn scan_job_status(state: tauri::State<'_, AppState>, job_id: u64) -> Result<JobStatusDto, String> {
    let jobs = state
        .jobs
        .lock()
        .map_err(|_| "job manager lock poisoned".to_owned())?;
    jobs.job_status(job_id)
}

#[tauri::command(async)]
fn reveal_in_explorer(path: String) -> Result<(), String> {
    do_reveal_in_explorer(path)
}

/// Allow the asset protocol to serve files under this index's scan root, so the
/// Inspector can preview media. The root is read from the index itself (which must
/// live in the app index dir) — the webview never gets to name an arbitrary path.
#[tauri::command(async)]
fn allow_preview_root(app: tauri::AppHandle, index_path: PathBuf) -> Result<String, String> {
    let index_dir = index_dir(&app)?;
    let canonical_dir = index_dir
        .canonicalize()
        .map_err(|error| format!("failed to resolve index directory: {error}"))?;
    let canonical_index = index_path
        .canonicalize()
        .map_err(|error| format!("failed to resolve index path: {error}"))?;
    if !canonical_index.starts_with(canonical_dir) {
        return Err("refusing to read an index outside the app index directory".to_owned());
    }

    let metadata = index_metadata(canonical_index)?;
    let root = metadata
        .root_path
        .ok_or_else(|| "index has no recorded scan root".to_owned())?;
    app.asset_protocol_scope()
        .allow_directory(&root, true)
        .map_err(|error| format!("failed to scope preview root: {error}"))?;
    Ok(root)
}

#[tauri::command(async)]
fn cleanup_plan(request: CleanupPlanRequest) -> Result<CleanupPlanResponse, String> {
    do_cleanup_plan(request)
}

#[tauri::command(async)]
fn execute_cleanup_plan(request: ExecuteCleanupPlanRequest) -> Result<CleanupResult, String> {
    do_execute_cleanup_plan(request)
}

#[tauri::command(async)]
fn recently_cleaned(request: RecentlyCleanedRequest) -> Result<Vec<CleanupLogEntry>, String> {
    do_recently_cleaned_log(request)
}

#[tauri::command(async)]
fn restore_from_cleanup_log(request: RestoreCleanupRequest) -> Result<(), String> {
    do_restore_from_cleanup_log(request)
}

#[tauri::command(async)]
fn pin_file(request: PinFileRequest) -> Result<(), String> {
    do_pin_file(request)
}

#[tauri::command(async)]
fn unpin_file(request: UnpinFileRequest) -> Result<(), String> {
    do_unpin_file(request)
}

#[tauri::command(async)]
fn list_cleanup_candidates(index_path: PathBuf) -> Result<Vec<CleanupCandidate>, String> {
    do_list_cleanup_candidates(index_path)
}

#[tauri::command(async)]
fn treemap_lens_data(request: TreemapLensRequest) -> Result<Vec<TreemapLensFolderDto>, String> {
    do_treemap_lens_data(request)
}

#[tauri::command(async)]
fn discoveries(request: DiscoveriesRequest) -> Result<Vec<Discovery>, String> {
    do_discoveries(request)
}

#[tauri::command(async)]
fn confirm_discovery(request: ResolveDiscoveryRequest) -> Result<(), String> {
    do_confirm_discovery(request)
}

#[tauri::command(async)]
fn reject_discovery(request: ResolveDiscoveryRequest) -> Result<(), String> {
    do_reject_discovery(request)
}

#[tauri::command(async)]
fn confirm_discovery_pattern(request: ResolveDiscoveryKindRequest) -> Result<u32, String> {
    do_confirm_discovery_pattern(request)
}

#[tauri::command(async)]
fn reject_discovery_pattern(request: ResolveDiscoveryKindRequest) -> Result<u32, String> {
    do_reject_discovery_pattern(request)
}

// infallible — the catalog is static
#[tauri::command(async)]
fn saved_views() -> Vec<SavedView> {
    do_saved_views()
}

#[tauri::command(async)]
fn run_saved_view(request: RunSavedViewRequest) -> Result<Vec<SavedViewRow>, String> {
    do_run_saved_view(request)
}

#[tauri::command(async)]
fn file_provenance(request: FileProvenanceRequest) -> Result<FileProvenanceDto, String> {
    do_file_provenance(request)
}

#[tauri::command(async)]
fn override_classification(request: OverrideClassificationRequest) -> Result<(), String> {
    do_override_classification(request)
}

#[tauri::command(async)]
fn ontology_status(request: OntologyStatusRequest) -> Result<OntologyStatusDto, String> {
    do_ontology_status(request)
}

#[tauri::command(async)]
fn set_ontology_enabled(request: SetOntologyEnabledRequest) -> Result<(), String> {
    do_set_ontology_enabled(request)
}

#[tauri::command(async)]
fn run_ontology_enrichment(
    request: RunOntologyEnrichmentRequest,
) -> Result<RunOntologyEnrichmentResponse, String> {
    do_run_ontology_enrichment(request)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            jobs: Mutex::new(ScanJobManager::new()),
        })
        .invoke_handler(tauri::generate_handler![
            query_index,
            search_files,
            duplicate_group_files,
            list_indexes,
            delete_index,
            start_scan_job,
            start_scan_job_for_root,
            cancel_scan_job,
            scan_job_events,
            scan_job_status,
            allow_preview_root,
            reveal_in_explorer,
            cleanup_plan,
            execute_cleanup_plan,
            recently_cleaned,
            restore_from_cleanup_log,
            pin_file,
            unpin_file,
            list_cleanup_candidates,
            treemap_lens_data,
            discoveries,
            confirm_discovery,
            reject_discovery,
            confirm_discovery_pattern,
            reject_discovery_pattern,
            saved_views,
            run_saved_view,
            file_provenance,
            override_classification,
            ontology_status,
            set_ontology_enabled,
            run_ontology_enrichment,
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
