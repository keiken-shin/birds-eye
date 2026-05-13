use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime};

#[derive(Debug, Clone)]
pub struct ScanOptions {
    pub root: PathBuf,
    pub workers: usize,
}

impl ScanOptions {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        let workers = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .clamp(2, 32);

        Self {
            root: root.into(),
            workers,
        }
    }
}

#[derive(Debug, Clone)]
pub struct FileRecord {
    pub path: PathBuf,
    pub parent: PathBuf,
    pub name: String,
    pub extension: Option<String>,
    pub size: u64,
    pub modified: Option<SystemTime>,
    pub accessed: Option<SystemTime>,
    pub created: Option<SystemTime>,
}

#[derive(Debug, Clone)]
pub struct FolderRecord {
    pub path: PathBuf,
    pub direct_files: u64,
    pub direct_bytes: u64,
}

#[derive(Debug, Clone)]
pub struct ScanStats {
    pub files_scanned: u64,
    pub folders_scanned: u64,
    pub bytes_scanned: u64,
    pub inaccessible_entries: u64,
    pub queue_depth: usize,
    pub active_workers: usize,
    pub elapsed: Duration,
    pub files_per_sec: f64,
    pub bytes_per_sec: f64,
    pub current_path: Option<PathBuf>,
}

impl ScanStats {
    pub fn empty() -> Self {
        Self {
            files_scanned: 0,
            folders_scanned: 0,
            bytes_scanned: 0,
            inaccessible_entries: 0,
            queue_depth: 0,
            active_workers: 0,
            elapsed: Duration::ZERO,
            files_per_sec: 0.0,
            bytes_per_sec: 0.0,
            current_path: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ScanReport {
    pub root: PathBuf,
    pub stats: ScanStats,
    pub started_at: Instant,
    pub finished_at: Instant,
    pub cancelled: bool,
}

#[derive(Debug, Clone)]
pub struct ScanError {
    pub path: PathBuf,
    pub message: String,
}

#[derive(Debug, Clone)]
pub enum ScanEvent {
    Started { root: PathBuf, workers: usize },
    FolderIndexed(FolderRecord),
    FileIndexed(FileRecord),
    Error(ScanError),
    Progress(ScanStats),
    Finished(ScanReport),
    Cancelled(ScanStats),
}
