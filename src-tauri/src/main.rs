// Hide the console window on Windows release builds (keep it in debug for logs/panics).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use birds_eye::native::api::{
    index_metadata,
    duplicate_group_files as query_duplicate_group_files, query_index_overview,
    folder_children as query_folder_children,
    scan_issues as query_scan_issues, ScanIssueDto, ScanIssuesRequest,
    retry_scan_issues as do_retry_scan_issues, RetryScanIssuesRequest, RetryScanIssuesResponse,
    file_lock_holders as query_file_lock_holders, FileLockHoldersRequest,
    search_files as search_index_files,
    reveal_in_explorer as do_reveal_in_explorer,
    trash_files as do_trash_files,
    TrashFilesRequest, TrashFilesResponse,
    // Plan 3 cleanup
    cleanup_plan as do_cleanup_plan, execute_cleanup_plan as do_execute_cleanup_plan,
    recently_cleaned_log as do_recently_cleaned_log,
    restore_from_cleanup_log as do_restore_from_cleanup_log,
    pin_file as do_pin_file, unpin_file as do_unpin_file,
    // Staging desk (durable)
    stage_item as do_stage_item, unstage_item as do_unstage_item,
    staged_items as do_staged_items, set_staged_group as do_set_staged_group,
    clear_staged as do_clear_staged,
    StageItemRequest, UnstageItemRequest, StagedItemsRequest, SetStagedGroupRequest,
    ClearStagedRequest,
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
    FileSearchResultDto, FolderChildrenRequest, FolderSummaryDto, IndexMetadataDto,
    IndexOverviewDto, IndexQueryRequest, SearchFilesRequest,
    // Cataloging
    relocation_plan as do_relocation_plan,
    execute_relocation_plan as do_execute_relocation_plan,
    relocation_members as do_relocation_members,
    catalog_rules as do_catalog_rules,
    save_catalog_rule as do_save_catalog_rule,
    delete_catalog_rule as do_delete_catalog_rule,
    recently_moved_log as do_recently_moved_log,
    restore_from_relocation_log as do_restore_from_relocation_log,
    CatalogRulesRequest, DeleteCatalogRuleRequest, ExecuteRelocationPlanRequest,
    RecentlyMovedRequest, RelocationMembersRequest, RelocationPlanRequest,
    RelocationPlanResponse, RestoreMoveRequest, SaveCatalogRuleRequest,
    // Drives (first-run drive picker)
    list_fixed_drives as query_fixed_drives,
};
use birds_eye::native::drives::DriveInfoDto;
use birds_eye::ontology::cleanup::executor::CleanupResult;
use birds_eye::ontology::catalog::relocation_log::RelocationLogEntry;
use birds_eye::ontology::cleanup::restore::CleanupLogEntry;
use birds_eye::ontology::cleanup::CleanupCandidate;
use birds_eye::ontology::discoveries::Discovery;
use birds_eye::ontology::saved_views::{SavedView, SavedViewRow};
use birds_eye::native::{
    JobEventDto, JobStatusDto, ScanJobManager, StartScanJobRequest, StartScanJobResponse,
};
use birds_eye::scanner::SshSource;
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
fn folder_children(request: FolderChildrenRequest) -> Result<Vec<FolderSummaryDto>, String> {
    query_folder_children(request)
}

#[tauri::command(async)]
fn scan_issues(request: ScanIssuesRequest) -> Result<Vec<ScanIssueDto>, String> {
    query_scan_issues(request)
}

#[tauri::command(async)]
fn retry_scan_issues(request: RetryScanIssuesRequest) -> Result<RetryScanIssuesResponse, String> {
    do_retry_scan_issues(request)
}

#[tauri::command(async)]
fn file_lock_holders(request: FileLockHoldersRequest) -> Result<Vec<String>, String> {
    query_file_lock_holders(request)
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
    enable_intelligence: Option<bool>,
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
            enable_intelligence,
            ssh: None,
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

/// Trims trailing '/' so "/srv/" and "/srv" hash and store identically — the
/// scanner already does this internally, but the index filename hash and the
/// stored source JSON see the raw root unless it's normalized here first.
fn normalize_ssh_root(root: &str) -> String {
    let trimmed = root.trim_end_matches('/');
    if trimmed.is_empty() {
        "/".to_owned()
    } else {
        trimmed.to_owned()
    }
}

/// Server-side validation for an SSH source — the frontend validates too, but this
/// command is the authoritative boundary. Rejects anything that could be read as an
/// ssh(1) option (a destination starting with '-') before it ever reaches a shell-out.
fn validate_ssh_source(source: &SshSource) -> Result<(), String> {
    let destination = source.destination.trim();
    if destination.starts_with('-') {
        return Err("host can't start with '-' — enter user@host or an SSH config name".to_owned());
    }
    let chars_ok = !destination.is_empty()
        && destination
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '@' | '-'));
    if !chars_ok {
        return Err("enter the host as user@host or an SSH config name".to_owned());
    }
    if !source.root.starts_with('/') {
        return Err("enter the remote folder as an absolute path, e.g. /home/user".to_owned());
    }
    if source.port == Some(0) {
        return Err("port must be between 1 and 65535".to_owned());
    }
    Ok(())
}

fn ssh_index_file_name(source: &SshSource) -> String {
    let mut hasher = DefaultHasher::new();
    "ssh".hash(&mut hasher);
    source.destination.hash(&mut hasher);
    source.port.hash(&mut hasher);
    source.root.hash(&mut hasher);
    format!("{:016x}.sqlite", hasher.finish())
}

#[tauri::command(async)]
fn start_scan_job_for_ssh(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    source: SshSource,
    scan_strategy: Option<String>,
    enable_intelligence: Option<bool>,
) -> Result<StartScanJobForRootResponse, String> {
    let source = SshSource {
        destination: source.destination.trim().to_owned(),
        root: normalize_ssh_root(&source.root),
        ..source
    };
    validate_ssh_source(&source)?;

    let index_path = index_dir(&app).and_then(|dir| {
        fs::create_dir_all(&dir).map_err(|e| format!("failed to create index directory: {e}"))?;
        Ok(dir.join(ssh_index_file_name(&source)))
    })?;
    let jobs = state
        .jobs
        .lock()
        .map_err(|_| "job manager lock poisoned".to_owned())?;
    let event_app = app.clone();
    let response = jobs.start_scan_job_with_listener(
        StartScanJobRequest {
            root: PathBuf::from(&source.root),
            index_path: index_path.clone(),
            scan_strategy,
            enable_intelligence,
            ssh: Some(source),
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

/// User-override removal: recycle-bin delete for paths the safety predicate
/// holds back. Only ever invoked from the Review gate's explicit consent flow.
#[tauri::command(async)]
fn trash_files(request: TrashFilesRequest) -> TrashFilesResponse {
    do_trash_files(request)
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
fn relocation_plan(request: RelocationPlanRequest) -> Result<RelocationPlanResponse, String> {
    do_relocation_plan(request)
}

#[tauri::command(async)]
fn execute_relocation_plan(
    request: ExecuteRelocationPlanRequest,
) -> Result<birds_eye::ontology::catalog::executor::RelocationResult, String> {
    do_execute_relocation_plan(request)
}

#[tauri::command(async)]
fn relocation_members(
    request: RelocationMembersRequest,
) -> Result<Vec<birds_eye::ontology::catalog::payload::RelocationMember>, String> {
    do_relocation_members(request)
}

#[tauri::command(async)]
fn catalog_rules(
    request: CatalogRulesRequest,
) -> Result<Vec<birds_eye::ontology::catalog::rules::CatalogRule>, String> {
    do_catalog_rules(request)
}

#[tauri::command(async)]
fn save_catalog_rule(request: SaveCatalogRuleRequest) -> Result<i64, String> {
    do_save_catalog_rule(request)
}

#[tauri::command(async)]
fn delete_catalog_rule(request: DeleteCatalogRuleRequest) -> Result<(), String> {
    do_delete_catalog_rule(request)
}

#[tauri::command(async)]
fn recently_cleaned(request: RecentlyCleanedRequest) -> Result<Vec<CleanupLogEntry>, String> {
    do_recently_cleaned_log(request)
}

#[tauri::command(async)]
fn restore_from_cleanup_log(request: RestoreCleanupRequest) -> Result<(), String> {
    do_restore_from_cleanup_log(request)
}

/// The durable half of undo for moves: what was moved, and putting it back.
#[tauri::command(async)]
fn recently_moved(request: RecentlyMovedRequest) -> Result<Vec<RelocationLogEntry>, String> {
    do_recently_moved_log(request)
}

#[tauri::command(async)]
fn restore_from_relocation_log(request: RestoreMoveRequest) -> Result<(), String> {
    do_restore_from_relocation_log(request)
}

#[tauri::command(async)]
fn stage_item(request: StageItemRequest) -> Result<(), String> {
    do_stage_item(request)
}

#[tauri::command(async)]
fn unstage_item(request: UnstageItemRequest) -> Result<(), String> {
    do_unstage_item(request)
}

#[tauri::command(async)]
fn staged_items(
    request: StagedItemsRequest,
) -> Result<Vec<birds_eye::ontology::staging::StagedItem>, String> {
    do_staged_items(request)
}

#[tauri::command(async)]
fn set_staged_group(request: SetStagedGroupRequest) -> Result<(), String> {
    do_set_staged_group(request)
}

#[tauri::command(async)]
fn clear_staged(request: ClearStagedRequest) -> Result<(), String> {
    do_clear_staged(request)
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

#[tauri::command(async)]
fn list_fixed_drives() -> Result<Vec<DriveInfoDto>, String> {
    query_fixed_drives()
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
            folder_children,
            scan_issues,
            retry_scan_issues,
            file_lock_holders,
            duplicate_group_files,
            list_indexes,
            delete_index,
            start_scan_job,
            start_scan_job_for_root,
            start_scan_job_for_ssh,
            cancel_scan_job,
            scan_job_events,
            scan_job_status,
            allow_preview_root,
            reveal_in_explorer,
            // ---- user-file mutation: these five, and only these five ----
            // The list continues past them with reads and app-DB writes, so this
            // is a label on five names rather than on everything below.
            //
            // The four plan commands are structurally gated: nothing is removed
            // or moved except through a persisted plan the backend re-verifies
            // at execute time, and each leaves a restore-log row. `trash_files`
            // takes paths directly — its gate is the review UI, and its undo is
            // the Recycle Bin. Adding a sixth is a review topic.
            //
            // `delete_index` is deliberately not counted: it removes an
            // app-owned index file, never the person's own files.
            trash_files,
            cleanup_plan,
            execute_cleanup_plan,
            relocation_plan,
            execute_relocation_plan,
            // ---- end user-file mutation ----
            relocation_members,
            catalog_rules,
            save_catalog_rule,
            delete_catalog_rule,
            recently_cleaned,
            restore_from_cleanup_log,
            recently_moved,
            restore_from_relocation_log,
            pin_file,
            unpin_file,
            stage_item,
            unstage_item,
            staged_items,
            set_staged_group,
            clear_staged,
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
            list_fixed_drives,
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

#[cfg(test)]
mod ssh_source_tests {
    use super::*;

    #[test]
    fn ssh_index_filename_differs_from_local_and_is_stable() {
        let a = ssh_index_file_name(&SshSource { destination: "u@h".into(), port: Some(2222), root: "/home/u".into() });
        let b = ssh_index_file_name(&SshSource { destination: "u@h2".into(), port: Some(2222), root: "/home/u".into() });
        assert_ne!(a, b);
        assert_eq!(a, ssh_index_file_name(&SshSource { destination: "u@h".into(), port: Some(2222), root: "/home/u".into() }));
        assert!(a.ends_with(".sqlite"));
    }

    #[test]
    fn padded_destination_hashes_and_stores_same_as_trimmed() {
        // start_scan_job_for_ssh trims `destination` the same way it normalizes `root` before
        // hashing/storing it — pin that a padded destination collapses to the trimmed identity.
        let padded = SshSource { destination: " anubhav@localhost ".into(), port: Some(2222), root: "/home/anubhav".into() };
        let trimmed = SshSource { destination: "anubhav@localhost".into(), ..padded.clone() };
        let as_command_sees_it = SshSource { destination: padded.destination.trim().to_owned(), ..padded };

        assert_eq!(as_command_sees_it.destination, trimmed.destination);
        assert_eq!(ssh_index_file_name(&as_command_sees_it), ssh_index_file_name(&trimmed));
    }

    #[test]
    fn normalize_ssh_root_trims_trailing_slashes_but_keeps_bare_slash() {
        assert_eq!(normalize_ssh_root("/srv/"), "/srv");
        assert_eq!(normalize_ssh_root("/"), "/");
    }

    #[test]
    fn validate_ssh_source_rejects_bad_input() {
        let base = SshSource {
            destination: "anubhav@localhost".into(),
            port: Some(2222),
            root: "/home/anubhav".into(),
        };

        assert!(validate_ssh_source(&SshSource { destination: "-oProxyCommand=x".into(), ..base.clone() }).is_err());
        assert!(validate_ssh_source(&SshSource { destination: "bad host".into(), ..base.clone() }).is_err());
        assert!(validate_ssh_source(&SshSource { destination: "".into(), ..base.clone() }).is_err());
        assert!(validate_ssh_source(&SshSource { root: "srv/data".into(), ..base.clone() }).is_err());
        assert!(validate_ssh_source(&SshSource { port: Some(0), ..base.clone() }).is_err());
    }

    #[test]
    fn validate_ssh_source_accepts_good_input() {
        let base = SshSource {
            destination: "anubhav@localhost".into(),
            port: Some(2222),
            root: "/home/anubhav".into(),
        };

        assert!(validate_ssh_source(&base).is_ok());
        assert!(validate_ssh_source(&SshSource { port: None, ..base.clone() }).is_ok());
    }
}
