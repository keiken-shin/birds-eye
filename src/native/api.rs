use crate::index::IndexWriter;
use crate::scanner::{ScanEvent, ScanOptions, Scanner};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

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

#[derive(Debug, Clone, Deserialize)]
pub struct IndexQueryRequest {
    pub index_path: PathBuf,
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
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct IndexOverviewDto {
    pub folders: Vec<FolderSummaryDto>,
    pub files: Vec<FileSummaryDto>,
    pub extensions: Vec<ExtensionSummaryDto>,
    pub duplicate_groups: Vec<DuplicateGroupSummaryDto>,
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
            })
            .collect(),
    })
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
}

