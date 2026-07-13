use crate::index::writer::ScanMode;
use crate::index::IndexWriter;
use crate::ontology::attrs::{assert_attr, get_attrs, NewAssertion};
use crate::ontology::cleanup::executor::{execute_plan_with, CleanupResult, SystemTrasher, DEFAULT_RETENTION_DAYS};
use crate::ontology::cleanup::plans::{candidates_for_plan, create_plan, CleanupScope};
use crate::ontology::cleanup::predicate::list_all_candidates;
use crate::ontology::cleanup::restore::{recently_cleaned, restore_with, CleanupLogEntry, SystemRestorer};
use crate::ontology::cleanup::CleanupCandidate;
use crate::ontology::discoveries::{list_pending_by_kind, Discovery};
use crate::ontology::discoveries_resolve::{
    confirm_discoveries_by_kind, confirm_discovery, reject_discoveries_by_kind, reject_discovery,
};
use crate::ontology::enabled;
use crate::ontology::entities::{find_entity_for_file, upsert_entity};
use crate::ontology::orchestrator::run_phase2;
use crate::ontology::pinning::{pin_file as pin_file_db, unpin_file as unpin_file_db};
use crate::ontology::populators::BudgetTier;
use crate::ontology::relations::outbound;
use crate::ontology::saved_views::{list_saved_views, run_saved_view, SavedView, SavedViewRow, ViewParams};
use crate::ontology::vocabulary::{keys, predicates, EntityKind};
use crate::scanner::{ScanEvent, ScanOptions, Scanner};
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

#[derive(Debug, Clone, Deserialize)]
pub struct ScanToIndexRequest {
    pub root: PathBuf,
    pub index_path: PathBuf,
    #[serde(default)]
    pub scan_strategy: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ScanToIndexResponse {
    pub files_scanned: u64,
    pub folders_scanned: u64,
    pub bytes_scanned: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct IndexQueryRequest {
    pub index_path: PathBuf,
    pub limit: usize,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FolderChildrenRequest {
    pub index_path: PathBuf,
    pub parent_path: String,
    pub limit: usize,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SearchFilesRequest {
    pub index_path: PathBuf,
    pub query: String,
    pub limit: usize,
    #[serde(default)]
    pub extensions: Option<Vec<String>>,
    #[serde(default)]
    pub kinds: Option<Vec<String>>,
    #[serde(default)]
    pub min_bytes: Option<u64>,
    #[serde(default)]
    pub max_bytes: Option<u64>,
    #[serde(default)]
    pub use_regex: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DuplicateGroupFilesRequest {
    pub index_path: PathBuf,
    pub group_id: i64,
    pub limit: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct FolderSummaryDto {
    pub path: String,
    pub total_files: i64,
    pub total_bytes: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct FileSummaryDto {
    pub path: String,
    pub size: i64,
    pub extension: Option<String>,
    pub media_kind: String,
    pub modified_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct FileSearchResultDto {
    pub path: String,
    pub name: String,
    pub size: i64,
    pub extension: Option<String>,
    pub media_kind: String,
    pub modified_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ExtensionSummaryDto {
    pub extension: String,
    pub file_count: i64,
    pub total_bytes: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DuplicateGroupSummaryDto {
    pub id: i64,
    pub size: i64,
    pub file_count: i64,
    pub reclaimable_bytes: i64,
    pub confidence: f64,
    /// Up to a handful of member paths, largest first — lets the UI relate
    /// groups to folders and findings without a per-group fetch.
    pub sample_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DuplicateFileSummaryDto {
    pub path: String,
    pub size: i64,
    pub modified_at: Option<i64>,
    /// 0 = unresolved (size match only), 2 = sample hash, 4 = full-file XXH3
    pub hash_state: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TrashFilesRequest {
    pub paths: Vec<String>,
    /// When set, successfully trashed paths are marked deleted in this index so
    /// the UI stays honest until the next rescan.
    #[serde(default)]
    pub index_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TrashFailure {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TrashFilesResponse {
    pub failed: Vec<TrashFailure>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CleanupPlanRequest {
    pub index_path: PathBuf,
    #[serde(default)]
    pub reasons: Vec<String>,
    #[serde(default)]
    pub max_size: Option<i64>,
    #[serde(default)]
    pub path_prefix: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CleanupPlanResponse {
    pub plan_id: i64,
    pub total_files: u64,
    pub total_bytes: u64,
    pub candidates: Vec<CleanupCandidate>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ExecuteCleanupPlanRequest {
    pub index_path: PathBuf,
    pub plan_id: i64,
    #[serde(default)]
    pub retention_days: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RecentlyCleanedRequest {
    pub index_path: PathBuf,
    pub limit: u32,
    #[serde(default)]
    pub offset: u32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RestoreCleanupRequest {
    pub index_path: PathBuf,
    pub entry_id: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PinFileRequest {
    pub index_path: PathBuf,
    pub file_id: i64,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UnpinFileRequest {
    pub index_path: PathBuf,
    pub file_id: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TreemapLensRequest {
    pub index_path: PathBuf,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TreemapLensFolderDto {
    pub folder_path: String,
    pub role: Option<String>,
    pub replaceability: Option<String>,
    pub lifecycle: Option<String>,
    pub cleanup_reason: Option<String>,
    pub reclaimable_bytes: i64,
}

pub fn trash_files(request: TrashFilesRequest) -> TrashFilesResponse {
    let mut failed = Vec::new();
    let mut trashed = Vec::new();
    // We call delete() per path (not delete_all) so one failure does not abort the rest.
    for path in &request.paths {
        if let Err(error) = trash::delete(path) {
            failed.push(TrashFailure {
                path: path.clone(),
                reason: error.to_string(),
            });
        } else {
            trashed.push(path.clone());
        }
    }
    if let Some(index_path) = &request.index_path {
        mark_deleted_in_index(index_path, &trashed);
    }
    TrashFilesResponse { failed }
}

/// Best-effort: flag paths as deleted in the index so views drop them before the
/// next rescan. Rollups go slightly stale until then — the UI queues a rescan.
fn mark_deleted_in_index(index_path: &Path, paths: &[String]) {
    if paths.is_empty() {
        return;
    }
    let Ok(conn) = crate::index::open_index_connection(index_path) else {
        return;
    };
    for path in paths {
        let _ = conn.execute(
            "UPDATE files SET deleted_at = strftime('%s','now') WHERE path = ?1",
            rusqlite::params![path],
        );
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct MoveSpec {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MoveFilesRequest {
    pub moves: Vec<MoveSpec>,
    #[serde(default)]
    pub index_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct MoveFailure {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct MoveFilesResponse {
    pub moved: i64,
    pub failed: Vec<MoveFailure>,
}

/// Move files to a new location: rename when possible, copy+remove across
/// volumes. Never overwrites an existing destination. Moved sources are marked
/// deleted in the index; destinations are picked up by the next (re)scan.
pub fn move_files(request: MoveFilesRequest) -> MoveFilesResponse {
    let mut failed = Vec::new();
    let mut moved_sources = Vec::new();

    for spec in &request.moves {
        let to = Path::new(&spec.to);
        if to.exists() {
            failed.push(MoveFailure {
                path: spec.from.clone(),
                reason: "destination already exists".to_owned(),
            });
            continue;
        }
        if let Some(parent) = to.parent() {
            if let Err(error) = std::fs::create_dir_all(parent) {
                failed.push(MoveFailure {
                    path: spec.from.clone(),
                    reason: format!("cannot create destination folder: {error}"),
                });
                continue;
            }
        }
        let result = std::fs::rename(&spec.from, to).or_else(|_| {
            // Cross-volume move: copy then remove the source.
            std::fs::copy(&spec.from, to)
                .and_then(|_| std::fs::remove_file(&spec.from))
        });
        match result {
            Ok(()) => moved_sources.push(spec.from.clone()),
            Err(error) => failed.push(MoveFailure {
                path: spec.from.clone(),
                reason: error.to_string(),
            }),
        }
    }

    if let Some(index_path) = &request.index_path {
        mark_deleted_in_index(index_path, &moved_sources);
    }
    MoveFilesResponse {
        moved: moved_sources.len() as i64,
        failed,
    }
}

/// Build a draft cleanup plan from a scope and return its live candidate preview.
pub fn cleanup_plan(request: CleanupPlanRequest) -> Result<CleanupPlanResponse, String> {
    let conn = crate::index::open_index_connection(&request.index_path).map_err(|e| e.to_string())?;
    let scope = CleanupScope {
        reasons: request.reasons,
        max_size: request.max_size,
        path_prefix: request.path_prefix,
    };
    let plan_id = create_plan(&conn, &scope).map_err(|e| e.to_string())?;
    let candidates = candidates_for_plan(&conn, plan_id).map_err(|e| e.to_string())?;
    let total_files = candidates.len() as u64;
    let total_bytes = candidates.iter().map(|c| c.size.max(0) as u64).sum();
    Ok(CleanupPlanResponse {
        plan_id,
        total_files,
        total_bytes,
        candidates,
    })
}

/// Execute a previously created draft plan: recycle-bin-first, with restore log.
pub fn execute_cleanup_plan(request: ExecuteCleanupPlanRequest) -> Result<CleanupResult, String> {
    let mut conn = crate::index::open_index_connection(&request.index_path).map_err(|e| e.to_string())?;
    let retention = request.retention_days.unwrap_or(DEFAULT_RETENTION_DAYS);
    execute_plan_with(&mut conn, request.plan_id, &SystemTrasher, retention)
        .map_err(|e| e.to_string())
}

/// List the persistent "Recently Cleaned" log, newest first.
pub fn recently_cleaned_log(
    request: RecentlyCleanedRequest,
) -> Result<Vec<CleanupLogEntry>, String> {
    let conn = crate::index::open_index_connection(&request.index_path).map_err(|e| e.to_string())?;
    // Lazy retention enforcement: flip past-due entries to 'expired' whenever the
    // Library is read, so the advertised recovery window is actually honored.
    crate::ontology::cleanup::restore::expire_old_entries(&conn, crate::ontology::cleanup::unix_now())
        .map_err(|e| e.to_string())?;
    recently_cleaned(&conn, request.limit, request.offset).map_err(|e| e.to_string())
}

/// Restore a cleaned file from the recycle bin to its original path.
pub fn restore_from_cleanup_log(request: RestoreCleanupRequest) -> Result<(), String> {
    let mut conn = crate::index::open_index_connection(&request.index_path).map_err(|e| e.to_string())?;
    restore_with(&mut conn, request.entry_id, &SystemRestorer).map_err(|e| e.to_string())
}

/// Pin a file so it is permanently excluded from cleanup queues.
pub fn pin_file(request: PinFileRequest) -> Result<(), String> {
    let conn = crate::index::open_index_connection(&request.index_path).map_err(|e| e.to_string())?;
    pin_file_db(&conn, request.file_id, request.note.as_deref()).map_err(|e| e.to_string())
}

/// Remove a pin.
pub fn unpin_file(request: UnpinFileRequest) -> Result<(), String> {
    let conn = crate::index::open_index_connection(&request.index_path).map_err(|e| e.to_string())?;
    unpin_file_db(&conn, request.file_id).map_err(|e| e.to_string())
}

/// List the live cleanup candidates without creating a plan (preview/treemap feed).
pub fn list_cleanup_candidates(index_path: PathBuf) -> Result<Vec<CleanupCandidate>, String> {
    let conn = crate::index::open_index_connection(&index_path).map_err(|e| e.to_string())?;
    list_all_candidates(&conn).map_err(|e| e.to_string())
}

/// Folder-level ontology aggregates for the treemap lenses.
pub fn treemap_lens_data(request: TreemapLensRequest) -> Result<Vec<TreemapLensFolderDto>, String> {
    let conn = crate::index::open_index_connection(&request.index_path).map_err(|e| e.to_string())?;
    treemap_lens_data_for_conn(&conn).map_err(|e| e.to_string())
}

/// Every ancestor prefix of `path` (including `path` itself), longest first:
/// `a/b/c.txt` → `a/b/c.txt`, `a/b`, `a`. Handles both separators.
fn path_ancestors(path: &str) -> impl Iterator<Item = &str> {
    let mut cur = Some(path);
    std::iter::from_fn(move || {
        let out = cur?;
        cur = out.rfind(['/', '\\']).map(|i| &out[..i]).filter(|p| !p.is_empty());
        Some(out)
    })
}

fn treemap_lens_data_for_conn(conn: &Connection) -> rusqlite::Result<Vec<TreemapLensFolderDto>> {
    // Folder paths once; file rows attribute to their ancestor folders in Rust. The previous
    // SQL prefix-join (folders × files ON LIKE) was O(folders·files) — unusable on real indexes.
    let mut folder_paths = conn
        .prepare_cached("SELECT path FROM folders")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    folder_paths.sort();
    folder_paths.dedup();
    let folder_set: std::collections::HashSet<&str> =
        folder_paths.iter().map(String::as_str).collect();

    let mut role = DominantByFolder::default();
    let mut replaceability = DominantByFolder::default();
    let mut lifecycle = DominantByFolder::default();
    let mut cleanup_reason = DominantByFolder::default();
    let mut reclaimable: HashMap<String, i64> = HashMap::new();

    let mut stmt = conn.prepare_cached(
        "SELECT f.path,
                COALESCE(f.size, 0) AS size,
                (SELECT a.value FROM ontology_attrs a
                 WHERE a.entity_id = e.id AND a.key = 'role' AND a.display_in_global_views = 1
                 ORDER BY a.confidence DESC, a.asserted_at DESC LIMIT 1) AS role,
                (SELECT a.value FROM ontology_attrs a
                 WHERE a.entity_id = e.id AND a.key = 'replaceability' AND a.display_in_global_views = 1
                 ORDER BY a.confidence DESC, a.asserted_at DESC LIMIT 1) AS replaceability,
                (SELECT pa.value FROM ontology_relations r
                 JOIN ontology_entities pe ON pe.id = r.object_id AND pe.kind = 'Project'
                 JOIN ontology_attrs pa ON pa.entity_id = pe.id AND pa.key = 'lifecycle' AND pa.display_in_global_views = 1
                 WHERE r.subject_id = e.id AND r.predicate = 'partOf'
                 ORDER BY pa.confidence DESC, pa.asserted_at DESC LIMIT 1) AS lifecycle
         FROM files f
         JOIN ontology_entities e ON e.kind = 'File' AND e.linked_file_id = f.id
         WHERE f.deleted_at IS NULL",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<String>>(4)?,
        ))
    })?;

    for row in rows {
        let (file_path, size, row_role, row_replaceability, row_lifecycle) = row?;
        for ancestor in path_ancestors(&file_path) {
            if !folder_set.contains(ancestor) {
                continue;
            }
            role.add(ancestor, row_role.as_deref(), size);
            replaceability.add(ancestor, row_replaceability.as_deref(), size);
            lifecycle.add(ancestor, row_lifecycle.as_deref(), size);
        }
    }

    let mut stmt = conn.prepare_cached("SELECT path, reason, size FROM v_cleanup_candidates")?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
        ))
    })?;

    for row in rows {
        let (file_path, reason, bytes) = row?;
        for ancestor in path_ancestors(&file_path) {
            if !folder_set.contains(ancestor) {
                continue;
            }
            cleanup_reason.add(ancestor, Some(&reason), bytes);
            *reclaimable.entry(ancestor.to_owned()).or_insert(0) += bytes;
        }
    }

    Ok(folder_paths
        .into_iter()
        .map(|folder_path| TreemapLensFolderDto {
            role: role.get(&folder_path),
            replaceability: replaceability.get(&folder_path),
            lifecycle: lifecycle.get(&folder_path),
            cleanup_reason: cleanup_reason.get(&folder_path),
            reclaimable_bytes: reclaimable.get(&folder_path).copied().unwrap_or(0),
            folder_path,
        })
        .collect())
}

#[derive(Default)]
struct DominantByFolder {
    bytes: HashMap<String, HashMap<String, i64>>,
}

impl DominantByFolder {
    fn add(&mut self, folder_path: &str, value: Option<&str>, bytes: i64) {
        let Some(value) = value else {
            return;
        };
        *self
            .bytes
            .entry(folder_path.to_owned())
            .or_default()
            .entry(value.to_owned())
            .or_insert(0) += bytes.max(0);
    }

    fn get(&self, folder_path: &str) -> Option<String> {
        self.bytes.get(folder_path).and_then(|values| {
            values
                .iter()
                .max_by(|(left_value, left_bytes), (right_value, right_bytes)| {
                    left_bytes
                        .cmp(right_bytes)
                        .then_with(|| right_value.cmp(left_value))
                })
                .map(|(value, _)| value.clone())
        })
    }
}

pub fn reveal_in_explorer(path: String) -> Result<(), String> {
    let target = reveal_target_path(&path)?;

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;

        let explorer_path = windows_explorer_path(&target);
        let mut command = std::process::Command::new("explorer.exe");
        if target.is_dir() {
            command.arg(explorer_path);
        } else {
            command.raw_arg(format!("/select,\"{explorer_path}\""));
        }
        let status = command.status().map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(format!("explorer.exe exited with status {status}"));
        }
    }
    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("open")
            .arg("-R")
            .arg(&target)
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(format!("open exited with status {status}"));
        }
    }
    #[cfg(target_os = "linux")]
    {
        let open_path = if target.is_dir() {
            target
        } else {
            target
                .parent()
                .ok_or_else(|| "path has no parent directory".to_owned())?
                .to_path_buf()
        };
        let status = std::process::Command::new("xdg-open")
            .arg(&open_path)
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(format!("xdg-open exited with status {status}"));
        }
    }
    Ok(())
}

fn reveal_target_path(path: &str) -> Result<PathBuf, String> {
    // The Windows branch below interpolates the path into explorer's raw command line
    // inside quotes; a quote in the path would break out of them. No legal Windows
    // path contains one, so reject rather than escape.
    if path.contains('"') {
        return Err("path contains a quote character".to_owned());
    }
    let original = Path::new(path);
    if original.exists() {
        return Ok(original
            .canonicalize()
            .unwrap_or_else(|_| original.to_path_buf()));
    }

    original
        .parent()
        .filter(|parent| parent.exists())
        .and_then(|parent| parent.canonicalize().ok())
        .ok_or_else(|| format!("path does not exist and no existing parent could be resolved: {path}"))
}

#[cfg(target_os = "windows")]
fn windows_explorer_path(path: &Path) -> String {
    let path = path.to_string_lossy();
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = path.strip_prefix(r"\\?\") {
        return rest.to_owned();
    }
    path.into_owned()
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct MediaSummaryDto {
    pub media_kind: String,
    pub file_count: i64,
    pub total_bytes: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct FolderMediaSummaryDto {
    pub folder_path: String,
    pub media_kind: String,
    pub total_bytes: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TimelineBucketDto {
    pub bucket: String,
    pub file_count: i64,
    pub total_bytes: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AgeBucketDto {
    pub bucket: String,
    pub file_count: i64,
    pub total_bytes: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct IndexOverviewDto {
    pub folders: Vec<FolderSummaryDto>,
    pub files: Vec<FileSummaryDto>,
    pub extensions: Vec<ExtensionSummaryDto>,
    pub duplicate_groups: Vec<DuplicateGroupSummaryDto>,
    pub media: Vec<MediaSummaryDto>,
    pub folder_media: Vec<FolderMediaSummaryDto>,
    pub timeline: Vec<TimelineBucketDto>,
    pub age_buckets: Vec<AgeBucketDto>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct IndexMetadataDto {
    pub index_path: PathBuf,
    pub root_path: Option<String>,
    pub last_status: Option<String>,
    pub last_scanned_at: Option<i64>,
    pub files_scanned: i64,
    pub folders_scanned: i64,
    pub bytes_scanned: i64,
    pub scan_strategy: String,
    /// Entries the walk couldn't read (permission denied, locked) — not indexed.
    pub walk_issues: i64,
    /// Files whose content couldn't be hashed — excluded from duplicate detection.
    pub hash_issues: i64,
}

pub fn scan_to_index(request: ScanToIndexRequest) -> Result<ScanToIndexResponse, String> {
    let scanner = Scanner::new(ScanOptions::new(request.root));
    let events = scanner.scan();
    let mut writer = IndexWriter::open(request.index_path).map_err(|error| format!("{error:?}"))?;
    writer.set_scan_mode(ScanMode::from_id(
        request
            .scan_strategy
            .as_deref()
            .unwrap_or(ScanMode::default().as_id()),
    ));

    for event in events {
        writer
            .handle_event(&event)
            .map_err(|error| format!("{error:?}"))?;

        if let ScanEvent::Finished(report) = event {
            return Ok(ScanToIndexResponse {
                files_scanned: report.stats.files_scanned,
                folders_scanned: report.stats.folders_scanned,
                bytes_scanned: report.stats.bytes_scanned,
            });
        }

        if let ScanEvent::Cancelled(stats) = event {
            return Ok(ScanToIndexResponse {
                files_scanned: stats.files_scanned,
                folders_scanned: stats.folders_scanned,
                bytes_scanned: stats.bytes_scanned,
            });
        }
    }

    Err("scan ended without terminal event".to_owned())
}

pub fn folder_children(request: FolderChildrenRequest) -> Result<Vec<FolderSummaryDto>, String> {
    let writer = IndexWriter::open(request.index_path).map_err(|error| format!("{error:?}"))?;
    Ok(writer
        .folder_children(&request.parent_path, request.limit)
        .map_err(|error| format!("{error:?}"))?
        .into_iter()
        .map(|folder| FolderSummaryDto {
            path: folder.path,
            total_files: folder.total_files,
            total_bytes: folder.total_bytes,
        })
        .collect())
}

pub fn query_index_overview(request: IndexQueryRequest) -> Result<IndexOverviewDto, String> {
    let writer = IndexWriter::open(request.index_path).map_err(|error| format!("{error:?}"))?;

    Ok(IndexOverviewDto {
        folders: writer
            .largest_folders(request.limit)
            .map_err(|error| format!("{error:?}"))?
            .into_iter()
            .map(|folder| FolderSummaryDto {
                path: folder.path,
                total_files: folder.total_files,
                total_bytes: folder.total_bytes,
            })
            .collect(),
        files: writer
            .largest_files(request.limit)
            .map_err(|error| format!("{error:?}"))?
            .into_iter()
            .map(|file| FileSummaryDto {
                path: file.path,
                size: file.size,
                extension: file.extension,
                media_kind: file.media_kind,
                modified_at: file.modified_at,
            })
            .collect(),
        extensions: writer
            .extension_summaries(request.limit)
            .map_err(|error| format!("{error:?}"))?
            .into_iter()
            .map(|extension| ExtensionSummaryDto {
                extension: extension.extension,
                file_count: extension.file_count,
                total_bytes: extension.total_bytes,
            })
            .collect(),
        duplicate_groups: writer
            .duplicate_groups(request.limit)
            .map_err(|error| format!("{error:?}"))?
            .into_iter()
            .map(|group| DuplicateGroupSummaryDto {
                id: group.id,
                size: group.size,
                file_count: group.file_count,
                reclaimable_bytes: group.reclaimable_bytes,
                confidence: group.confidence,
                sample_paths: group.sample_paths,
            })
            .collect(),
        media: writer
            .media_summaries()
            .map_err(|error| format!("{error:?}"))?
            .into_iter()
            .map(|media| MediaSummaryDto {
                media_kind: media.media_kind,
                file_count: media.file_count,
                total_bytes: media.total_bytes,
            })
            .collect(),
        folder_media: writer
            .folder_media_summaries(request.limit * 6)
            .map_err(|error| format!("{error:?}"))?
            .into_iter()
            .map(|media| FolderMediaSummaryDto {
                folder_path: media.folder_path,
                media_kind: media.media_kind,
                total_bytes: media.total_bytes,
            })
            .collect(),
        timeline: writer
            .timeline_summaries(24)
            .map_err(|error| format!("{error:?}"))?
            .into_iter()
            .map(|bucket| TimelineBucketDto {
                bucket: bucket.bucket,
                file_count: bucket.file_count,
                total_bytes: bucket.total_bytes,
            })
            .collect(),
        age_buckets: writer
            .age_summaries()
            .map_err(|error| format!("{error:?}"))?
            .into_iter()
            .map(|bucket| AgeBucketDto {
                bucket: bucket.bucket,
                file_count: bucket.file_count,
                total_bytes: bucket.total_bytes,
            })
            .collect(),
    })
}

pub fn search_files(request: SearchFilesRequest) -> Result<Vec<FileSearchResultDto>, String> {
    let writer = IndexWriter::open(request.index_path).map_err(|error| format!("{error:?}"))?;
    let results = writer
        .search_files_filtered(
            &request.query,
            request.limit,
            request.extensions.as_deref(),
            request.kinds.as_deref(),
            request.min_bytes,
            request.max_bytes,
            request.use_regex.unwrap_or(false),
        )
        .map_err(|error| format!("{error:?}"))?
        .into_iter()
        .map(|file| FileSearchResultDto {
            path: file.path,
            name: file.name,
            size: file.size,
            extension: file.extension,
            media_kind: file.media_kind,
            modified_at: file.modified_at,
        })
        .collect::<Vec<_>>();

    Ok(results)
}

pub fn duplicate_group_files(
    request: DuplicateGroupFilesRequest,
) -> Result<Vec<DuplicateFileSummaryDto>, String> {
    let writer = IndexWriter::open(request.index_path).map_err(|error| format!("{error:?}"))?;
    let results = writer
        .duplicate_group_files(request.group_id, request.limit)
        .map_err(|error| format!("{error:?}"))?
        .into_iter()
        .map(|file| DuplicateFileSummaryDto {
            path: file.path,
            size: file.size,
            modified_at: file.modified_at,
            hash_state: file.hash_state,
        })
        .collect::<Vec<_>>();

    Ok(results)
}

pub fn index_metadata(index_path: PathBuf) -> Result<IndexMetadataDto, String> {
    let writer = IndexWriter::open(index_path.clone()).map_err(|error| format!("{error:?}"))?;
    let (walk_issues, hash_issues) = writer
        .scan_issue_counts()
        .map_err(|error| format!("{error:?}"))?;
    let metadata = writer
        .connection()
        .query_row(
            "SELECT root_path, status, COALESCE(finished_at, started_at), files_scanned, folders_scanned, bytes_scanned, scan_strategy
             FROM scan_sessions
             ORDER BY started_at DESC
             LIMIT 1",
            [],
            |row| {
                Ok(IndexMetadataDto {
                    index_path: index_path.clone(),
                    root_path: row.get(0)?,
                    last_status: row.get(1)?,
                    last_scanned_at: row.get(2)?,
                    files_scanned: row.get(3)?,
                    folders_scanned: row.get(4)?,
                    bytes_scanned: row.get(5)?,
                    scan_strategy: row.get(6)?,
                    walk_issues,
                    hash_issues,
                })
            },
        )
        .optional()
        .map_err(|error| format!("{error:?}"))?;

    Ok(metadata.unwrap_or(IndexMetadataDto {
        index_path,
        root_path: None,
        last_status: None,
        last_scanned_at: None,
        files_scanned: 0,
        folders_scanned: 0,
        bytes_scanned: 0,
        scan_strategy: ScanMode::default().as_id().to_owned(),
        walk_issues: 0,
        hash_issues: 0,
    }))
}

// ---- Scan issues (files the scanner couldn't read or verify) ----

#[derive(Debug, Clone, Deserialize)]
pub struct ScanIssuesRequest {
    pub index_path: PathBuf,
    pub limit: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ScanIssueDto {
    /// 'walk' — couldn't be indexed · 'hash' — couldn't be content-verified.
    pub phase: String,
    pub path: String,
    pub message: String,
}

pub fn scan_issues(request: ScanIssuesRequest) -> Result<Vec<ScanIssueDto>, String> {
    let writer = IndexWriter::open(request.index_path).map_err(|error| format!("{error:?}"))?;
    Ok(writer
        .scan_issues(request.limit as usize)
        .map_err(|error| format!("{error:?}"))?
        .into_iter()
        .map(|issue| ScanIssueDto {
            phase: issue.phase,
            path: issue.path,
            message: issue.message,
        })
        .collect())
}

// ---- Discoveries ----

#[derive(Debug, Clone, Deserialize)]
pub struct DiscoveriesRequest {
    pub index_path: PathBuf,
    pub kind: String,
    pub limit: u32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ResolveDiscoveryRequest {
    pub index_path: PathBuf,
    pub id: i64,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ResolveDiscoveryKindRequest {
    pub index_path: PathBuf,
    pub kind: String,
    #[serde(default)]
    pub reason: Option<String>,
}

pub fn discoveries(request: DiscoveriesRequest) -> Result<Vec<Discovery>, String> {
    let conn = crate::index::open_index_connection(&request.index_path).map_err(|e| e.to_string())?;
    list_pending_by_kind(&conn, &request.kind, request.limit).map_err(|e| e.to_string())
}

pub fn confirm_discovery_cmd(request: ResolveDiscoveryRequest) -> Result<(), String> {
    let conn = crate::index::open_index_connection(&request.index_path).map_err(|e| e.to_string())?;
    confirm_discovery(&conn, request.id).map_err(|e| e.to_string())
}

pub fn reject_discovery_cmd(request: ResolveDiscoveryRequest) -> Result<(), String> {
    let conn = crate::index::open_index_connection(&request.index_path).map_err(|e| e.to_string())?;
    reject_discovery(&conn, request.id, request.reason.as_deref()).map_err(|e| e.to_string())
}

pub fn confirm_discovery_pattern(request: ResolveDiscoveryKindRequest) -> Result<u32, String> {
    let conn = crate::index::open_index_connection(&request.index_path).map_err(|e| e.to_string())?;
    confirm_discoveries_by_kind(&conn, &request.kind).map_err(|e| e.to_string())
}

pub fn reject_discovery_pattern(request: ResolveDiscoveryKindRequest) -> Result<u32, String> {
    let conn = crate::index::open_index_connection(&request.index_path).map_err(|e| e.to_string())?;
    reject_discoveries_by_kind(&conn, &request.kind, request.reason.as_deref())
        .map_err(|e| e.to_string())
}

// ---- Saved views ----

#[derive(Debug, Clone, Deserialize)]
pub struct RunSavedViewRequest {
    pub index_path: PathBuf,
    pub view_id: String,
    #[serde(default)]
    pub days: Option<i64>,
    #[serde(default)]
    pub min_bytes: Option<i64>,
}

pub fn saved_views() -> Vec<SavedView> {
    list_saved_views()
}

pub fn run_saved_view_cmd(request: RunSavedViewRequest) -> Result<Vec<SavedViewRow>, String> {
    let conn = crate::index::open_index_connection(&request.index_path).map_err(|e| e.to_string())?;
    let params = ViewParams { days: request.days, min_bytes: request.min_bytes };
    run_saved_view(&conn, &request.view_id, &params).map_err(|e| e.to_string())
}

// ---- Provenance + override ----

#[derive(Debug, Clone, Deserialize)]
pub struct FileProvenanceRequest {
    pub index_path: PathBuf,
    pub file_id: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AttrFactDto {
    pub key: String,
    pub value: String,
    pub source: String,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RelationFactDto {
    pub predicate: String,
    pub object_path: Option<String>,
    pub source: String,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct FileProvenanceDto {
    pub file_id: i64,
    pub path: String,
    pub is_pinned: bool,
    pub attrs: Vec<AttrFactDto>,
    pub relations: Vec<RelationFactDto>,
}

const PROVENANCE_KEYS: &[&str] = &[keys::ROLE, keys::REPLACEABILITY, keys::SENSITIVITY, keys::ORIGIN, keys::MEDIA_TYPE, keys::LANGUAGE];
const PROVENANCE_PREDS: &[&str] = &[predicates::DERIVED_FROM, predicates::BACKUP_OF, predicates::PART_OF, predicates::IN_FOLDER];

pub fn file_provenance(request: FileProvenanceRequest) -> Result<FileProvenanceDto, String> {
    let conn = crate::index::open_index_connection(&request.index_path).map_err(|e| e.to_string())?;
    let path: String = conn
        .query_row("SELECT path FROM files WHERE id = ?1", [request.file_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let is_pinned: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM ontology_pinned_files WHERE file_id = ?1)",
            [request.file_id],
            |r| r.get::<_, i64>(0).map(|n| n != 0),
        )
        .map_err(|e| e.to_string())?;

    let mut attrs = Vec::new();
    let mut relations = Vec::new();
    if let Some(entity) = find_entity_for_file(&conn, request.file_id).map_err(|e| e.to_string())? {
        for key in PROVENANCE_KEYS {
            for a in get_attrs(&conn, entity.id, key).map_err(|e| e.to_string())? {
                attrs.push(AttrFactDto {
                    key: a.key,
                    value: a.value,
                    source: a.source,
                    confidence: a.confidence as f64,
                });
            }
        }
        for pred in PROVENANCE_PREDS {
            for r in outbound(&conn, entity.id, pred).map_err(|e| e.to_string())? {
                let object_path: Option<String> = conn
                    .query_row(
                        "SELECT f.path FROM ontology_entities oe
                         LEFT JOIN files f ON f.id = oe.linked_file_id
                         WHERE oe.id = ?1",
                        [r.object_id],
                        |row| row.get::<_, Option<String>>(0),
                    )
                    .optional()
                    .map_err(|e| e.to_string())?
                    .flatten();
                relations.push(RelationFactDto {
                    predicate: r.predicate,
                    object_path,
                    source: r.source,
                    confidence: r.confidence as f64,
                });
            }
        }
    }

    Ok(FileProvenanceDto { file_id: request.file_id, path, is_pinned, attrs, relations })
}

#[derive(Debug, Clone, Deserialize)]
pub struct OverrideClassificationRequest {
    pub index_path: PathBuf,
    pub file_id: i64,
    pub key: String,
    pub value: String,
}

pub fn override_classification(request: OverrideClassificationRequest) -> Result<(), String> {
    let conn = crate::index::open_index_connection(&request.index_path).map_err(|e| e.to_string())?;
    let entity = match find_entity_for_file(&conn, request.file_id).map_err(|e| e.to_string())? {
        Some(e) => e,
        None => {
            let path: String = conn
                .query_row("SELECT path FROM files WHERE id = ?1", [request.file_id], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            upsert_entity(&conn, EntityKind::File, &path, Some(request.file_id), None, None)
                .map_err(|e| e.to_string())?
        }
    };
    assert_attr(
        &conn,
        entity.id,
        &NewAssertion {
            key: &request.key,
            value: &request.value,
            source: "user",
            confidence: 1.0,
            display_in_global_views: true,
        },
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---- Ontology enabled toggle (per-index, §14) ----

#[derive(Debug, Clone, Deserialize)]
pub struct OntologyStatusRequest {
    pub index_path: PathBuf,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct OntologyStatusDto {
    pub enabled: bool,
    pub pending_discoveries: u64,
    /// Live files in the index — the denominator for populator progress.
    pub total_files: u64,
    /// Per-populator progress so the UI can say "enrichment incomplete" honestly
    /// instead of rendering empty findings as "nothing found".
    pub populators: Vec<PopulatorStateDto>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PopulatorStateDto {
    pub name: String,
    pub status: String,
    pub files_visited: i64,
    pub discoveries_emitted: i64,
    pub last_error: Option<String>,
}

pub fn ontology_status(request: OntologyStatusRequest) -> Result<OntologyStatusDto, String> {
    let conn = crate::index::open_index_connection(&request.index_path).map_err(|e| e.to_string())?;
    let enabled = enabled::is_enabled(&conn).map_err(|e| e.to_string())?;
    let pending_discoveries =
        crate::ontology::discoveries::count_pending(&conn).map_err(|e| e.to_string())?;
    let total_files: i64 = conn
        .query_row("SELECT COUNT(*) FROM files WHERE deleted_at IS NULL", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare_cached(
            "SELECT populator_name, status, files_visited, discoveries_emitted, last_error
             FROM ontology_populator_state ORDER BY populator_name",
        )
        .map_err(|e| e.to_string())?;
    let populators = stmt
        .query_map([], |row| {
            Ok(PopulatorStateDto {
                name: row.get(0)?,
                status: row.get(1)?,
                files_visited: row.get(2)?,
                discoveries_emitted: row.get(3)?,
                last_error: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(OntologyStatusDto {
        enabled,
        pending_discoveries,
        total_files: total_files.max(0) as u64,
        populators,
    })
}

#[derive(Debug, Clone, Deserialize)]
pub struct SetOntologyEnabledRequest {
    pub index_path: PathBuf,
    pub enabled: bool,
}

pub fn set_ontology_enabled(request: SetOntologyEnabledRequest) -> Result<(), String> {
    let conn = crate::index::open_index_connection(&request.index_path).map_err(|e| e.to_string())?;
    if request.enabled {
        enabled::enable(&conn).map_err(|e| e.to_string())
    } else {
        enabled::disable(&conn).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, File};
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn command_shaped_scan_and_query_round_trip() {
        let root = test_root("native");
        let index_path = root.join("index.sqlite");
        fs::create_dir_all(root.join("data")).expect("failed to create folders");
        write_file(&root.join("data").join("one.bin"), &[1; 24]);
        write_file(&root.join("data").join("two.bin"), &[1; 24]);

        let response = scan_to_index(ScanToIndexRequest {
            root: root.join("data"),
            index_path: index_path.clone(),
            scan_strategy: Some("smart".to_owned()),
        })
        .expect("scan command failed");
        IndexWriter::open(index_path.clone())
            .expect("failed to open index")
            .refine_duplicates()
            .expect("failed to refine duplicates");
        let overview = query_index_overview(IndexQueryRequest {
            index_path,
            limit: 5,
        })
        .expect("query command failed");

        assert_eq!(response.files_scanned, 2);
        assert_eq!(overview.files.len(), 2);
        assert_eq!(overview.duplicate_groups.len(), 1);
        assert_eq!(
            overview
                .media
                .first()
                .map(|summary| summary.media_kind.as_str()),
            Some("other")
        );
        cleanup(&root);
    }

    #[test]
    fn command_shaped_file_search() {
        let root = test_root("native-search");
        let index_path = root.join("index.sqlite");
        fs::create_dir_all(root.join("data")).expect("failed to create folders");
        write_file(&root.join("data").join("report.pdf"), &[1; 48]);
        write_file(&root.join("data").join("clip.mp4"), &[2; 64]);

        scan_to_index(ScanToIndexRequest {
            root: root.join("data"),
            index_path: index_path.clone(),
            scan_strategy: None,
        })
        .expect("scan command failed");

        let results = search_files(SearchFilesRequest {
            index_path,
            query: "report".to_owned(),
            limit: 10,
            extensions: None,
            kinds: None,
            min_bytes: None,
            max_bytes: None,
            use_regex: None,
        })
        .expect("search command failed");

        assert_eq!(
            results.first().map(|file| file.name.as_str()),
            Some("report.pdf")
        );
        assert_eq!(
            results.first().map(|file| file.media_kind.as_str()),
            Some("document")
        );
        cleanup(&root);
    }

    #[test]
    fn command_shaped_duplicate_group_files() {
        let root = test_root("native-duplicate-files");
        let index_path = root.join("index.sqlite");
        fs::create_dir_all(root.join("data")).expect("failed to create folders");
        write_file(&root.join("data").join("one.bin"), &[1; 48]);
        write_file(&root.join("data").join("two.bin"), &[1; 48]);

        scan_to_index(ScanToIndexRequest {
            root: root.join("data"),
            index_path: index_path.clone(),
            scan_strategy: None,
        })
        .expect("scan command failed");
        IndexWriter::open(index_path.clone())
            .expect("failed to open index")
            .refine_duplicates()
            .expect("failed to refine duplicates");
        let overview = query_index_overview(IndexQueryRequest {
            index_path: index_path.clone(),
            limit: 5,
        })
        .expect("query command failed");
        let group_id = overview
            .duplicate_groups
            .first()
            .expect("duplicate group")
            .id;

        let files = duplicate_group_files(DuplicateGroupFilesRequest {
            index_path,
            group_id,
            limit: 10,
        })
        .expect("duplicate group files command failed");

        assert_eq!(files.len(), 2);
        // After smart-mode refinement, files should have hash_state >= 2
        // (either sample hash=2 or full-file hash=4)
        assert!(
            files.iter().all(|f| f.hash_state == 4),
            "expected hash_state == 4 after full refinement of small files, got {:?}",
            files.iter().map(|f| f.hash_state).collect::<Vec<_>>()
        );
        cleanup(&root);
    }

    #[test]
    fn search_files_with_extension_filter() {
        let root = test_root("search-ext-filter");
        let index_path = root.join("index.sqlite");
        fs::create_dir_all(root.join("data")).expect("create dirs");
        write_file(&root.join("data").join("report.pdf"), &[1; 48]);
        write_file(&root.join("data").join("video.mp4"), &[2; 64]);

        scan_to_index(ScanToIndexRequest {
            root: root.join("data"),
            index_path: index_path.clone(),
            scan_strategy: None,
        })
        .expect("scan failed");

        let results = search_files(SearchFilesRequest {
            index_path: index_path.clone(),
            query: String::new(),
            limit: 10,
            extensions: Some(vec!["pdf".to_owned()]),
            kinds: None,
            min_bytes: None,
            max_bytes: None,
            use_regex: None,
        })
        .expect("search failed");

        assert_eq!(results.len(), 1);
        assert!(results[0].name.ends_with(".pdf"));
        cleanup(&root);
    }

    #[test]
    fn search_files_with_size_filter() {
        let root = test_root("search-size-filter");
        let index_path = root.join("index.sqlite");
        fs::create_dir_all(root.join("data")).expect("create dirs");
        write_file(&root.join("data").join("small.txt"), &[1; 10]);
        write_file(&root.join("data").join("large.txt"), &[2; 200]);

        scan_to_index(ScanToIndexRequest {
            root: root.join("data"),
            index_path: index_path.clone(),
            scan_strategy: None,
        })
        .expect("scan failed");

        let results = search_files(SearchFilesRequest {
            index_path,
            query: String::new(),
            limit: 10,
            extensions: None,
            kinds: None,
            min_bytes: Some(100),
            max_bytes: None,
            use_regex: None,
        })
        .expect("search failed");

        assert_eq!(results.len(), 1);
        assert!(results[0].name.contains("large"));
        cleanup(&root);
    }

    #[test]
    fn search_files_with_regex_query() {
        let root = test_root("search-regex");
        let index_path = root.join("index.sqlite");
        fs::create_dir_all(root.join("data")).expect("create dirs");
        write_file(&root.join("data").join("report_2024.pdf"), &[1; 48]);
        write_file(&root.join("data").join("notes.txt"), &[2; 24]);

        scan_to_index(ScanToIndexRequest {
            root: root.join("data"),
            index_path: index_path.clone(),
            scan_strategy: None,
        })
        .expect("scan failed");

        let results = search_files(SearchFilesRequest {
            index_path,
            query: r"report_\d{4}".to_owned(),
            limit: 10,
            extensions: None,
            kinds: None,
            min_bytes: None,
            max_bytes: None,
            use_regex: Some(true),
        })
        .expect("search failed");

        assert_eq!(results.len(), 1);
        assert!(results[0].name.starts_with("report_"));
        cleanup(&root);
    }

    #[test]
    fn index_metadata_returns_latest_scan_strategy() {
        let root = test_root("metadata-strategy");
        let index_path = root.join("index.sqlite");
        fs::create_dir_all(root.join("data")).expect("failed to create folders");
        write_file(&root.join("data").join("one.bin"), &[1; 48]);

        scan_to_index(ScanToIndexRequest {
            root: root.join("data"),
            index_path: index_path.clone(),
            scan_strategy: Some("metadata".to_owned()),
        })
        .expect("scan command failed");

        let metadata = index_metadata(index_path.clone()).expect("metadata");
        assert_eq!(metadata.scan_strategy, "metadata");

        {
            let writer = IndexWriter::open(&index_path).expect("open writer for verification");
            let job_count: i64 = writer
                .connection()
                .query_row("SELECT COUNT(*) FROM hash_jobs", [], |r| r.get(0))
                .expect("count hash_jobs");
            assert_eq!(
                job_count, 0,
                "MetadataOnly scan must not seed hash_jobs"
            );
        }
        cleanup(&root);
    }

    #[test]
    fn search_files_with_regex_checks_beyond_limit_window() {
        let root = test_root("search-regex-limit");
        let index_path = root.join("index.sqlite");
        fs::create_dir_all(root.join("data")).expect("create dirs");
        write_file(&root.join("data").join("large.bin"), &[1; 400]);
        write_file(&root.join("data").join("medium.bin"), &[2; 300]);
        write_file(&root.join("data").join("target_2026.txt"), &[3; 10]);

        scan_to_index(ScanToIndexRequest {
            root: root.join("data"),
            index_path: index_path.clone(),
            scan_strategy: None,
        })
        .expect("scan failed");

        let results = search_files(SearchFilesRequest {
            index_path,
            query: r"target_\d{4}".to_owned(),
            limit: 1,
            extensions: None,
            kinds: None,
            min_bytes: None,
            max_bytes: None,
            use_regex: Some(true),
        })
        .expect("search failed");

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "target_2026.txt");
        cleanup(&root);
    }

    #[test]
    fn search_files_with_invalid_regex_returns_empty_results() {
        let root = test_root("search-regex-invalid");
        let index_path = root.join("index.sqlite");
        fs::create_dir_all(root.join("data")).expect("create dirs");
        write_file(&root.join("data").join("report.pdf"), &[1; 48]);

        scan_to_index(ScanToIndexRequest {
            root: root.join("data"),
            index_path: index_path.clone(),
            scan_strategy: None,
        })
        .expect("scan failed");

        let results = search_files(SearchFilesRequest {
            index_path,
            query: "[".to_owned(),
            limit: 10,
            extensions: None,
            kinds: None,
            min_bytes: None,
            max_bytes: None,
            use_regex: Some(true),
        })
        .expect("search failed");

        assert!(results.is_empty());
        cleanup(&root);
    }

    #[test]
    fn trash_files_nonexistent_path_is_recorded_as_failure() {
        let response = trash_files(TrashFilesRequest {
            paths: vec!["/this/path/does/not/exist/xyz.bin".to_owned()],
            index_path: None,
        });
        assert_eq!(response.failed.len(), 1);
        assert_eq!(response.failed[0].path, "/this/path/does/not/exist/xyz.bin");
    }

    #[test]
    fn reveal_target_path_falls_back_to_existing_parent_for_missing_file() {
        let root = test_root("reveal-target");
        let folder = root.join("folder with spaces");
        fs::create_dir_all(&folder).expect("create dirs");
        let missing_file = folder.join("missing image.png");

        let target = reveal_target_path(&missing_file.to_string_lossy())
            .expect("missing file should resolve to existing parent");

        assert_eq!(target, folder.canonicalize().expect("canonical folder"));
        cleanup(&root);
    }

    #[test]
    fn reveal_target_path_errors_when_no_existing_target_can_be_resolved() {
        let root = test_root("reveal-missing-target");
        let missing_file = root.join("missing-folder").join("missing image.png");

        let target = reveal_target_path(&missing_file.to_string_lossy());

        assert!(target.is_err());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_explorer_path_strips_verbatim_prefixes() {
        assert_eq!(
            windows_explorer_path(Path::new(r"\\?\C:\Users\me\photo.jpg")),
            r"C:\Users\me\photo.jpg"
        );
        assert_eq!(
            windows_explorer_path(Path::new(r"\\?\UNC\server\share\photo.jpg")),
            r"\\server\share\photo.jpg"
        );
    }

    fn test_root(name: &str) -> PathBuf {
        let root = std::env::current_dir()
            .expect("failed to get current dir")
            .join("target")
            .join("native-tests")
            .join(format!(
                "{}-{}",
                name,
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .expect("clock before epoch")
                    .as_nanos()
            ));
        cleanup(&root);
        root
    }

    fn write_file(path: &std::path::Path, bytes: &[u8]) {
        let mut file = File::create(path).expect("failed to create file");
        file.write_all(bytes).expect("failed to write file");
    }

    fn cleanup(root: &std::path::Path) {
        if root.exists() {
            fs::remove_dir_all(root).expect("failed to remove test folder");
        }
    }

    #[test]
    fn cleanup_plan_api_returns_seeded_candidate() {
        use crate::index::schema::ALL_MIGRATIONS;
        use crate::ontology::attrs::{assert_attr, NewAssertion};
        use crate::ontology::entities::upsert_entity;
        use crate::ontology::vocabulary::{keys, EntityKind};
        use rusqlite::Connection;

        // Create a temp dir with an index.
        let root = std::env::temp_dir()
            .join(format!("be-cleanup-api-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let index_path = root.join("index.sqlite");

        {
            let conn = Connection::open(&index_path).unwrap();
            for (_, sql) in ALL_MIGRATIONS {
                conn.execute_batch(sql).unwrap();
            }
            conn.execute(
                "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
                 VALUES (1, NULL, '/root', 'root', 0, 0)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO files (id, folder_id, path, name, size, indexed_at)
                 VALUES (1, 1, '/root/dist/a.js', 'a.js', 100, 0)",
                [],
            )
            .unwrap();
            let eid = upsert_entity(&conn, EntityKind::File, "/root/dist/a.js", Some(1), None, None)
                .unwrap()
                .id;
            assert_attr(
                &conn,
                eid,
                &NewAssertion {
                    key: keys::ROLE,
                    value: "scratch",
                    source: "rule:test",
                    confidence: 0.95,
                    display_in_global_views: true,
                },
            )
            .unwrap();
        }

        let resp = cleanup_plan(CleanupPlanRequest {
            index_path: index_path.clone(),
            reasons: vec!["scratch".to_string()],
            max_size: None,
            path_prefix: None,
        })
        .expect("cleanup_plan");
        assert_eq!(resp.total_files, 1);
        assert_eq!(resp.total_bytes, 100);
        assert_eq!(resp.candidates[0].reason, "scratch");

        // recently_cleaned is empty until execution.
        let log = recently_cleaned_log(RecentlyCleanedRequest {
            index_path,
            limit: 10,
            offset: 0,
        })
        .expect("recently_cleaned");
        assert!(log.is_empty());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn file_provenance_and_override_round_trip() {
        use crate::index::schema::ALL_MIGRATIONS;
        use rusqlite::Connection;
        // Build a temp index file so the api functions (which open by path) work.
        let dir = std::env::temp_dir().join(format!("be_prov_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let index_path = dir.join("idx.sqlite");
        let _ = std::fs::remove_file(&index_path);
        {
            let conn = Connection::open(&index_path).unwrap();
            for (_, sql) in ALL_MIGRATIONS {
                conn.execute_batch(sql).unwrap();
            }
            conn.execute(
                "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
                 VALUES (1, NULL, '/a', 'a', 0, 0)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO files (id, folder_id, path, name, size, indexed_at, hash_state)
                 VALUES (1, 1, '/a/x.png', 'x.png', 10, 0, 4)",
                [],
            )
            .unwrap();
        }

        override_classification(OverrideClassificationRequest {
            index_path: index_path.clone(),
            file_id: 1,
            key: "role".into(),
            value: "scratch".into(),
        })
        .unwrap();

        let prov = file_provenance(FileProvenanceRequest { index_path: index_path.clone(), file_id: 1 }).unwrap();
        assert_eq!(prov.path, "/a/x.png");
        assert!(prov.attrs.iter().any(|a| a.key == "role" && a.value == "scratch" && a.source == "user"));
        assert!(!prov.is_pinned);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn treemap_lens_data_rolls_up_ontology_and_cleanup_reason() {
        use crate::index::schema::ALL_MIGRATIONS;
        use crate::ontology::attrs::{assert_attr, NewAssertion};
        use crate::ontology::entities::upsert_entity;
        use crate::ontology::relations::{assert_relation, NewRelation};
        use crate::ontology::vocabulary::{keys, predicates, EntityKind};
        use rusqlite::Connection;

        let conn = Connection::open_in_memory().unwrap();
        for (_, sql) in ALL_MIGRATIONS {
            conn.execute_batch(sql).unwrap();
        }
        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at, total_bytes)
             VALUES (1, NULL, '/root', 'root', 0, 0, 300),
                    (2, 1, '/root/work', 'work', 1, 0, 300)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, size, indexed_at)
             VALUES (1, 2, '/root/work/source.psd', 'source.psd', 200, 0),
                    (2, 2, '/root/work/export.png', 'export.png', 100, 0)",
            [],
        )
        .unwrap();

        let source = upsert_entity(&conn, EntityKind::File, "/root/work/source.psd", Some(1), None, None).unwrap();
        let derivative =
            upsert_entity(&conn, EntityKind::File, "/root/work/export.png", Some(2), None, None).unwrap();
        let project = upsert_entity(&conn, EntityKind::Project, "project:done", None, None, Some("Done")).unwrap();

        for (entity_id, key, value, confidence) in [
            (source.id, keys::ROLE, "source", 0.9),
            (derivative.id, keys::ROLE, "derivative", 0.95),
            (derivative.id, keys::REPLACEABILITY, "regenerable", 0.95),
            (project.id, keys::LIFECYCLE, "finished", 1.0),
        ] {
            assert_attr(
                &conn,
                entity_id,
                &NewAssertion {
                    key,
                    value,
                    source: "rule:test",
                    confidence,
                    display_in_global_views: true,
                },
            )
            .unwrap();
        }
        assert_relation(
            &conn,
            &NewRelation {
                subject_id: derivative.id,
                predicate: predicates::DERIVED_FROM,
                object_id: source.id,
                source: "user",
                confidence: 1.0,
            },
        )
        .unwrap();
        assert_relation(
            &conn,
            &NewRelation {
                subject_id: derivative.id,
                predicate: predicates::PART_OF,
                object_id: project.id,
                source: "user",
                confidence: 1.0,
            },
        )
        .unwrap();

        let data = treemap_lens_data_for_conn(&conn).unwrap();
        let work = data
            .iter()
            .find(|entry| entry.folder_path == "/root/work")
            .expect("work folder lens data");

        assert_eq!(work.role.as_deref(), Some("source"));
        assert_eq!(work.replaceability.as_deref(), Some("regenerable"));
        assert_eq!(work.lifecycle.as_deref(), Some("finished"));
        assert_eq!(work.cleanup_reason.as_deref(), Some("safe-derivative"));
        assert_eq!(work.reclaimable_bytes, 100);
    }

    #[test]
    fn run_ontology_enrichment_respects_budget_tiers() {
        use crate::index::schema::ALL_MIGRATIONS;
        use crate::ontology::enabled::enable;
        use crate::ontology::orchestrator::read_state;
        use rusqlite::Connection;

        let dir = std::env::temp_dir().join(format!("be_enrichment_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let image_path = dir.join("one.jpg");
        std::fs::write(&image_path, (0_u8..=127).collect::<Vec<_>>()).unwrap();
        let index_path = dir.join("idx.sqlite");

        {
            let conn = Connection::open(&index_path).unwrap();
            for (_, sql) in ALL_MIGRATIONS {
                conn.execute_batch(sql).unwrap();
            }
            enable(&conn).unwrap();
            conn.execute(
                "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
                 VALUES (1, NULL, '/root', 'root', 0, 0)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO files (id, folder_id, path, name, extension, size, indexed_at)
                 VALUES (1, 1, ?1, 'one.jpg', 'jpg', 128, 0)",
                [image_path.to_string_lossy().as_ref()],
            )
            .unwrap();
        }

        let standard = run_ontology_enrichment(RunOntologyEnrichmentRequest {
            index_path: index_path.clone(),
            budget: "standard".to_owned(),
        })
        .unwrap();
        assert!(standard.ran);
        {
            let conn = Connection::open(&index_path).unwrap();
            assert!(read_state(&conn, "MetadataExtractorPopulator").unwrap().is_some());
            assert!(read_state(&conn, "PerceptualHashPopulator").unwrap().is_none());
        }

        let all = run_ontology_enrichment(RunOntologyEnrichmentRequest {
            index_path: index_path.clone(),
            budget: "all-opt-in".to_owned(),
        })
        .unwrap();
        assert!(all.ran);
        {
            let conn = Connection::open(&index_path).unwrap();
            assert!(read_state(&conn, "PerceptualHashPopulator").unwrap().is_some());
        }

        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct RunOntologyEnrichmentRequest {
    pub index_path: PathBuf,
    pub budget: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RunOntologyEnrichmentResponse {
    pub ran: bool,
}

pub fn run_ontology_enrichment(
    request: RunOntologyEnrichmentRequest,
) -> Result<RunOntologyEnrichmentResponse, String> {
    let budget = parse_budget_tier(&request.budget)?;
    let ran = run_phase2(&request.index_path, budget, Arc::new(AtomicBool::new(false)))
        .map_err(|e| e.to_string())?;
    Ok(RunOntologyEnrichmentResponse { ran })
}

fn parse_budget_tier(value: &str) -> Result<BudgetTier, String> {
    match value {
        "cheap-only" => Ok(BudgetTier::CheapOnly),
        "standard" => Ok(BudgetTier::Standard),
        "all-opt-in" => Ok(BudgetTier::AllOptIn),
        other => Err(format!("unknown enrichment budget: {other}")),
    }
}
