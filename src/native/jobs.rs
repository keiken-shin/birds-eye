use crate::index::writer::ScanMode;
use crate::index::IndexWriter;
use crate::native::phase_timer::{PhaseTimer, PhaseTimingEntry};
use crate::ontology::orchestrator::run_phase2;
use crate::ontology::populators::BudgetTier;
use crate::scanner::{ScanController, ScanEvent, ScanOptions, Scanner};
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::HashMap;
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
pub struct LogLineDto {
    pub phase: String,
    pub message: String,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PhaseTimingDto {
    pub phase: String,
    pub duration_ms: u64,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_line: Option<LogLineDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase_timings: Option<Vec<PhaseTimingDto>>,
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
    enrichment_pause: Arc<AtomicBool>,
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
        let root_display = request.root.display().to_string();
        let scanner = Scanner::new(ScanOptions::new(request.root));
        let controller = scanner.controller();
        let enrichment_pause = Arc::new(AtomicBool::new(false));
        let events = scanner.scan();
        let jobs = Arc::clone(&self.jobs);
        let worker_enrichment_pause = Arc::clone(&enrichment_pause);

        {
            let mut jobs = self
                .jobs
                .lock()
                .map_err(|_| "job lock poisoned".to_owned())?;
            // Evict all but the most recent finished jobs so the map (and their event
            // buffers) doesn't grow for the lifetime of the process. Ids are monotonic.
            let mut terminal: Vec<u64> = jobs
                .iter()
                .filter(|(_, j)| j.status != JobStatusDto::Running)
                .map(|(id, _)| *id)
                .collect();
            terminal.sort_unstable_by(|a, b| b.cmp(a));
            for id in terminal.into_iter().skip(3) {
                jobs.remove(&id);
            }
            jobs.insert(
                job_id,
                JobState {
                    status: JobStatusDto::Running,
                    controller: controller.clone(),
                    enrichment_pause: Arc::clone(&enrichment_pause),
                    events: Vec::new(),
                },
            );
        }

        thread::spawn(move || {
            let job_start = std::time::Instant::now();
            let log_stem = request
                .index_path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("index")
                .to_owned();
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let log_path = request
                .index_path
                .with_file_name(format!("{log_stem}-{ts}-{job_id}.log"));
            let log_file: RefCell<Option<BufWriter<std::fs::File>>> =
                RefCell::new(std::fs::File::create(&log_path).ok().map(BufWriter::new));
            let mut timer = PhaseTimer::new();
            let mut phase_watcher = PhaseWatcher::new();

            let mut writer = match IndexWriter::open(&request.index_path) {
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
            writer.set_scan_mode(ScanMode::from_id(
                request
                    .scan_strategy
                    .as_deref()
                    .unwrap_or(ScanMode::default().as_id()),
            ));

            emit_log(
                &jobs,
                listener.as_ref(),
                &log_file,
                job_id,
                job_start,
                "job",
                format!(
                    "job started id={job_id} root={} strategy={}",
                    root_display,
                    request
                        .scan_strategy
                        .as_deref()
                        .unwrap_or(ScanMode::default().as_id())
                ),
            );

            let mut terminal_event = None;
            let mut completed_stats = None;
            let mut files_indexed: u64 = 0;
            let mut last_log_milestone: u64 = 0;
            timer.start("scan");

            for event in events {
                // Route Verbose events from workers to the log only — skip all other processing.
                if let ScanEvent::Verbose { phase, message } = &event {
                    emit_log(
                        &jobs,
                        listener.as_ref(),
                        &log_file,
                        job_id,
                        job_start,
                        phase,
                        message.clone(),
                    );
                    continue;
                }

                if matches!(&event, ScanEvent::FileIndexed(_)) {
                    if files_indexed == 0 {
                        timer.start("index_write");
                    }
                    files_indexed += 1;
                    if files_indexed / 10_000 > last_log_milestone / 10_000 {
                        last_log_milestone = files_indexed;
                        emit_log(
                            &jobs,
                            listener.as_ref(),
                            &log_file,
                            job_id,
                            job_start,
                            "index_write",
                            format!(
                                "batch committed files_so_far={files_indexed} elapsed_ms={}",
                                job_start.elapsed().as_millis()
                            ),
                        );
                    }
                }

                let final_stats = match &event {
                    ScanEvent::Finished(report) => Some(report.stats.clone()),
                    _ => None,
                };

                if let Some(stats) = &final_stats {
                    timer.finish("scan");
                    timer.finish("index_write");
                    emit_log(
                        &jobs,
                        listener.as_ref(),
                        &log_file,
                        job_id,
                        job_start,
                        "job",
                        format!(
                            "scan finished files={} folders={} bytes={} elapsed_ms={}",
                            stats.files_scanned,
                            stats.folders_scanned,
                            stats.bytes_scanned,
                            job_start.elapsed().as_millis()
                        ),
                    );
                    emit_log(
                        &jobs,
                        listener.as_ref(),
                        &log_file,
                        job_id,
                        job_start,
                        "job",
                        "finalization started".to_owned(),
                    );
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
                            phase_watcher.on_progress(
                                &progress.message,
                                progress.progress_current,
                                progress.progress_total,
                                &mut timer,
                            );
                            emit_log(
                                &jobs,
                                listener.as_ref(),
                                &log_file,
                                job_id,
                                job_start,
                                "finalize",
                                format!(
                                    "{} ({}/{})",
                                    progress.message,
                                    progress.progress_current,
                                    progress.progress_total
                                ),
                            );
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

                if !was_completed {
                    // Cancelled or Failed: emit immediately, no refinement.
                    push_event(&jobs, job_id, event, listener.as_ref());
                } else if let Some(stats) = completed_stats {
                    // Run refinement first with Running-status progress events, then emit
                    // a single Completed event so the frontend only queries the index once
                    // refinement is done.
                    let mut progress_listener =
                        |progress: crate::index::writer::FinalizationProgress| {
                            phase_watcher.on_progress(
                                &progress.message,
                                progress.progress_current,
                                progress.progress_total,
                                &mut timer,
                            );
                            emit_log(
                                &jobs,
                                listener.as_ref(),
                                &log_file,
                                job_id,
                                job_start,
                                "finalize",
                                format!(
                                    "{} ({}/{})",
                                    progress.message,
                                    progress.progress_current,
                                    progress.progress_total
                                ),
                            );
                            push_event(
                                &jobs,
                                job_id,
                                JobEventDto::running_with_progress(
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
                            timer.finish("scan"); // no-op if already finished
                            let phase_timings: Vec<PhaseTimingDto> = timer
                                .into_timings()
                                .into_iter()
                                .map(|e: PhaseTimingEntry| PhaseTimingDto {
                                    phase: e.phase,
                                    duration_ms: e.duration_ms,
                                })
                                .collect();

                            emit_log(
                                &jobs,
                                listener.as_ref(),
                                &log_file,
                                job_id,
                                job_start,
                                "job",
                                format!(
                                    "job completed total_elapsed={}ms",
                                    job_start.elapsed().as_millis()
                                ),
                            );
                            write_timing_summary(&log_file, &phase_timings);

                            let mut completed = JobEventDto::completed_with_progress(
                                job_id,
                                "Duplicate analysis complete".to_owned(),
                                &stats,
                                stats.files_scanned,
                                stats.files_scanned,
                            );
                            completed.phase_timings = Some(phase_timings);

                            // ---- Phase 2: ontology enrichment (best-effort, never fails the job). ----
                            emit_log(
                                &jobs,
                                listener.as_ref(),
                                &log_file,
                                job_id,
                                job_start,
                                "enrichment",
                                "phase 2 starting".to_owned(),
                            );
                            match run_phase2(
                                &request.index_path,
                                BudgetTier::CheapOnly,
                                Arc::clone(&worker_enrichment_pause),
                            ) {
                                Ok(true) => emit_log(
                                    &jobs,
                                    listener.as_ref(),
                                    &log_file,
                                    job_id,
                                    job_start,
                                    "enrichment",
                                    "phase 2 completed".to_owned(),
                                ),
                                Ok(false) => emit_log(
                                    &jobs,
                                    listener.as_ref(),
                                    &log_file,
                                    job_id,
                                    job_start,
                                    "enrichment",
                                    "phase 2 skipped (ontology disabled for this index)".to_owned(),
                                ),
                                Err(e) => emit_log(
                                    &jobs,
                                    listener.as_ref(),
                                    &log_file,
                                    job_id,
                                    job_start,
                                    "enrichment",
                                    format!("phase 2 failed (non-fatal): {e}"),
                                ),
                            }
                            let completed =
                                terminal_after_enrichment(completed, &worker_enrichment_pause);
                            push_event(&jobs, job_id, completed, listener.as_ref());
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
                } else {
                    // Completed but no stats (unexpected) — emit as-is.
                    push_event(&jobs, job_id, event, listener.as_ref());
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
        job.enrichment_pause.store(true, Ordering::Relaxed);
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
            log_line: None,
            phase_timings: None,
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
            log_line: None,
            phase_timings: None,
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
            log_line: None,
            phase_timings: None,
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
                log_line: None,
                phase_timings: None,
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
                log_line: None,
                phase_timings: None,
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
                log_line: None,
                phase_timings: None,
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
                log_line: None,
                phase_timings: None,
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
                log_line: None,
                phase_timings: None,
            }),
            ScanEvent::FileIndexed(_) | ScanEvent::FolderIndexed(_) | ScanEvent::Verbose { .. } => {
                None
            }
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
            log_line: None,
            phase_timings: None,
        }
    }

    fn log_line_event(job_id: u64, phase: &'static str, message: String, elapsed_ms: u64) -> Self {
        Self {
            job_id,
            status: JobStatusDto::Running,
            message: message.clone(),
            files_scanned: 0,
            folders_scanned: 0,
            bytes_scanned: 0,
            queue_depth: 0,
            active_workers: 0,
            current_path: None,
            progress_current: 0,
            progress_total: 0,
            log_line: Some(LogLineDto {
                phase: phase.to_owned(),
                message,
                elapsed_ms,
            }),
            phase_timings: None,
        }
    }
}

/// Per-job event history cap. The UI renders only the last ~200 log lines and
/// backfills tolerate gaps, so an unbounded Vec would just leak for the session.
const MAX_EVENTS_PER_JOB: usize = 1_000;

fn push_event(
    jobs: &Arc<Mutex<HashMap<u64, JobState>>>,
    job_id: u64,
    event: JobEventDto,
    listener: Option<&JobEventListener>,
) {
    // A poisoned lock only means a worker panicked mid-update; the event buffer is
    // still valid data — recover it rather than silently dropping events forever.
    let mut jobs = jobs.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(job) = jobs.get_mut(&job_id) {
        job.status = event.status.clone();
        if job.events.len() >= MAX_EVENTS_PER_JOB {
            job.events.remove(0);
        }
        job.events.push(event.clone());
    }
    drop(jobs);

    if let Some(listener) = listener {
        listener(event);
    }
}

fn terminal_after_enrichment(
    mut completed: JobEventDto,
    enrichment_pause: &Arc<AtomicBool>,
) -> JobEventDto {
    if enrichment_pause.load(Ordering::Relaxed) {
        completed.status = JobStatusDto::Cancelled;
        completed.message = "cancelled during enrichment".to_owned();
    }
    completed
}

fn emit_log(
    jobs: &Arc<Mutex<HashMap<u64, JobState>>>,
    listener: Option<&JobEventListener>,
    log_file: &RefCell<Option<BufWriter<std::fs::File>>>,
    job_id: u64,
    job_start: std::time::Instant,
    phase: &'static str,
    message: String,
) {
    let elapsed_ms = job_start.elapsed().as_millis() as u64;
    if let Ok(mut borrow) = log_file.try_borrow_mut() {
        if let Some(ref mut f) = *borrow {
            let s = elapsed_ms / 1000;
            let ms_part = elapsed_ms % 1000;
            let _ = writeln!(
                f,
                "[{:02}:{:02}:{:02}.{:03}] [{}] {}",
                s / 3600,
                (s % 3600) / 60,
                s % 60,
                ms_part,
                phase,
                message
            );
        }
    }
    push_event(
        jobs,
        job_id,
        JobEventDto::log_line_event(job_id, phase, message, elapsed_ms),
        listener,
    );
}

fn write_timing_summary(
    log_file: &RefCell<Option<BufWriter<std::fs::File>>>,
    timings: &[PhaseTimingDto],
) {
    if let Ok(mut borrow) = log_file.try_borrow_mut() {
        if let Some(ref mut f) = *borrow {
            let _ = writeln!(f, "\n── Time Breakdown ──────────────────────");
            for t in timings {
                let _ = writeln!(f, "  {:<22} {}ms", t.phase, t.duration_ms);
            }
            let total: u64 = timings.iter().map(|t| t.duration_ms).sum();
            let _ = writeln!(f, "  {:<22} {}ms (total)", "─────────────────────", total);
            let _ = f.flush();
        }
    }
}

struct PhaseWatcher;

impl PhaseWatcher {
    fn new() -> Self {
        Self
    }

    fn on_progress(&mut self, message: &str, current: u64, total: u64, timer: &mut PhaseTimer) {
        let phase: Option<&'static str> = match message {
            "Marking missing files" => Some("mark_deleted"),
            "Computing folder totals" => Some("folder_rollups"),
            "Building extension statistics" => Some("ext_stats"),
            "Preparing duplicate analysis" => Some("dedup_prep"),
            "Sampling duplicate candidates" => Some("hashing"),
            "Building duplicate groups" => Some("build_groups"),
            _ => None,
        };
        let Some(phase) = phase else { return };
        if current == 0 {
            timer.start(phase);
        } else if total > 0 && current >= total {
            timer.finish(phase);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native::api::{index_metadata, query_index_overview, IndexQueryRequest};
    use rusqlite::Connection;
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
                scan_strategy: Some("metadata".to_owned()),
            })
            .expect("failed to start job");

        wait_for_terminal(&manager, response.job_id);

        let metadata = index_metadata(index_path.clone()).expect("metadata");
        assert_eq!(metadata.scan_strategy, "metadata");

        {
            let verify_writer =
                IndexWriter::open(&index_path).expect("open writer for verification");
            let candidate_count: i64 = verify_writer
                .connection()
                .query_row("SELECT COUNT(*) FROM duplicate_candidates", [], |r| {
                    r.get(0)
                })
                .expect("count candidates");
            let group_count: i64 = verify_writer
                .connection()
                .query_row("SELECT COUNT(*) FROM duplicate_groups", [], |r| r.get(0))
                .expect("count groups");
            assert_eq!(
                candidate_count, 0,
                "MetadataOnly must not create duplicate candidates"
            );
            assert_eq!(
                group_count, 0,
                "MetadataOnly must not create duplicate groups"
            );
        }
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
    fn cancelled_enrichment_replaces_completed_terminal_event() {
        let pause = Arc::new(AtomicBool::new(true));
        let stats = crate::scanner::ScanStats {
            files_scanned: 7,
            folders_scanned: 2,
            bytes_scanned: 99,
            inaccessible_entries: 0,
            queue_depth: 0,
            active_workers: 0,
            elapsed: Duration::ZERO,
            files_per_sec: 0.0,
            bytes_per_sec: 0.0,
            current_path: None,
        };
        let completed = JobEventDto::completed_with_progress(42, "done".to_owned(), &stats, 7, 7);

        let terminal = terminal_after_enrichment(completed, &pause);

        assert_eq!(terminal.status, JobStatusDto::Cancelled);
        assert_eq!(terminal.message, "cancelled during enrichment");
        assert_eq!(terminal.files_scanned, 7);
    }

    #[test]
    fn cancel_during_phase2_reports_cancelled() {
        let root = test_root("cancel-during-phase2");
        let data_root = root.join("data");
        let index_path = root.join("index.sqlite");
        fs::create_dir_all(&data_root).expect("failed to create folder");
        write_file(&data_root.join("logo.psd"), b"photoshop source");

        let manager = ScanJobManager::new();
        let initial = manager
            .start_scan_job(StartScanJobRequest {
                root: data_root.clone(),
                index_path: index_path.clone(),
                scan_strategy: None,
            })
            .expect("failed to start initial job");
        wait_for_terminal(&manager, initial.job_id);

        {
            let conn = Connection::open(&index_path).expect("open index");
            crate::ontology::enabled::enable(&conn).expect("enable ontology");
        }

        let manager_for_listener = manager.clone();
        let rerun = manager
            .start_scan_job_with_listener(
                StartScanJobRequest {
                    root: data_root,
                    index_path,
                    scan_strategy: None,
                },
                Some(Arc::new(move |event| {
                    if event
                        .log_line
                        .as_ref()
                        .map(|line| {
                            line.phase == "enrichment" && line.message == "phase 2 starting"
                        })
                        .unwrap_or(false)
                    {
                        manager_for_listener
                            .cancel_job(event.job_id)
                            .expect("cancel job during phase 2");
                    }
                })),
            )
            .expect("failed to start rerun job");
        wait_for_terminal(&manager, rerun.job_id);

        let status = manager.job_status(rerun.job_id).expect("missing status");
        assert_eq!(status, JobStatusDto::Cancelled);

        let events = manager
            .job_events_since(rerun.job_id, 0)
            .expect("failed to fetch events");
        assert!(events
            .iter()
            .any(|event| event.message == "cancelled during enrichment"));
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

    #[test]
    fn phase2_runs_after_scan_when_ontology_enabled() {
        let root = test_root("phase2-enabled");
        let data_root = root.join("data");
        let index_path = root.join("index.sqlite");
        fs::create_dir_all(&data_root).expect("failed to create folder");
        write_file(&data_root.join("logo.psd"), b"photoshop source");

        let manager = ScanJobManager::new();
        let initial = manager
            .start_scan_job(StartScanJobRequest {
                root: data_root.clone(),
                index_path: index_path.clone(),
                scan_strategy: None,
            })
            .expect("failed to start initial job");
        wait_for_terminal(&manager, initial.job_id);

        {
            let conn = Connection::open(&index_path).expect("open index");
            crate::ontology::enabled::enable(&conn).expect("enable ontology");
        }

        let rerun = manager
            .start_scan_job(StartScanJobRequest {
                root: data_root,
                index_path: index_path.clone(),
                scan_strategy: None,
            })
            .expect("failed to start rerun job");
        wait_for_terminal(&manager, rerun.job_id);

        let conn = Connection::open(&index_path).expect("open index for verification");
        let role_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM ontology_attrs WHERE key = 'role' AND value = 'source'",
                [],
                |r| r.get(0),
            )
            .expect("count ontology role attrs");
        assert!(role_count > 0, "expected PSD source role attr");

        let events = manager
            .job_events_since(rerun.job_id, 0)
            .expect("failed to fetch events");
        assert!(
            events.iter().any(|event| {
                event
                    .log_line
                    .as_ref()
                    .map(|line| line.phase == "enrichment")
                    .unwrap_or(false)
            }),
            "expected enrichment log line"
        );

        drop(conn);
        cleanup(&root);
    }

    #[test]
    fn phase2_is_noop_when_ontology_disabled() {
        let root = test_root("phase2-disabled");
        let data_root = root.join("data");
        let index_path = root.join("index.sqlite");
        fs::create_dir_all(&data_root).expect("failed to create folder");
        write_file(&data_root.join("logo.psd"), b"photoshop source");

        let manager = ScanJobManager::new();
        let response = manager
            .start_scan_job(StartScanJobRequest {
                root: data_root,
                index_path: index_path.clone(),
                scan_strategy: None,
            })
            .expect("failed to start job");
        wait_for_terminal(&manager, response.job_id);

        let conn = Connection::open(&index_path).expect("open index for verification");
        let role_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM ontology_attrs WHERE key = 'role' AND value = 'source'",
                [],
                |r| r.get(0),
            )
            .expect("count ontology role attrs");
        assert_eq!(role_count, 0, "ontology should remain disabled");

        let events = manager
            .job_events_since(response.job_id, 0)
            .expect("failed to fetch events");
        assert!(
            events
                .iter()
                .filter_map(|event| event.log_line.as_ref())
                .any(|line| line.message.contains("phase 2 skipped")),
            "expected phase 2 skipped log line"
        );

        drop(conn);
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

    #[test]
    fn job_emits_log_line_events_and_phase_timings() {
        let root = test_root("log-events");
        let data_root = root.join("data");
        let index_path = root.join("index.sqlite");
        fs::create_dir_all(&data_root).expect("failed to create folder");
        write_file(&data_root.join("a.bin"), &[1; 64]);
        write_file(&data_root.join("b.bin"), &[2; 64]);

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

        // At least one log_line event must exist
        assert!(
            events.iter().any(|e| e.log_line.is_some()),
            "no log_line events emitted"
        );

        // The terminal Completed event must carry phase_timings
        let completed = events.iter().find(|e| e.status == JobStatusDto::Completed);
        assert!(completed.is_some(), "no Completed event");
        assert!(
            completed
                .unwrap()
                .phase_timings
                .as_ref()
                .map(|v| !v.is_empty())
                .unwrap_or(false),
            "Completed event missing phase_timings"
        );

        // Log file must exist alongside the index
        let log_files: Vec<_> = index_path
            .parent()
            .unwrap()
            .read_dir()
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().map(|x| x == "log").unwrap_or(false))
            .collect();
        assert!(!log_files.is_empty(), "no .log file created");

        cleanup(&root);
    }
}
