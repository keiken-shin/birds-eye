use crate::index::algorithms::DedupStrategy;
use crate::index::IndexWriter;
use crate::scanner::{ScanController, ScanEvent, ScanOptions, Scanner};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

pub type JobEventListener = Arc<dyn Fn(JobEventDto) + Send + Sync + 'static>;

#[derive(Debug, Clone, Deserialize)]
pub struct StartScanJobRequest {
    pub root: PathBuf,
    pub index_path: PathBuf,
    #[serde(default)]
    pub scan_strategy: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct StartScanJobResponse {
    pub job_id: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub enum JobStatusDto {
    Running,
    Completed,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct JobEventDto {
    pub job_id: u64,
    pub status: JobStatusDto,
    pub message: String,
    pub files_scanned: u64,
    pub folders_scanned: u64,
    pub bytes_scanned: u64,
    pub queue_depth: usize,
    pub active_workers: usize,
    pub current_path: Option<String>,
    pub progress_current: u64,
    pub progress_total: u64,
}

#[derive(Clone, Default)]
pub struct ScanJobManager {
    next_id: Arc<AtomicU64>,
    jobs: Arc<Mutex<HashMap<u64, JobState>>>,
}

#[derive(Clone)]
struct JobState {
    status: JobStatusDto,
    controller: ScanController,
    events: Vec<JobEventDto>,
}

impl ScanJobManager {
    pub fn new() -> Self {
        Self {
            next_id: Arc::new(AtomicU64::new(1)),
            jobs: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn start_scan_job(
        &self,
        request: StartScanJobRequest,
    ) -> Result<StartScanJobResponse, String> {
        self.start_scan_job_with_listener(request, None)
    }

    pub fn start_scan_job_with_listener(
        &self,
        request: StartScanJobRequest,
        listener: Option<JobEventListener>,
    ) -> Result<StartScanJobResponse, String> {
        let job_id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let scanner = Scanner::new(ScanOptions::new(request.root));
        let controller = scanner.controller();
        let events = scanner.scan();
        let jobs = Arc::clone(&self.jobs);

        {
            let mut jobs = self
                .jobs
                .lock()
                .map_err(|_| "job lock poisoned".to_owned())?;
            jobs.insert(
                job_id,
                JobState {
                    status: JobStatusDto::Running,
                    controller: controller.clone(),
                    events: Vec::new(),
                },
            );
        }

        thread::spawn(move || {
            let mut writer = match IndexWriter::open(request.index_path) {
                Ok(writer) => writer,
                Err(error) => {
                    push_event(
                        &jobs,
                        job_id,
                        JobEventDto::failed(job_id, format!("failed to open index: {error:?}")),
                        listener.as_ref(),
                    );
                    return;
                }
            };
            writer.set_dedup_strategy(DedupStrategy::from_id(
                request
                    .scan_strategy
                    .as_deref()
                    .unwrap_or(DedupStrategy::default().as_id()),
            ));

            let mut terminal_event = None;
            let mut completed_stats = None;

            for event in events {
                let final_stats = match &event {
                    ScanEvent::Finished(report) => Some(report.stats.clone()),
                    _ => None,
                };

                if let Some(stats) = &final_stats {
                    push_event(
                        &jobs,
                        job_id,
                        JobEventDto::running_from_stats(job_id, "Finalizing index", stats),
                        listener.as_ref(),
                    );
                }

                let mut progress_listener =
                    |progress: crate::index::writer::FinalizationProgress| {
                        if let Some(stats) = &final_stats {
                            push_event(
                                &jobs,
                                job_id,
                                JobEventDto::running_with_progress(
                                    job_id,
                                    progress.message,
                                    stats,
                                    progress.progress_current,
                                    progress.progress_total,
                                ),
                                listener.as_ref(),
                            );
                        }
                    };

                if let Err(error) =
                    writer.handle_event_with_progress(&event, &mut progress_listener)
                {
                    push_event(
                        &jobs,
                        job_id,
                        JobEventDto::failed(job_id, format!("failed to write index: {error:?}")),
                        listener.as_ref(),
                    );
                    return;
                }

                let terminal = matches!(event, ScanEvent::Finished(_) | ScanEvent::Cancelled(_));
                if let Some(event) = JobEventDto::from_scan_event(job_id, &event) {
                    if terminal {
                        terminal_event = Some(event);
                    } else {
                        push_event(&jobs, job_id, event, listener.as_ref());
                    }
                }

                if terminal {
                    if matches!(event, ScanEvent::Finished(_)) {
                        completed_stats = final_stats;
                    }
                    break;
                }
            }

            if let Some(event) = terminal_event {
                let was_completed = event.status == JobStatusDto::Completed;
                push_event(&jobs, job_id, event, listener.as_ref());

                if was_completed {
                    if let Some(stats) = completed_stats {
                        let mut progress_listener =
                            |progress: crate::index::writer::FinalizationProgress| {
                                push_event(
                                    &jobs,
                                    job_id,
                                    JobEventDto::completed_with_progress(
                                        job_id,
                                        progress.message,
                                        &stats,
                                        progress.progress_current,
                                        progress.progress_total,
                                    ),
                                    listener.as_ref(),
                                );
                            };

                        match writer.refine_duplicates_with_progress(&mut progress_listener) {
                            Ok(()) => {
                                push_event(
                                    &jobs,
                                    job_id,
                                    JobEventDto::completed_with_progress(
                                        job_id,
                                        "Duplicate analysis complete".to_owned(),
                                        &stats,
                                        stats.files_scanned,
                                        stats.files_scanned,
                                    ),
                                    listener.as_ref(),
                                );
                            }
                            Err(error) => {
                                push_event(
                                    &jobs,
                                    job_id,
                                    JobEventDto::failed(
                                        job_id,
                                        format!("failed to refine duplicates: {error:?}"),
                                    ),
                                    listener.as_ref(),
                                );
                            }
                        }
                    }
                }
            }
        });

        Ok(StartScanJobResponse { job_id })
    }

    pub fn cancel_job(&self, job_id: u64) -> Result<(), String> {
        let jobs = self
            .jobs
            .lock()
            .map_err(|_| "job lock poisoned".to_owned())?;
        let job = jobs
            .get(&job_id)
            .ok_or_else(|| format!("unknown scan job {job_id}"))?;
        job.controller.cancel();
        Ok(())
    }

    pub fn job_events_since(&self, job_id: u64, offset: usize) -> Result<Vec<JobEventDto>, String> {
        let jobs = self
            .jobs
            .lock()
            .map_err(|_| "job lock poisoned".to_owned())?;
        let job = jobs
            .get(&job_id)
            .ok_or_else(|| format!("unknown scan job {job_id}"))?;
        Ok(job.events.iter().skip(offset).cloned().collect())
    }

    pub fn job_status(&self, job_id: u64) -> Result<JobStatusDto, String> {
        let jobs = self
            .jobs
            .lock()
            .map_err(|_| "job lock poisoned".to_owned())?;
        let job = jobs
            .get(&job_id)
            .ok_or_else(|| format!("unknown scan job {job_id}"))?;
        Ok(job.status.clone())
    }
}

impl JobEventDto {
    fn running_from_stats(job_id: u64, message: &str, stats: &crate::scanner::ScanStats) -> Self {
        Self {
            job_id,
            status: JobStatusDto::Running,
            message: message.to_owned(),
            files_scanned: stats.files_scanned,
            folders_scanned: stats.folders_scanned,
            bytes_scanned: stats.bytes_scanned,
            queue_depth: stats.queue_depth,
            active_workers: stats.active_workers,
            current_path: stats
                .current_path
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned()),
            progress_current: stats.files_scanned,
            progress_total: 0,
        }
    }

    fn running_with_progress(
        job_id: u64,
        message: String,
        stats: &crate::scanner::ScanStats,
        progress_current: u64,
        progress_total: u64,
    ) -> Self {
        Self {
            job_id,
            status: JobStatusDto::Running,
            message,
            files_scanned: stats.files_scanned,
            folders_scanned: stats.folders_scanned,
            bytes_scanned: stats.bytes_scanned,
            queue_depth: 0,
            active_workers: 0,
            current_path: stats
                .current_path
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned()),
            progress_current,
            progress_total,
        }
    }

    fn completed_with_progress(
        job_id: u64,
        message: String,
        stats: &crate::scanner::ScanStats,
        progress_current: u64,
        progress_total: u64,
    ) -> Self {
        Self {
            job_id,
            status: JobStatusDto::Completed,
            message,
            files_scanned: stats.files_scanned,
            folders_scanned: stats.folders_scanned,
            bytes_scanned: stats.bytes_scanned,
            queue_depth: 0,
            active_workers: 0,
            current_path: stats
                .current_path
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned()),
            progress_current,
            progress_total,
        }
    }

    fn from_scan_event(job_id: u64, event: &ScanEvent) -> Option<Self> {
        match event {
            ScanEvent::Started { root, workers } => Some(Self {
                job_id,
                status: JobStatusDto::Running,
                message: format!("started scan root={} workers={workers}", root.display()),
                files_scanned: 0,
                folders_scanned: 0,
                bytes_scanned: 0,
                queue_depth: 0,
                active_workers: 0,
                current_path: Some(root.to_string_lossy().into_owned()),
                progress_current: 0,
                progress_total: 0,
            }),
            ScanEvent::Progress(stats) => Some(Self {
                job_id,
                status: JobStatusDto::Running,
                message: "progress".to_owned(),
                files_scanned: stats.files_scanned,
                folders_scanned: stats.folders_scanned,
                bytes_scanned: stats.bytes_scanned,
                queue_depth: stats.queue_depth,
                active_workers: stats.active_workers,
                current_path: stats
                    .current_path
                    .as_ref()
                    .map(|path| path.to_string_lossy().into_owned()),
                progress_current: stats.files_scanned,
                progress_total: 0,
            }),
            ScanEvent::Finished(report) => Some(Self {
                job_id,
                status: JobStatusDto::Completed,
                message: "completed".to_owned(),
                files_scanned: report.stats.files_scanned,
                folders_scanned: report.stats.folders_scanned,
                bytes_scanned: report.stats.bytes_scanned,
                queue_depth: 0,
                active_workers: 0,
                current_path: Some(report.root.to_string_lossy().into_owned()),
                progress_current: report.stats.files_scanned,
                progress_total: report.stats.files_scanned,
            }),
            ScanEvent::Cancelled(stats) => Some(Self {
                job_id,
                status: JobStatusDto::Cancelled,
                message: "cancelled".to_owned(),
                files_scanned: stats.files_scanned,
                folders_scanned: stats.folders_scanned,
                bytes_scanned: stats.bytes_scanned,
                queue_depth: stats.queue_depth,
                active_workers: stats.active_workers,
                current_path: stats
                    .current_path
                    .as_ref()
                    .map(|path| path.to_string_lossy().into_owned()),
                progress_current: stats.files_scanned,
                progress_total: stats.files_scanned,
            }),
            ScanEvent::Error(error) => Some(Self {
                job_id,
                status: JobStatusDto::Running,
                message: format!(
                    "error path={} message={}",
                    error.path.display(),
                    error.message
                ),
                files_scanned: 0,
                folders_scanned: 0,
                bytes_scanned: 0,
                queue_depth: 0,
                active_workers: 0,
                current_path: Some(error.path.to_string_lossy().into_owned()),
                progress_current: 0,
                progress_total: 0,
            }),
            ScanEvent::FileIndexed(_) | ScanEvent::FolderIndexed(_) => None,
        }
    }

    fn failed(job_id: u64, message: String) -> Self {
        Self {
            job_id,
            status: JobStatusDto::Failed,
            message,
            files_scanned: 0,
            folders_scanned: 0,
            bytes_scanned: 0,
            queue_depth: 0,
            active_workers: 0,
            current_path: None,
            progress_current: 0,
            progress_total: 0,
        }
    }
}

fn push_event(
    jobs: &Arc<Mutex<HashMap<u64, JobState>>>,
    job_id: u64,
    event: JobEventDto,
    listener: Option<&JobEventListener>,
) {
    if let Ok(mut jobs) = jobs.lock() {
        if let Some(job) = jobs.get_mut(&job_id) {
            job.status = event.status.clone();
            job.events.push(event.clone());
        }
    }

    if let Some(listener) = listener {
        listener(event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native::api::{index_metadata, query_index_overview, IndexQueryRequest};
    use std::fs::{self, File};
    use std::io::Write;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    #[test]
    fn background_job_scans_to_index_and_records_events() {
        let root = test_root("job");
        let data_root = root.join("data");
        let index_path = root.join("index.sqlite");
        fs::create_dir_all(&data_root).expect("failed to create folder");
        write_file(&data_root.join("one.bin"), &[1; 32]);
        write_file(&data_root.join("two.bin"), &[1; 32]);

        let manager = ScanJobManager::new();
        let response = manager
            .start_scan_job(StartScanJobRequest {
                root: data_root,
                index_path: index_path.clone(),
                scan_strategy: None,
            })
            .expect("failed to start job");

        wait_for_terminal(&manager, response.job_id);

        let events = manager
            .job_events_since(response.job_id, 0)
            .expect("failed to fetch events");
        let overview = query_index_overview(IndexQueryRequest {
            index_path,
            limit: 10,
        })
        .expect("failed to query index");

        assert!(events
            .iter()
            .any(|event| event.status == JobStatusDto::Completed));
        assert!(events
            .iter()
            .any(|event| event.message == "Finalizing index"));
        assert_eq!(overview.files.len(), 2);
        assert_eq!(overview.duplicate_groups.len(), 1);
        cleanup(&root);
    }

    #[test]
    fn background_job_records_scan_strategy() {
        let root = test_root("job-strategy");
        let data_root = root.join("data");
        let index_path = root.join("index.sqlite");
        fs::create_dir_all(&data_root).expect("failed to create folder");
        write_file(&data_root.join("one.bin"), &[1; 32]);

        let manager = ScanJobManager::new();
        let response = manager
            .start_scan_job(StartScanJobRequest {
                root: data_root,
                index_path: index_path.clone(),
                scan_strategy: Some("fnv1a-legacy".to_owned()),
            })
            .expect("failed to start job");

        wait_for_terminal(&manager, response.job_id);

        let metadata = index_metadata(index_path).expect("metadata");
        assert_eq!(metadata.scan_strategy, "fnv1a-legacy");
        cleanup(&root);
    }

    #[test]
    fn background_job_can_be_cancelled() {
        let root = test_root("cancel-job");
        let data_root = root.join("data");
        let index_path = root.join("index.sqlite");
        fs::create_dir_all(&data_root).expect("failed to create folder");
        for index in 0..400 {
            write_file(&data_root.join(format!("file-{index}.bin")), &[1; 128]);
        }

        let manager = ScanJobManager::new();
        let response = manager
            .start_scan_job(StartScanJobRequest {
                root: data_root,
                index_path,
                scan_strategy: None,
            })
            .expect("failed to start job");
        manager
            .cancel_job(response.job_id)
            .expect("failed to cancel job");
        wait_for_terminal(&manager, response.job_id);

        let status = manager.job_status(response.job_id).expect("missing status");
        assert!(matches!(
            status,
            JobStatusDto::Cancelled | JobStatusDto::Completed
        ));
        cleanup(&root);
    }

    #[test]
    fn listener_receives_progress_and_terminal_events() {
        let root = test_root("listener");
        let data_root = root.join("data");
        let index_path = root.join("index.sqlite");

        fs::create_dir_all(&data_root).unwrap();
        write_file(&data_root.join("file.bin"), b"hello");

        let manager = ScanJobManager::new();

        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&events);

        let response = manager
            .start_scan_job_with_listener(
                StartScanJobRequest {
                    root: data_root,
                    index_path,
                    scan_strategy: None,
                },
                Some(Arc::new(move |event| {
                    captured.lock().unwrap().push(event);
                })),
            )
            .unwrap();

        wait_for_terminal(&manager, response.job_id);

        let events = events.lock().unwrap();

        assert!(events.iter().any(|e| {
            matches!(e.status, JobStatusDto::Running) && e.message.contains("progress")
        }));

        assert!(events
            .iter()
            .any(|e| matches!(e.status, JobStatusDto::Completed)));

        let buffered = manager.job_events_since(response.job_id, 0).unwrap();
        assert!(!buffered.is_empty());

        cleanup(&root);
    }

    #[test]
    fn listener_receives_finalization_progress_totals() {
        let root = test_root("finalization-progress");
        let data_root = root.join("data");
        let index_path = root.join("index.sqlite");

        fs::create_dir_all(&data_root).unwrap();
        write_file(&data_root.join("one.bin"), &[1; 64]);
        write_file(&data_root.join("two.bin"), &[1; 64]);

        let manager = ScanJobManager::new();

        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&events);

        let response = manager
            .start_scan_job_with_listener(
                StartScanJobRequest {
                    root: data_root,
                    index_path,
                    scan_strategy: None,
                },
                Some(Arc::new(move |event| {
                    captured.lock().unwrap().push(event);
                })),
            )
            .unwrap();

        wait_for_terminal(&manager, response.job_id);

        let events = events.lock().unwrap();
        assert!(events.iter().any(|event| {
            event.message.contains("Sampling duplicate candidates")
                && event.progress_total > 0
                && event.progress_current <= event.progress_total
        }));

        cleanup(&root);
    }

    fn wait_for_terminal(manager: &ScanJobManager, job_id: u64) {
        for _ in 0..80 {
            let status = manager.job_status(job_id).expect("missing status");
            if !matches!(status, JobStatusDto::Running) {
                if matches!(status, JobStatusDto::Completed) {
                    wait_for_duplicate_analysis_complete(manager, job_id);
                }
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        panic!("job did not finish");
    }

    fn wait_for_duplicate_analysis_complete(manager: &ScanJobManager, job_id: u64) {
        for _ in 0..80 {
            let events = manager
                .job_events_since(job_id, 0)
                .expect("failed to fetch job events");
            if events
                .iter()
                .any(|event| event.message == "Duplicate analysis complete")
            {
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        panic!("duplicate analysis did not finish");
    }

    fn test_root(name: &str) -> PathBuf {
        let root = std::env::current_dir()
            .expect("failed to get current dir")
            .join("target")
            .join("job-tests")
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
