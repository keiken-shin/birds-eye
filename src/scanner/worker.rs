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

/// The queue, and the count of directories the scan still owes an answer for.
///
/// The two live under one lock on purpose. "Is the scan finished" is a question
/// about both of them at once, and any arrangement that lets them be read
/// separately reintroduces the window this exists to close.
#[derive(Debug)]
struct QueueState {
    waiting: VecDeque<PathBuf>,
    /// Directories discovered and not yet completed. This is the whole
    /// termination condition: zero means every directory that was ever found
    /// has been walked, and no worker can produce another one, because only
    /// walking a directory produces directories.
    ///
    /// It starts at one for the root, rises before a child is queued, and falls
    /// only after a directory has been walked and its children counted. So it
    /// is never zero while work remains, which is the property the old
    /// "is the queue empty and is everyone idle" check could only observe and
    /// not guarantee.
    outstanding: usize,
}

#[derive(Debug)]
struct SharedQueue {
    inner: Mutex<QueueState>,
    ready: Condvar,
}

impl SharedQueue {
    fn new(root: PathBuf) -> Self {
        let mut waiting = VecDeque::new();
        waiting.push_back(root);

        Self {
            inner: Mutex::new(QueueState {
                waiting,
                outstanding: 1,
            }),
            ready: Condvar::new(),
        }
    }

    /// A newly discovered directory. Counted and queued under the same lock, so
    /// it exists to the termination check from the moment it exists at all.
    fn push(&self, path: PathBuf) {
        let mut state = self.inner.lock().expect("queue lock poisoned");
        state.outstanding += 1;
        state.waiting.push_back(path);
        self.ready.notify_one();
    }

    /// The next directory to walk, or `None` when there will never be another.
    ///
    /// `None` is returned only at `outstanding == 0`, which is a fact about the
    /// whole scan rather than a guess from one worker's point of view. A worker
    /// that finds the queue momentarily empty while others are still walking
    /// waits instead of deciding the scan is over -- that decision, made wrong,
    /// truncates the scan silently, which is the worst shape of failure for a
    /// tool whose answer is "here is everything on your disk".
    ///
    /// The directory comes back inside a [`DirTask`], which is what marks it
    /// complete when it is dropped. Handing back a bare path would leave the
    /// "count the children before you decrement" rule to whoever writes the
    /// loop, and that rule cannot be enforced by a test -- getting it wrong
    /// only opens a window a poll has to happen to land in.
    fn next(&self, cancelled: &AtomicBool) -> Option<DirTask<'_>> {
        let mut state = self.inner.lock().expect("queue lock poisoned");
        loop {
            if let Some(path) = state.waiting.pop_front() {
                return Some(DirTask { queue: self, path });
            }
            if state.outstanding == 0 || cancelled.load(Ordering::Relaxed) {
                return None;
            }
            // Timed, so a cancel between the check above and the wait is picked
            // up rather than slept through.
            let (next, _) = self
                .ready
                .wait_timeout(state, Duration::from_millis(50))
                .expect("queue lock poisoned");
            state = next;
        }
    }

    /// One directory walked, and every child it found already counted. Wakes
    /// everyone when this was the last one, so no worker is left waiting on a
    /// queue that will never fill again.
    ///
    /// Private, and reached only through dropping a [`DirTask`]: the count must
    /// fall exactly once per directory, and exactly when the walk of it ends.
    fn complete_one(&self) {
        let mut state = self.inner.lock().expect("queue lock poisoned");
        state.outstanding = state.outstanding.saturating_sub(1);
        if state.outstanding == 0 {
            self.ready.notify_all();
        }
    }

    fn len(&self) -> usize {
        self.inner.lock().expect("queue lock poisoned").waiting.len()
    }

    /// Directories still owed. Zero means the walk is provably complete.
    fn outstanding(&self) -> usize {
        self.inner.lock().expect("queue lock poisoned").outstanding
    }
}

/// One directory, checked out of the queue and owed back.
///
/// Dropping it is what says the walk of that directory is over, so the count
/// cannot fall while the walk is still finding children -- the ordering is a
/// property of the scope rather than of the order two statements happen to be
/// written in.
struct DirTask<'q> {
    queue: &'q SharedQueue,
    path: PathBuf,
}

impl DirTask<'_> {
    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for DirTask<'_> {
    fn drop(&mut self) {
        self.queue.complete_one();
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

    let mut last_milestone_files: u64 = 0;

    loop {
        thread::sleep(Duration::from_millis(250));
        let snapshot = stats.snapshot(queue.len(), started_at);
        let _ = events_tx.send(ScanEvent::Progress(snapshot.clone()));

        let files = snapshot.files_scanned;
        if files / 10_000 > last_milestone_files / 10_000 {
            last_milestone_files = files;
            let _ = events_tx.send(ScanEvent::Verbose {
                phase: "scan",
                message: format!(
                    "milestone files={files} elapsed={}ms",
                    started_at.elapsed().as_millis()
                ),
            });
        }

        if controller.cancelled.load(Ordering::Relaxed) {
            let _ = events_tx.send(ScanEvent::Cancelled(snapshot));
            queue.ready.notify_all();
            break;
        }

        // One question, one answer, and it does not depend on catching every
        // worker idle at the same instant.
        if queue.outstanding() == 0 {
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

            // `None` means the scan is over as a fact, not as an inference.
            // The task marks the directory complete when it goes out of scope
            // at the end of this iteration, which is after every child it found
            // has been queued and counted.
            let Some(task) = self.queue.next(&self.cancelled) else {
                break;
            };

            self.stats.active_workers.fetch_add(1, Ordering::Relaxed);
            if let Ok(mut current) = self.stats.current_path.lock() {
                *current = Some(task.path().to_path_buf());
            }
            self.scan_directory(task.path());
            self.stats.active_workers.fetch_sub(1, Ordering::Relaxed);
        }
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

        let dir_start = std::time::Instant::now();
        let _ = self.events_tx.send(ScanEvent::Verbose {
            phase: "scan",
            message: format!(
                "[worker {}] scanning dir={} queue_depth={}",
                self.id,
                crate::redact::path_token(dir),
                self.queue.len()
            ),
        });

        let mut direct_files = 0;
        let mut direct_bytes = 0;

        // One call for the whole folder. Asking per file costs about thirty
        // times as much, which is the difference between collecting identity
        // and not being able to afford it. An empty map is the honest answer
        // for a folder that will not enumerate this way; each file is asked
        // directly instead.
        let folder_facts = crate::native::dir_facts::dir_facts(dir);

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

                let fact = folder_facts.get(&entry.file_name()).copied();
                let object_id = fact
                    .map(|f| f.object_id)
                    .or_else(|| crate::native::file_id::object_id(&path).ok());
                let allocated = fact.map(|f| f.allocated).or_else(|| allocated_bytes(&metadata));

                // Only for files whose name makes a claim worth checking, or
                // makes no claim at all. Under six per cent of a real volume.
                let extension = path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| ext.to_ascii_lowercase());
                let detected_format =
                    if crate::scanner::sniff::worth_sniffing(extension.as_deref()) {
                        crate::scanner::sniff::detect_format(&path)
                    } else {
                        None
                    };

                let record = FileRecord {
                    parent: dir.to_path_buf(),
                    name: entry.file_name().to_string_lossy().into_owned(),
                    extension,
                    path,
                    size: metadata.len(),
                    modified: metadata.modified().ok(),
                    accessed: metadata.accessed().ok(),
                    created: metadata.created().ok(),
                    object_id,
                    allocated,
                    detected_format,
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

        let elapsed_ms = dir_start.elapsed().as_millis() as u64;
        let _ = self.events_tx.send(ScanEvent::Verbose {
            phase: "scan",
            message: format!(
                "[worker {}] dir done path={} files_found={} elapsed={}ms",
                self.id,
                crate::redact::path_token(dir),
                direct_files,
                elapsed_ms
            ),
        });

        if self.id == 0 {
            let snapshot = self.stats.snapshot(self.queue.len(), self.started_at);
            let _ = self.events_tx.send(ScanEvent::Progress(snapshot));
        }
    }
}

/// What the platform's own metadata says a file occupies, for the folders and
/// platforms the bulk listing does not cover. Windows has no such field on
/// `Metadata`, so it returns `None` and the logical size stands in.
#[cfg(unix)]
fn allocated_bytes(meta: &std::fs::Metadata) -> Option<u64> {
    use std::os::unix::fs::MetadataExt;
    Some(meta.blocks() * 512)
}

#[cfg(not(unix))]
fn allocated_bytes(_meta: &std::fs::Metadata) -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, File};
    use std::io::Write;

    /// The termination contract, tested directly rather than through a scan,
    /// because a race is only sometimes visible from the outside.
    #[test]
    fn a_directory_in_flight_still_counts_as_outstanding() {
        let cancelled = AtomicBool::new(false);
        let queue = SharedQueue::new(PathBuf::from("root"));
        assert_eq!(queue.outstanding(), 1, "the root is owed from the start");

        let task = queue.next(&cancelled).expect("the root is there to take");
        assert_eq!(
            queue.outstanding(),
            1,
            "taking a directory out of the queue does not discharge it -- this is              the window that would let the scan be declared over mid-walk"
        );
        assert_eq!(queue.len(), 0, "and the queue really is empty meanwhile");

        // What a walk does: find children, then end.
        queue.push(PathBuf::from("root/a"));
        queue.push(PathBuf::from("root/b"));
        drop(task);
        assert_eq!(queue.outstanding(), 2, "two children owed, the parent settled");
    }

    #[test]
    fn the_last_directory_completing_ends_the_scan() {
        let cancelled = AtomicBool::new(false);
        let queue = SharedQueue::new(PathBuf::from("root"));
        drop(queue.next(&cancelled).expect("the root"));
        assert_eq!(queue.outstanding(), 0);
        assert!(
            queue.next(&cancelled).is_none(),
            "nothing is owed, so there will never be another directory"
        );
    }

    /// A worker must not be left waiting on a queue that will never fill.
    #[test]
    fn a_cancelled_scan_releases_a_waiting_worker() {
        let cancelled = AtomicBool::new(false);
        let queue = SharedQueue::new(PathBuf::from("root"));
        let task = queue.next(&cancelled).expect("the root");
        cancelled.store(true, Ordering::Relaxed);
        assert!(
            queue.next(&cancelled).is_none(),
            "a cancel must let an idle worker out even with work outstanding"
        );
        drop(task);
    }

    /// A chain of folders one deep each, with far more workers than there is
    /// ever work for. At almost every instant exactly one directory is queued
    /// and every other worker is idle looking at an empty queue -- the shape
    /// that tempts a worker into deciding the scan is over. It must find every
    /// file, every time, and it must finish.
    ///
    /// Repeated, because a race that fires one run in twenty is not caught by
    /// looking once.
    #[test]
    fn a_deep_chain_with_idle_workers_is_never_cut_short() {
        const DEPTH: usize = 60;
        const RUNS: usize = 20;

        let root = test_root("deep-chain");
        let mut dir = root.clone();
        for level in 0..DEPTH {
            dir = dir.join(format!("level-{level}"));
            fs::create_dir_all(&dir).expect("failed to create the chain");
            write_file(&dir.join("f.bin"), &[7; 16]);
        }

        for run in 0..RUNS {
            let scanner = Scanner::new(ScanOptions {
                root: root.clone(),
                workers: 8,
            });
            let mut finished = None;
            for event in scanner.scan() {
                if let ScanEvent::Finished(report) = event {
                    finished = Some(report);
                    break;
                }
            }
            let report = finished.expect("run {run}: the scan must reach Finished");
            assert_eq!(
                report.stats.files_scanned, DEPTH as u64,
                "run {run}: a file went missing with no error to say so"
            );
        }
        cleanup(&root);
    }

    /// The other half of the same guarantee: a wide folder, so many directories
    /// are discovered at once and the count has to come back down to exactly
    /// zero rather than merely near it.
    #[test]
    fn a_wide_tree_finishes_with_every_file_accounted_for() {
        const WIDTH: usize = 40;

        let root = test_root("wide-tree");
        for branch in 0..WIDTH {
            let dir = root.join(format!("branch-{branch}"));
            fs::create_dir_all(&dir).expect("failed to create a branch");
            write_file(&dir.join("a.bin"), &[1; 8]);
            write_file(&dir.join("b.bin"), &[2; 8]);
        }

        let scanner = Scanner::new(ScanOptions {
            root: root.clone(),
            workers: 8,
        });
        let mut finished = None;
        for event in scanner.scan() {
            if let ScanEvent::Finished(report) = event {
                finished = Some(report);
                break;
            }
        }
        let report = finished.expect("the scan must reach Finished");
        assert_eq!(report.stats.files_scanned, (WIDTH * 2) as u64);
        cleanup(&root);
    }

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

    #[test]
    fn scanner_emits_verbose_events() {
        let root = test_root("verbose");
        fs::create_dir_all(&root).expect("create root");
        write_file(&root.join("a.txt"), b"hello");
        write_file(&root.join("b.txt"), b"world");

        let scanner = Scanner::new(ScanOptions {
            root: root.clone(),
            workers: 2,
        });
        let events = scanner.scan();

        let mut saw_verbose = false;
        for event in events {
            if let ScanEvent::Verbose { .. } = event {
                saw_verbose = true;
            }
        }

        assert!(saw_verbose, "expected at least one Verbose event");
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
