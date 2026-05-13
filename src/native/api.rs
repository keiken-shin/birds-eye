use crate::index::{FileSearchFilters, IndexWriter};
use crate::scanner::{ScanEvent, ScanOptions, Scanner};
use regex::Regex;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone, Deserialize)]
pub struct ScanToIndexRequest {
    pub root: PathBuf,
    pub index_path: PathBuf,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ScanToIndexResponse {
    pub files_scanned: u64,
    pub folders_scanned: u64,
    pub bytes_scanned: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RefreshIndexPathsResponse {
    pub refreshed: usize,
    pub deleted: usize,
}

#[derive(Debug, Clone, Deserialize)]
pub struct IndexQueryRequest {
    pub index_path: PathBuf,
    pub limit: usize,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SearchFilesRequest {
    pub index_path: PathBuf,
    pub query: String,
    pub limit: usize,
    pub extension: Option<String>,
    pub media_kind: Option<String>,
    pub min_size: Option<i64>,
    pub max_size: Option<i64>,
    pub regex: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DuplicateGroupFilesRequest {
    pub index_path: PathBuf,
    pub group_id: i64,
    pub limit: usize,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RefreshIndexPathsRequest {
    pub index_path: PathBuf,
    pub paths: Vec<PathBuf>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CleanupFileExpectation {
    pub path: PathBuf,
    pub size: i64,
    pub modified_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ValidateCleanupFilesRequest {
    pub files: Vec<CleanupFileExpectation>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CleanupFileValidationResult {
    pub path: PathBuf,
    pub status: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ValidateCleanupFilesResponse {
    pub can_commit: bool,
    pub results: Vec<CleanupFileValidationResult>,
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
    pub folder_count: i64,
    pub dominant_media_kind: String,
    pub reclaimable_bytes: i64,
    pub confidence: f64,
    pub cleanup_score: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DuplicateFileSummaryDto {
    pub id: i64,
    pub path: String,
    pub name: String,
    pub folder_path: String,
    pub size: i64,
    pub modified_at: Option<i64>,
    pub extension: Option<String>,
    pub media_kind: String,
    pub hash_match_type: String,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DuplicateOverlapSummaryDto {
    pub folder_a: String,
    pub folder_b: String,
    pub shared_groups: i64,
    pub shared_files: i64,
    pub reclaimable_bytes: i64,
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
pub struct IndexOverviewDto {
    pub folders: Vec<FolderSummaryDto>,
    pub files: Vec<FileSummaryDto>,
    pub timeline_files: Vec<FileSummaryDto>,
    pub extensions: Vec<ExtensionSummaryDto>,
    pub duplicate_groups: Vec<DuplicateGroupSummaryDto>,
    pub duplicate_overlaps: Vec<DuplicateOverlapSummaryDto>,
    pub media: Vec<MediaSummaryDto>,
    pub folder_media: Vec<FolderMediaSummaryDto>,
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
}

pub fn scan_to_index(request: ScanToIndexRequest) -> Result<ScanToIndexResponse, String> {
    let scanner = Scanner::new(ScanOptions::new(request.root));
    let events = scanner.scan();
    let mut writer = IndexWriter::open(request.index_path).map_err(|error| format!("{error:?}"))?;

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
        timeline_files: writer
            .timeline_files(request.limit.min(500))
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
                folder_count: group.folder_count,
                dominant_media_kind: group.dominant_media_kind,
                reclaimable_bytes: group.reclaimable_bytes,
                confidence: group.confidence,
                cleanup_score: group.cleanup_score,
            })
            .collect(),
        duplicate_overlaps: writer
            .duplicate_overlaps(request.limit)
            .map_err(|error| format!("{error:?}"))?
            .into_iter()
            .map(|overlap| DuplicateOverlapSummaryDto {
                folder_a: overlap.folder_a,
                folder_b: overlap.folder_b,
                shared_groups: overlap.shared_groups,
                shared_files: overlap.shared_files,
                reclaimable_bytes: overlap.reclaimable_bytes,
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
    })
}

pub fn search_files(request: SearchFilesRequest) -> Result<Vec<FileSearchResultDto>, String> {
    let writer = IndexWriter::open(request.index_path).map_err(|error| format!("{error:?}"))?;
    let use_regex = request.regex.unwrap_or(false);
    let regex = if use_regex && !request.query.trim().is_empty() {
        Some(Regex::new(&request.query).map_err(|error| format!("invalid regex: {error}"))?)
    } else {
        None
    };
    let query = if use_regex {
        String::new()
    } else {
        request.query
    };
    let limit = if use_regex {
        request.limit.saturating_mul(50).max(request.limit)
    } else {
        request.limit
    };
    let results = writer
        .search_files_with_filters(
            FileSearchFilters {
                query,
                extension: request.extension,
                media_kind: request.media_kind,
                min_size: request.min_size,
                max_size: request.max_size,
            },
            limit,
        )
        .map_err(|error| format!("{error:?}"))?
        .into_iter()
        .filter(|file| {
            regex
                .as_ref()
                .map(|regex| regex.is_match(&file.name) || regex.is_match(&file.path))
                .unwrap_or(true)
        })
        .take(request.limit)
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
            id: file.id,
            path: file.path,
            name: file.name,
            folder_path: file.folder_path,
            size: file.size,
            modified_at: file.modified_at,
            extension: file.extension,
            media_kind: file.media_kind,
            hash_match_type: file.hash_match_type,
            confidence: file.confidence,
        })
        .collect::<Vec<_>>();

    Ok(results)
}

pub fn refresh_index_paths(
    request: RefreshIndexPathsRequest,
) -> Result<RefreshIndexPathsResponse, String> {
    let mut writer = IndexWriter::open(request.index_path).map_err(|error| format!("{error:?}"))?;
    let summary = writer
        .refresh_paths(&request.paths)
        .map_err(|error| format!("{error:?}"))?;

    Ok(RefreshIndexPathsResponse {
        refreshed: summary.refreshed,
        deleted: summary.deleted,
    })
}

pub fn validate_cleanup_files(
    request: ValidateCleanupFilesRequest,
) -> Result<ValidateCleanupFilesResponse, String> {
    let results = request
        .files
        .into_iter()
        .map(validate_cleanup_file)
        .collect::<Vec<_>>();
    let can_commit = results.iter().all(|result| result.status == "valid");

    Ok(ValidateCleanupFilesResponse {
        can_commit,
        results,
    })
}

fn validate_cleanup_file(expectation: CleanupFileExpectation) -> CleanupFileValidationResult {
    let stale = |reason: &str| CleanupFileValidationResult {
        path: expectation.path.clone(),
        status: "stale".to_owned(),
        reason: Some(reason.to_owned()),
    };

    let metadata = match fs::metadata(&expectation.path) {
        Ok(metadata) => metadata,
        Err(_) => return stale("file no longer exists"),
    };

    if !metadata.is_file() {
        return stale("path is no longer a file");
    }

    if metadata.len() as i64 != expectation.size {
        return stale("size changed since scan");
    }

    let current_modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs() as i64);
    if expectation.modified_at.is_some() && current_modified != expectation.modified_at {
        return stale("modified timestamp changed since scan");
    }

    CleanupFileValidationResult {
        path: expectation.path,
        status: "valid".to_owned(),
        reason: None,
    }
}

pub fn index_metadata(index_path: PathBuf) -> Result<IndexMetadataDto, String> {
    let writer = IndexWriter::open(index_path.clone()).map_err(|error| format!("{error:?}"))?;
    let metadata = writer
        .connection()
        .query_row(
            "SELECT root_path, status, COALESCE(finished_at, started_at), files_scanned, folders_scanned, bytes_scanned
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
    }))
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
        })
        .expect("scan command failed");
        let overview = query_index_overview(IndexQueryRequest {
            index_path,
            limit: 5,
        })
        .expect("query command failed");

        assert_eq!(response.files_scanned, 2);
        assert_eq!(overview.files.len(), 2);
        assert_eq!(overview.duplicate_groups.len(), 1);
        let duplicate_group = overview
            .duplicate_groups
            .first()
            .expect("duplicate group summary");
        assert_eq!(duplicate_group.folder_count, 1);
        assert_eq!(duplicate_group.dominant_media_kind, "other");
        assert!(duplicate_group.cleanup_score > duplicate_group.reclaimable_bytes as f64);
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
        })
        .expect("scan command failed");

        let results = search_files(SearchFilesRequest {
            index_path,
            query: "report".to_owned(),
            limit: 10,
            extension: None,
            media_kind: None,
            min_size: None,
            max_size: None,
            regex: None,
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
    fn command_shaped_file_search_filters_and_regex() {
        let root = test_root("native-filtered-search");
        let index_path = root.join("index.sqlite");
        fs::create_dir_all(root.join("data")).expect("failed to create folders");
        write_file(&root.join("data").join("clip-2024.mp4"), &[1; 128]);
        write_file(&root.join("data").join("clip-2023.txt"), &[2; 32]);

        scan_to_index(ScanToIndexRequest {
            root: root.join("data"),
            index_path: index_path.clone(),
        })
        .expect("scan command failed");

        let results = search_files(SearchFilesRequest {
            index_path,
            query: "clip-[0-9]{4}".to_owned(),
            limit: 10,
            extension: Some("mp4".to_owned()),
            media_kind: Some("video".to_owned()),
            min_size: Some(100),
            max_size: None,
            regex: Some(true),
        })
        .expect("filtered regex search command failed");

        assert_eq!(results.len(), 1);
        assert_eq!(
            results.first().map(|file| file.name.as_str()),
            Some("clip-2024.mp4")
        );
        cleanup(&root);
    }

    #[test]
    fn command_shaped_duplicate_group_files() {
        let root = test_root("native-duplicate-files");
        let index_path = root.join("index.sqlite");
        let data = root.join("data");
        let photos = data.join("PhoneBackup_2022");
        fs::create_dir_all(&photos).expect("failed to create folders");
        write_file(&photos.join("one.jpg"), &[1; 48]);
        write_file(&photos.join("two.jpg"), &[1; 48]);

        scan_to_index(ScanToIndexRequest {
            root: data.clone(),
            index_path: index_path.clone(),
        })
        .expect("scan command failed");
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
        let first = files.first().expect("first duplicate file");
        assert!(first.id > 0);
        assert_eq!(first.name, "one.jpg");
        assert_eq!(first.folder_path, path_to_str(&photos));
        assert_eq!(first.extension.as_deref(), Some("jpg"));
        assert_eq!(first.media_kind, "photo");
        assert_eq!(first.hash_match_type, "full hash");
        assert_eq!(first.confidence, 1.0);
        cleanup(&root);
    }

    #[test]
    fn command_shaped_refresh_index_paths_removes_deleted_duplicate() {
        let root = test_root("native-refresh-paths");
        let index_path = root.join("index.sqlite");
        let data = root.join("data");
        let keep = data.join("keep.bin");
        let remove = data.join("remove.bin");
        fs::create_dir_all(&data).expect("failed to create folders");
        write_file(&keep, &[1; 48]);
        write_file(&remove, &[1; 48]);

        scan_to_index(ScanToIndexRequest {
            root: data.clone(),
            index_path: index_path.clone(),
        })
        .expect("scan command failed");
        fs::remove_file(&remove).expect("failed to remove duplicate");

        let refresh = refresh_index_paths(RefreshIndexPathsRequest {
            index_path: index_path.clone(),
            paths: vec![remove],
        })
        .expect("refresh paths command failed");
        let overview = query_index_overview(IndexQueryRequest {
            index_path,
            limit: 5,
        })
        .expect("query command failed");

        assert_eq!(refresh.deleted, 1);
        assert_eq!(overview.files.len(), 1);
        assert_eq!(
            overview.files.first().map(|file| file.path.as_str()),
            Some(path_to_str(&keep))
        );
        assert!(overview.duplicate_groups.is_empty());
        assert_eq!(
            overview.folders.first().map(|folder| folder.total_bytes),
            Some(48)
        );
        cleanup(&root);
    }

    #[test]
    fn validates_cleanup_files_before_commit() {
        let root = test_root("native-precommit-validation");
        fs::create_dir_all(&root).expect("failed to create folders");
        let stable = root.join("stable.bin");
        let changed = root.join("changed.bin");
        let missing = root.join("missing.bin");
        write_file(&stable, &[1; 16]);
        write_file(&changed, &[2; 24]);

        let stable_modified = file_modified_seconds(&stable);
        let changed_modified = file_modified_seconds(&changed);
        fs::remove_file(&missing).ok();

        let response = validate_cleanup_files(ValidateCleanupFilesRequest {
            files: vec![
                CleanupFileExpectation {
                    path: stable.clone(),
                    size: 16,
                    modified_at: stable_modified,
                },
                CleanupFileExpectation {
                    path: changed.clone(),
                    size: 16,
                    modified_at: changed_modified,
                },
                CleanupFileExpectation {
                    path: missing.clone(),
                    size: 12,
                    modified_at: None,
                },
            ],
        })
        .expect("validation failed");

        assert!(!response.can_commit);
        assert_eq!(response.results[0].status, "valid");
        assert_eq!(response.results[1].status, "stale");
        assert_eq!(response.results[1].reason.as_deref(), Some("size changed since scan"));
        assert_eq!(response.results[2].status, "stale");
        assert_eq!(response.results[2].reason.as_deref(), Some("file no longer exists"));
        cleanup(&root);
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

    fn path_to_str(path: &std::path::Path) -> &str {
        path.to_str().expect("test paths should be valid utf-8")
    }

    fn file_modified_seconds(path: &std::path::Path) -> Option<i64> {
        path.metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs() as i64)
    }
}
