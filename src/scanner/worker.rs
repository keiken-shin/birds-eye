use super::types::{
    FileRecord, FolderRecord, ScanError, ScanEvent, ScanOptions, ScanReport, ScanStats,
};
use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug)]
struct SharedQueue {
    inner: Mutex<VecDeque<PathBuf>>,
    ready: Condvar,
}

impl SharedQueue {
    fn new(root: PathBuf) -> Self {
        let mut queue = VecDeque::new();
        queue.push_back(root);

        Self {
            inner: Mutex::new(queue),
            ready: Condvar::new(),
        }
    }

    fn push(&self, path: PathBuf) {
        let mut queue = self.inner.lock().expect("queue lock poisoned");
        queue.push_back(path);
        self.ready.notify_one();
    }

    fn len(&self) -> usize {
        self.inner.lock().expect("queue lock poisoned").len()
    }
}

#[derive(Debug)]
struct SharedStats {
    files_scanned: AtomicU64,
    folders_scanned: AtomicU64,
    bytes_scanned: AtomicU64,
    inaccessible_entries: AtomicU64,
    active_workers: AtomicUsize,
    current_path: Mutex<Option<PathBuf>>,
}

impl SharedStats {
    fn new() -> Self {
        Self {
            files_scanned: AtomicU64::new(0),
            folders_scanned: AtomicU64::new(0),
            bytes_scanned: AtomicU64::new(0),
            inaccessible_entries: AtomicU64::new(0),
            active_workers: AtomicUsize::new(0),
            current_path: Mutex::new(None),
        }
    }

    fn snapshot(&self, queue_depth: usize, started_at: Instant) -> ScanStats {
        let elapsed = started_at.elapsed();
        let seconds = elapsed.as_secs_f64().max(0.001);
        let files_scanned = self.files_scanned.load(Ordering::Relaxed);
        let bytes_scanned = self.bytes_scanned.load(Ordering::Relaxed);

        ScanStats {
            files_scanned,
            folders_scanned: self.folders_scanned.load(Ordering::Relaxed),
            bytes_scanned,
            inaccessible_entries: self.inaccessible_entries.load(Ordering::Relaxed),
            queue_depth,
            active_workers: self.active_workers.load(Ordering::Relaxed),
            elapsed,
            files_per_sec: files_scanned as f64 / seconds,
            bytes_per_sec: bytes_scanned as f64 / seconds,
            current_path: self.current_path.lock().ok().and_then(|path| path.clone()),
        }
    }
}

#[derive(Clone, Debug)]
pub struct ScanController {
    cancelled: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
}

impl ScanController {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
    }

    pub fn pause(&self) {
        self.paused.store(true, Ordering::Relaxed);
    }

    pub fn resume(&self) {
        self.paused.store(false, Ordering::Relaxed);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }
}

#[derive(Debug)]
pub struct Scanner {
    options: ScanOptions,
    controller: ScanController,
}

impl Scanner {
    pub fn new(options: ScanOptions) -> Self {
        Self {
            options,
            controller: ScanController {
                cancelled: Arc::new(AtomicBool::new(false)),
                paused: Arc::new(AtomicBool::new(false)),
            },
        }
    }

    pub fn controller(&self) -> ScanController {
        self.controller.clone()
    }

    pub fn scan(self) -> Receiver<ScanEvent> {
        let (events_tx, events_rx) = mpsc::channel();
        let options = self.options;
        let controller = self.controller;

        thread::spawn(move || {
            run_scan(options, controller, events_tx);
        });

        events_rx
    }
}

fn run_scan(options: ScanOptions, controller: ScanController, events_tx: Sender<ScanEvent>) {
    let started_at = Instant::now();
    let queue = Arc::new(SharedQueue::new(options.root.clone()));
    let stats = Arc::new(SharedStats::new());

    let _ = events_tx.send(ScanEvent::Started {
        root: options.root.clone(),
        workers: options.workers,
    });

    let mut handles = Vec::with_capacity(options.workers);

    for worker_id in 0..options.workers {
        let worker = WorkerContext {
            id: worker_id,
            queue: Arc::clone(&queue),
            stats: Arc::clone(&stats),
            events_tx: events_tx.clone(),
            cancelled: Arc::clone(&controller.cancelled),
            paused: Arc::clone(&controller.paused),
            started_at,
        };

        handles.push(thread::spawn(move || worker.run()));
    }

    drop(events_tx.clone());

    loop {
        thread::sleep(Duration::from_millis(250));
        let snapshot = stats.snapshot(queue.len(), started_at);
        let _ = events_tx.send(ScanEvent::Progress(snapshot.clone()));

        if controller.cancelled.load(Ordering::Relaxed) {
            let _ = events_tx.send(ScanEvent::Cancelled(snapshot));
            queue.ready.notify_all();
            break;
        }

        if snapshot.queue_depth == 0 && snapshot.active_workers == 0 {
            let finished_at = Instant::now();
            let report = ScanReport {
                root: options.root.clone(),
                stats: snapshot,
                started_at,
                finished_at,
                cancelled: false,
            };
            let _ = events_tx.send(ScanEvent::Finished(report));
            queue.ready.notify_all();
            break;
        }
    }

    for handle in handles {
        let _ = handle.join();
    }
}

struct WorkerContext {
    id: usize,
    queue: Arc<SharedQueue>,
    stats: Arc<SharedStats>,
    events_tx: Sender<ScanEvent>,
    cancelled: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    started_at: Instant,
}

impl WorkerContext {
    fn run(&self) {
        loop {
            if self.cancelled.load(Ordering::Relaxed) {
                break;
            }

            while self.paused.load(Ordering::Relaxed) && !self.cancelled.load(Ordering::Relaxed) {
                thread::sleep(Duration::from_millis(100));
            }

            self.stats.active_workers.fetch_add(1, Ordering::Relaxed);
            let next_dir = self.next_directory();

            let Some(dir) = next_dir else {
                self.stats.active_workers.fetch_sub(1, Ordering::Relaxed);
                if self.queue.len() == 0 && self.stats.active_workers.load(Ordering::Relaxed) == 0 {
                    break;
                }
                thread::sleep(Duration::from_millis(25));
                continue;
            };

            if let Ok(mut current) = self.stats.current_path.lock() {
                *current = Some(dir.clone());
            }
            self.scan_directory(&dir);
            self.stats.active_workers.fetch_sub(1, Ordering::Relaxed);
        }
    }

    fn next_directory(&self) -> Option<PathBuf> {
        let mut queue = self.queue.inner.lock().expect("queue lock poisoned");
        queue.pop_front()
    }

    fn scan_directory(&self, dir: &Path) {
        let read_dir = match fs::read_dir(dir) {
            Ok(read_dir) => read_dir,
            Err(error) => {
                self.stats
                    .inaccessible_entries
                    .fetch_add(1, Ordering::Relaxed);
                let _ = self.events_tx.send(ScanEvent::Error(ScanError {
                    path: dir.to_path_buf(),
                    message: error.to_string(),
                }));
                return;
            }
        };

        let mut direct_files = 0;
        let mut direct_bytes = 0;

        for entry in read_dir {
            if self.cancelled.load(Ordering::Relaxed) {
                break;
            }

            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    self.stats
                        .inaccessible_entries
                        .fetch_add(1, Ordering::Relaxed);
                    let _ = self.events_tx.send(ScanEvent::Error(ScanError {
                        path: dir.to_path_buf(),
                        message: error.to_string(),
                    }));
                    continue;
                }
            };

            let path = entry.path();
            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(error) => {
                    self.stats
                        .inaccessible_entries
                        .fetch_add(1, Ordering::Relaxed);
                    let _ = self.events_tx.send(ScanEvent::Error(ScanError {
                        path,
                        message: error.to_string(),
                    }));
                    continue;
                }
            };

            if metadata.file_type().is_symlink() {
                continue;
            }

            if metadata.is_dir() {
                self.queue.push(path);
                continue;
            }

            if metadata.is_file() {
                direct_files += 1;
                direct_bytes += metadata.len();
                self.stats.files_scanned.fetch_add(1, Ordering::Relaxed);
                self.stats
                    .bytes_scanned
                    .fetch_add(metadata.len(), Ordering::Relaxed);

                let record = FileRecord {
                    parent: dir.to_path_buf(),
                    name: entry.file_name().to_string_lossy().into_owned(),
                    extension: path
                        .extension()
                        .and_then(|ext| ext.to_str())
                        .map(|ext| ext.to_ascii_lowercase()),
                    path,
                    size: metadata.len(),
                    modified: metadata.modified().ok(),
                    accessed: metadata.accessed().ok(),
                    created: metadata.created().ok(),
                };

                let _ = self.events_tx.send(ScanEvent::FileIndexed(record));
            }
        }

        self.stats.folders_scanned.fetch_add(1, Ordering::Relaxed);
        let _ = self.events_tx.send(ScanEvent::FolderIndexed(FolderRecord {
            path: dir.to_path_buf(),
            direct_files,
            direct_bytes,
        }));

        if self.id == 0 {
            let snapshot = self.stats.snapshot(self.queue.len(), self.started_at);
            let _ = self.events_tx.send(ScanEvent::Progress(snapshot));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, File};
    use std::io::Write;

    #[test]
    fn scanner_indexes_nested_files_and_folders() {
        let root = test_root("nested");
        let nested = root.join("media").join("photos");
        fs::create_dir_all(&nested).expect("failed to create test folders");
        write_file(&root.join("readme.txt"), b"hello");
        write_file(&nested.join("image.raw"), &[0; 128]);

        let scanner = Scanner::new(ScanOptions {
            root: root.clone(),
            workers: 2,
        });
        let events = scanner.scan();

        let mut files = 0;
        let mut folders = 0;
        let mut total_bytes = 0;

        for event in events {
            match event {
                ScanEvent::FileIndexed(record) => {
                    files += 1;
                    total_bytes += record.size;
                }
                ScanEvent::FolderIndexed(_) => folders += 1,
                ScanEvent::Finished(report) => {
                    assert_eq!(report.stats.files_scanned, 2);
                    assert_eq!(report.stats.bytes_scanned, 133);
                    break;
                }
                ScanEvent::Error(error) => panic!("unexpected scan error: {error:?}"),
                _ => {}
            }
        }

        assert_eq!(files, 2);
        assert!(folders >= 3);
        assert_eq!(total_bytes, 133);
        cleanup(&root);
    }

    #[test]
    fn controller_can_cancel_scan() {
        let root = test_root("cancel");
        fs::create_dir_all(&root).expect("failed to create test folder");
        for index in 0..200 {
            write_file(&root.join(format!("file-{index}.bin")), &[1; 64]);
        }

        let scanner = Scanner::new(ScanOptions {
            root: root.clone(),
            workers: 2,
        });
        let controller = scanner.controller();
        let events = scanner.scan();
        controller.cancel();

        let mut saw_terminal_event = false;
        for event in events {
            if matches!(event, ScanEvent::Cancelled(_) | ScanEvent::Finished(_)) {
                saw_terminal_event = true;
                break;
            }
        }

        assert!(saw_terminal_event);
        cleanup(&root);
    }

    fn test_root(name: &str) -> PathBuf {
        let root = std::env::current_dir()
            .expect("failed to get current dir")
            .join("target")
            .join("scanner-tests")
            .join(format!(
                "{}-{}",
                name,
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .expect("clock before epoch")
                    .as_nanos()
            ));
        cleanup(&root);
        root
    }

    fn write_file(path: &Path, bytes: &[u8]) {
        let mut file = File::create(path).expect("failed to create test file");
        file.write_all(bytes).expect("failed to write test file");
    }

    fn cleanup(root: &Path) {
        if root.exists() {
            fs::remove_dir_all(root).expect("failed to remove test folder");
        }
    }
}
