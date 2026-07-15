use crate::index::schema::ALL_MIGRATIONS;
use crate::scanner::{FileRecord, FolderRecord, ScanEvent, ScanStats};
use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug)]
pub enum IndexError {
    Sqlite(rusqlite::Error),
    MissingSession,
}

impl From<rusqlite::Error> for IndexError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScanMode {
    /// Full pipeline: metadata index plus progressive duplicate refinement.
    Smart,
    /// Metadata index only; duplicate refinement is skipped.
    MetadataOnly,
}

impl Default for ScanMode {
    fn default() -> Self {
        Self::Smart
    }
}

impl ScanMode {
    pub fn from_id(value: &str) -> Self {
        match value {
            "metadata" => Self::MetadataOnly,
            _ => Self::Smart,
        }
    }

    pub fn as_id(self) -> &'static str {
        match self {
            Self::Smart => "smart",
            Self::MetadataOnly => "metadata",
        }
    }
}

/// Cap issue rows per scan — enough to review, never a runaway table when a
/// whole subtree is unreadable. Counts shown to the user come from this table,
/// so the cap also caps the reported number.
pub(crate) const SCAN_ISSUES_CAP: i64 = 500;

pub struct IndexWriter {
    connection: Connection,
    session_id: Option<i64>,
    active_root: Option<PathBuf>,
    active_scan_started_at: Option<i64>,
    active_scan_mode: ScanMode,
    scan_transaction_open: bool,
    folder_ids: HashMap<PathBuf, i64>,
    files_since_commit: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FolderSummary {
    pub path: String,
    pub total_files: i64,
    pub total_bytes: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ScanIssueSummary {
    /// 'walk' (couldn't index) or 'hash' (couldn't verify content).
    pub phase: String,
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FileSummary {
    pub path: String,
    pub size: i64,
    pub extension: Option<String>,
    pub media_kind: String,
    pub modified_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FileSearchResult {
    pub path: String,
    pub name: String,
    pub size: i64,
    pub extension: Option<String>,
    pub media_kind: String,
    pub modified_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExtensionSummary {
    pub extension: String,
    pub file_count: i64,
    pub total_bytes: i64,
}

/// How many member paths ride along on each duplicate-group summary — enough
/// for relating groups to folders/findings without a per-group query.
pub const SAMPLE_PATHS_PER_GROUP: i64 = 8;

#[derive(Debug, Clone, PartialEq)]
pub struct DuplicateGroupSummary {
    pub id: i64,
    pub size: i64,
    pub file_count: i64,
    pub reclaimable_bytes: i64,
    pub confidence: f64,
    /// Up to [`SAMPLE_PATHS_PER_GROUP`] member paths, largest first.
    pub sample_paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DuplicateFileSummary {
    pub path: String,
    pub size: i64,
    pub modified_at: Option<i64>,
    pub hash_state: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MediaSummary {
    pub media_kind: String,
    pub file_count: i64,
    pub total_bytes: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FolderMediaSummary {
    pub folder_path: String,
    pub media_kind: String,
    pub total_bytes: i64,
}

/// One month of modified-time activity (`bucket` = `YYYY-MM`).
#[derive(Debug, Clone, PartialEq)]
pub struct TimelineBucket {
    pub bucket: String,
    pub file_count: i64,
    pub total_bytes: i64,
}

/// One fixed staleness band keyed by a stable id
/// (`lt1mo` · `1to3mo` · `3to6mo` · `6to12mo` · `1to2yr` · `gt2yr` · `unknown`).
#[derive(Debug, Clone, PartialEq)]
pub struct AgeBucket {
    pub bucket: String,
    pub file_count: i64,
    pub total_bytes: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FinalizationProgress {
    pub message: String,
    pub progress_current: u64,
    pub progress_total: u64,
}

impl IndexWriter {
    /// Commit the crawl transaction every this many indexed files so the index
    /// is queryable progressively and the final commit is not a single cliff.
    const CRAWL_COMMIT_BATCH: u64 = 10_000;

    fn maybe_commit_crawl_batch(&mut self) -> Result<(), IndexError> {
        self.files_since_commit += 1;
        if self.files_since_commit >= Self::CRAWL_COMMIT_BATCH {
            self.commit_scan_transaction()?;
            self.begin_scan_transaction()?;
            self.files_since_commit = 0;
        }
        Ok(())
    }

    pub fn open(path: impl AsRef<Path>) -> Result<Self, IndexError> {
        let connection = crate::index::open_index_connection(path)?;
        let writer = Self {
            connection,
            session_id: None,
            active_root: None,
            active_scan_started_at: None,
            active_scan_mode: ScanMode::default(),
            scan_transaction_open: false,
            folder_ids: HashMap::new(),
            files_since_commit: 0,
        };
        writer.migrate()?;
        Ok(writer)
    }

    pub fn open_in_memory() -> Result<Self, IndexError> {
        let connection = Connection::open_in_memory()?;
        let writer = Self {
            connection,
            session_id: None,
            active_root: None,
            active_scan_started_at: None,
            active_scan_mode: ScanMode::default(),
            scan_transaction_open: false,
            folder_ids: HashMap::new(),
            files_since_commit: 0,
        };
        writer.migrate()?;
        Ok(writer)
    }

    pub fn handle_event(&mut self, event: &ScanEvent) -> Result<(), IndexError> {
        self.handle_event_with_progress(event, |_| {})
    }

    pub fn handle_event_with_progress<F>(
        &mut self,
        event: &ScanEvent,
        mut progress: F,
    ) -> Result<(), IndexError>
    where
        F: FnMut(FinalizationProgress),
    {
        match event {
            ScanEvent::Started { root, .. } => self.start_session(root),
            ScanEvent::FolderIndexed(folder) => self.index_folder(folder),
            ScanEvent::FileIndexed(file) => self.index_file(file),
            ScanEvent::Finished(report) => {
                self.finish_session("complete", &report.stats)?;
                progress_stage(&mut progress, "Marking missing files", 0, 1);
                self.mark_missing_files_deleted()?;
                progress_stage(&mut progress, "Marking missing files", 1, 1);
                self.commit_scan_transaction()?;
                self.recompute_folder_rollups(&mut progress)?;
                progress_stage(&mut progress, "Building extension statistics", 0, 1);
                self.rebuild_extension_stats()?;
                progress_stage(&mut progress, "Building extension statistics", 1, 1);
                progress_stage(&mut progress, "Building overview statistics", 0, 1);
                self.rebuild_derived_stats()?;
                progress_stage(&mut progress, "Building overview statistics", 1, 1);
                progress_stage(&mut progress, "Capturing timeline", 0, 1);
                self.capture_timeline(&report.root, &report.stats)?;
                progress_stage(&mut progress, "Capturing timeline", 1, 1);
                Ok(())
            }
            ScanEvent::Cancelled(stats) => {
                self.finish_session("cancelled", stats)?;
                self.commit_scan_transaction()
            }
            ScanEvent::Error(error) => {
                self.record_scan_issue("walk", &path_to_string(&error.path), &error.message)
            }
            ScanEvent::Progress(_) | ScanEvent::Verbose { .. } => Ok(()),
        }
    }

    pub fn connection(&self) -> &Connection {
        &self.connection
    }

    pub fn set_scan_mode(&mut self, mode: ScanMode) {
        self.active_scan_mode = mode;
    }

    pub fn latest_scan_mode(&self) -> Result<ScanMode, IndexError> {
        let mode = self
            .connection
            .query_row(
                "SELECT scan_strategy FROM scan_sessions ORDER BY started_at DESC LIMIT 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        Ok(mode.as_deref().map(ScanMode::from_id).unwrap_or_default())
    }

    pub fn refine_duplicates_with_progress<F, C>(
        &mut self,
        cancel: &C,
        mut progress: F,
    ) -> Result<(), IndexError>
    where
        F: FnMut(FinalizationProgress),
        C: Fn() -> bool + Sync,
    {
        if self.active_scan_mode == ScanMode::MetadataOnly || cancel() {
            return Ok(());
        }

        let scan_id = self.current_scan_session_id()?;

        progress_stage(&mut progress, "Preparing duplicate analysis", 0, 1);
        self.prepare_duplicate_refinement_jobs()?;
        progress_stage(&mut progress, "Preparing duplicate analysis", 1, 1);

        progress_stage(&mut progress, "Sampling duplicate candidates", 0, 1);
        self.mark_hash_jobs_running(scan_id, "sample")?;
        self.mark_duplicate_candidates_status(scan_id, "sampling")?;
        // Re-runs re-hash every unfinished candidate, so start their issue
        // slate clean instead of stacking duplicate rows.
        self.connection.execute(
            "DELETE FROM scan_issues WHERE scan_id = ?1 AND phase = 'hash'",
            params![scan_id],
        )?;
        crate::index::algorithms::update_hashes_for_duplicate_candidates(
            &mut self.connection,
            scan_id,
            cancel,
            &mut progress,
        )?;
        // Cancelled mid-hash: skip group rebuilding, keep the jobs/candidates
        // rows as-is so the next scan re-hashes whatever was left unfinished.
        if cancel() {
            return Ok(());
        }
        self.mark_hash_jobs_completed(scan_id, "sample")?;

        self.record_completed_full_hash_jobs(scan_id)?;

        progress_stage(&mut progress, "Building duplicate groups", 0, 1);
        self.rebuild_duplicate_size_groups()?;
        self.mark_duplicate_candidates_status(scan_id, "completed")?;
        progress_stage(&mut progress, "Building duplicate groups", 1, 1);

        Ok(())
    }

    pub fn refine_duplicates(&mut self) -> Result<(), IndexError> {
        self.refine_duplicates_with_progress(&|| false, |_| {})
    }

    /// Issues from the most recent scan session: what couldn't be read (walk)
    /// or content-verified (hash), with the OS error message. Detail rows are
    /// capped at `SCAN_ISSUES_CAP` per scan.
    pub fn scan_issues(&self, limit: usize) -> Result<Vec<ScanIssueSummary>, IndexError> {
        let scan_id = match self.current_scan_session_id() {
            Ok(id) => id,
            Err(IndexError::MissingSession) => return Ok(Vec::new()),
            Err(e) => return Err(e),
        };
        let mut statement = self.connection.prepare(
            "SELECT phase, path, message FROM scan_issues
             WHERE scan_id = ?1
             ORDER BY phase, path
             LIMIT ?2",
        )?;
        let rows = statement.query_map(params![scan_id, limit as i64], |row| {
            Ok(ScanIssueSummary {
                phase: row.get(0)?,
                path: row.get(1)?,
                message: row.get(2)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// (walk, hash) issue counts for the most recent scan session. The walk
    /// count comes from the session's uncapped `inaccessible_entries` tally;
    /// the hash count from the (capped) issue rows.
    pub fn scan_issue_counts(&self) -> Result<(i64, i64), IndexError> {
        let scan_id = match self.current_scan_session_id() {
            Ok(id) => id,
            Err(IndexError::MissingSession) => return Ok((0, 0)),
            Err(e) => return Err(e),
        };
        let walk: i64 = self.connection.query_row(
            "SELECT inaccessible_entries FROM scan_sessions WHERE id = ?1",
            params![scan_id],
            |row| row.get(0),
        )?;
        let hash: i64 = self.connection.query_row(
            "SELECT COUNT(*) FROM scan_issues WHERE scan_id = ?1 AND phase = 'hash'",
            params![scan_id],
            |row| row.get(0),
        )?;
        Ok((walk, hash))
    }

    /// Re-walk just the given paths and fold what's found into the index — the
    /// targeted fix for walk issues, without a full rescan. Each path's issue
    /// slate is cleared first; whatever still fails re-records a fresh issue.
    /// File paths (from per-entry metadata failures) probe their parent folder.
    pub fn probe_folders(&mut self, paths: &[PathBuf]) -> Result<(), IndexError> {
        let scan_id = self.current_scan_session_id()?;

        // Dedup to directories: a file path retries via its parent.
        let mut roots: Vec<PathBuf> = Vec::new();
        for path in paths {
            let dir = if std::fs::metadata(path).map(|m| m.is_dir()).unwrap_or(true) {
                path.clone()
            } else {
                path.parent().map(Path::to_path_buf).unwrap_or_else(|| path.clone())
            };
            if !roots.iter().any(|r| dir.starts_with(r)) {
                roots.retain(|r| !r.starts_with(&dir));
                roots.push(dir);
            }
        }

        for root in &roots {
            self.connection.execute(
                "DELETE FROM scan_issues
                 WHERE scan_id = ?1 AND phase = 'walk' AND (path = ?2 OR path LIKE ?3 ESCAPE '\\')",
                params![
                    scan_id,
                    path_to_string(root),
                    format!("{}%", escape_like_pattern(&path_prefix(root)))
                ],
            )?;
            self.probe_directory(root)?;
        }

        self.commit_scan_transaction()?; // flush any batched crawl commits
        self.recompute_folder_rollups(&mut |_| {})?;
        self.rebuild_extension_stats()?;
        self.rebuild_derived_stats()?;
        // The session's walk tally now reflects what is still unreadable.
        self.connection.execute(
            "UPDATE scan_sessions
             SET inaccessible_entries =
               (SELECT COUNT(*) FROM scan_issues WHERE scan_id = ?1 AND phase = 'walk')
             WHERE id = ?1",
            params![scan_id],
        )?;
        Ok(())
    }

    fn probe_directory(&mut self, dir: &Path) -> Result<(), IndexError> {
        let read_dir = match std::fs::read_dir(dir) {
            Ok(read_dir) => read_dir,
            Err(error) => {
                return self.record_scan_issue("walk", &path_to_string(dir), &error.to_string());
            }
        };

        let mut direct_files = 0u64;
        let mut direct_bytes = 0u64;
        let mut subdirs = Vec::new();
        for entry in read_dir {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    self.record_scan_issue("walk", &path_to_string(dir), &error.to_string())?;
                    continue;
                }
            };
            let path = entry.path();
            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(error) => {
                    self.record_scan_issue("walk", &path_to_string(&path), &error.to_string())?;
                    continue;
                }
            };
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                subdirs.push(path);
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let extension = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_ascii_lowercase());
            direct_files += 1;
            direct_bytes += metadata.len();
            self.index_file(&FileRecord {
                parent: dir.to_path_buf(),
                path,
                name,
                extension,
                size: metadata.len(),
                modified: metadata.modified().ok(),
                accessed: metadata.accessed().ok(),
                created: metadata.created().ok(),
            })?;
        }
        self.index_folder(&FolderRecord {
            path: dir.to_path_buf(),
            direct_files,
            direct_bytes,
        })?;
        for sub in subdirs {
            self.probe_directory(&sub)?;
        }
        Ok(())
    }

    pub fn largest_folders(&self, limit: usize) -> Result<Vec<FolderSummary>, IndexError> {
        let mut statement = self.connection.prepare(
            "SELECT path, total_files, total_bytes
             FROM folders
             WHERE total_bytes > 0
             ORDER BY total_bytes DESC
             LIMIT ?1",
        )?;
        let rows = statement.query_map(params![limit as i64], |row| {
            Ok(FolderSummary {
                path: row.get(0)?,
                total_files: row.get(1)?,
                total_bytes: row.get(2)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Direct children of one folder, largest first. The overview's
    /// `largest_folders` is a global top-N, so deep/small subtrees fall out of
    /// it — this scoped query is how drill-down reaches everything else.
    pub fn folder_children(
        &self,
        parent_path: &str,
        limit: usize,
    ) -> Result<Vec<FolderSummary>, IndexError> {
        let mut statement = self.connection.prepare(
            "SELECT f.path, f.total_files, f.total_bytes
             FROM folders f
             JOIN folders p ON f.parent_id = p.id
             WHERE p.path = ?1 AND f.total_bytes > 0
             ORDER BY f.total_bytes DESC
             LIMIT ?2",
        )?;
        let rows = statement.query_map(params![parent_path, limit as i64], |row| {
            Ok(FolderSummary {
                path: row.get(0)?,
                total_files: row.get(1)?,
                total_bytes: row.get(2)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn largest_files(&self, limit: usize) -> Result<Vec<FileSummary>, IndexError> {
        let mut statement = self.connection.prepare(
            "SELECT path, size, extension, media_kind, modified_at
             FROM files
             WHERE deleted_at IS NULL
             ORDER BY size DESC
             LIMIT ?1",
        )?;
        let rows = statement.query_map(params![limit as i64], |row| {
            Ok(FileSummary {
                path: row.get(0)?,
                size: row.get(1)?,
                extension: row.get(2)?,
                media_kind: row.get(3)?,
                modified_at: row.get(4)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Monthly modified-time activity buckets (`YYYY-MM`) over the last `months`
    /// months, oldest first. Files with no modified timestamp are excluded.
    pub fn timeline_summaries(&self, months: usize) -> Result<Vec<TimelineBucket>, IndexError> {
        let horizon = format!("-{months} months");
        // 'YYYY-MM' strings compare chronologically, so the materialized table
        // filters by plain string range.
        let sql = if self.has_rows("month_stats")? {
            "SELECT bucket, file_count, total_bytes
             FROM month_stats
             WHERE bucket != 'unknown'
               AND bucket >= strftime('%Y-%m', 'now', ?1)
               AND bucket <= strftime('%Y-%m', 'now', '+1 day')
             ORDER BY bucket ASC"
        } else {
            "SELECT strftime('%Y-%m', modified_at, 'unixepoch') AS bucket,
                    COUNT(*) AS file_count,
                    SUM(size) AS total_bytes
             FROM files
             WHERE deleted_at IS NULL
               AND modified_at IS NOT NULL
               AND modified_at >= strftime('%s', 'now', ?1)
               AND modified_at <= strftime('%s', 'now', '+1 day')
             GROUP BY bucket
             ORDER BY bucket ASC"
        };
        let mut statement = self.connection.prepare(sql)?;
        let rows = statement.query_map(params![horizon], |row| {
            Ok(TimelineBucket {
                bucket: row.get(0)?,
                file_count: row.get(1)?,
                total_bytes: row.get(2)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Staleness distribution: how many files (and bytes) were last modified
    /// within each fixed age band. Files with no modified timestamp land in `unknown`.
    pub fn age_summaries(&self) -> Result<Vec<AgeBucket>, IndexError> {
        // Materialized bands are relative to the last scan — they describe the
        // scanned snapshot, which is what the rest of the index shows anyway.
        if self.has_rows("age_stats")? {
            let mut statement = self
                .connection
                .prepare("SELECT bucket, file_count, total_bytes FROM age_stats")?;
            let rows = statement.query_map([], |row| {
                Ok(AgeBucket {
                    bucket: row.get(0)?,
                    file_count: row.get(1)?,
                    total_bytes: row.get(2)?,
                })
            })?;
            return Ok(rows.collect::<Result<Vec<_>, _>>()?);
        }
        let mut statement = self.connection.prepare(
            "SELECT CASE
                      WHEN modified_at IS NULL THEN 'unknown'
                      WHEN age < 2592000 THEN 'lt1mo'
                      WHEN age < 7776000 THEN '1to3mo'
                      WHEN age < 15552000 THEN '3to6mo'
                      WHEN age < 31536000 THEN '6to12mo'
                      WHEN age < 63072000 THEN '1to2yr'
                      ELSE 'gt2yr'
                    END AS bucket,
                    COUNT(*) AS file_count,
                    SUM(size) AS total_bytes
             FROM (
               SELECT modified_at,
                      size,
                      CAST(strftime('%s', 'now') AS INTEGER) - modified_at AS age
               FROM files
               WHERE deleted_at IS NULL
             )
             GROUP BY bucket",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(AgeBucket {
                bucket: row.get(0)?,
                file_count: row.get(1)?,
                total_bytes: row.get(2)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn search_files(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<Vec<FileSearchResult>, IndexError> {
        let trimmed_query = query.trim();
        if trimmed_query.is_empty() {
            return Ok(Vec::new());
        }

        let escaped_query = escape_like_pattern(trimmed_query);
        let pattern = format!("%{escaped_query}%");
        let mut statement = self.connection.prepare(
            "SELECT path, name, size, extension, media_kind, modified_at
             FROM files
             WHERE deleted_at IS NULL
               AND (name LIKE ?1 ESCAPE '\\' OR path LIKE ?1 ESCAPE '\\')
             ORDER BY size DESC, modified_at DESC
             LIMIT ?2",
        )?;
        let rows = statement.query_map(params![pattern, limit as i64], |row| {
            Ok(FileSearchResult {
                path: row.get(0)?,
                name: row.get(1)?,
                size: row.get(2)?,
                extension: row.get(3)?,
                media_kind: row.get(4)?,
                modified_at: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn search_files_filtered(
        &self,
        query: &str,
        limit: usize,
        extensions: Option<&[String]>,
        kinds: Option<&[String]>,
        min_bytes: Option<u64>,
        max_bytes: Option<u64>,
        use_regex: bool,
    ) -> Result<Vec<FileSearchResult>, IndexError> {
        let trimmed_query = query.trim();
        let regex = if use_regex && !trimmed_query.is_empty() {
            match Regex::new(trimmed_query) {
                Ok(regex) => Some(regex),
                Err(_) => return Ok(Vec::new()),
            }
        } else {
            None
        };
        let mut conditions: Vec<String> = vec!["deleted_at IS NULL".to_owned()];
        let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        let mut param_index = 1usize;

        // Text / regex query
        if !trimmed_query.is_empty() && !use_regex {
            let escaped = escape_like_pattern(trimmed_query);
            let pattern = format!("%{escaped}%");
            conditions.push(format!(
                "(name LIKE ?{param_index} ESCAPE '\\' OR path LIKE ?{param_index} ESCAPE '\\')"
            ));
            params.push(Box::new(pattern));
            param_index += 1;
        }

        // Extension filter
        if let Some(exts) = extensions {
            if !exts.is_empty() {
                let placeholders: Vec<String> = exts
                    .iter()
                    .map(|_| {
                        let s = format!("?{param_index}");
                        param_index += 1;
                        s
                    })
                    .collect();
                conditions.push(format!("extension IN ({})", placeholders.join(",")));
                for ext in exts {
                    params.push(Box::new(ext.to_lowercase()));
                }
            }
        }

        // Media kind filter
        if let Some(ks) = kinds {
            if !ks.is_empty() {
                let placeholders: Vec<String> = ks
                    .iter()
                    .map(|_| {
                        let s = format!("?{param_index}");
                        param_index += 1;
                        s
                    })
                    .collect();
                conditions.push(format!("media_kind IN ({})", placeholders.join(",")));
                for k in ks {
                    params.push(Box::new(k.to_lowercase()));
                }
            }
        }

        // Size range
        if let Some(min) = min_bytes {
            conditions.push(format!("size >= ?{param_index}"));
            params.push(Box::new(min as i64));
            param_index += 1;
        }
        if let Some(max) = max_bytes {
            conditions.push(format!("size <= ?{param_index}"));
            params.push(Box::new(max as i64));
            param_index += 1;
        }

        let where_clause = conditions.join(" AND ");
        let limit_clause = if regex.is_some() {
            String::new()
        } else {
            format!(" LIMIT ?{param_index}")
        };
        let sql = format!(
            "SELECT path, name, size, extension, media_kind, modified_at
             FROM files
             WHERE {where_clause}
             ORDER BY size DESC, modified_at DESC{limit_clause}"
        );
        if regex.is_none() {
            params.push(Box::new(limit as i64));
        }

        let mut statement = self.connection.prepare(&sql)?;
        let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        let rows = statement.query_map(param_refs.as_slice(), |row| {
            Ok(FileSearchResult {
                path: row.get(0)?,
                name: row.get(1)?,
                size: row.get(2)?,
                extension: row.get(3)?,
                media_kind: row.get(4)?,
                modified_at: row.get(5)?,
            })
        })?;
        let mut results: Vec<FileSearchResult> = rows.collect::<Result<Vec<_>, _>>()?;

        if let Some(re) = regex {
            results.retain(|file| re.is_match(&file.name) || re.is_match(&file.path));
            results.truncate(limit);
        }

        Ok(results)
    }

    pub fn extension_summaries(&self, limit: usize) -> Result<Vec<ExtensionSummary>, IndexError> {
        let mut statement = self.connection.prepare(
            "SELECT extension, file_count, total_bytes
             FROM extension_stats
             ORDER BY total_bytes DESC
             LIMIT ?1",
        )?;
        let rows = statement.query_map(params![limit as i64], |row| {
            Ok(ExtensionSummary {
                extension: row.get(0)?,
                file_count: row.get(1)?,
                total_bytes: row.get(2)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn duplicate_groups(&self, limit: usize) -> Result<Vec<DuplicateGroupSummary>, IndexError> {
        let mut statement = self.connection.prepare(
            "SELECT dg.id, dg.size, COUNT(dgf.file_id), dg.reclaimable_bytes, dg.confidence
             FROM duplicate_groups dg
             JOIN duplicate_group_files dgf ON dgf.group_id = dg.id
             GROUP BY dg.id
             ORDER BY dg.reclaimable_bytes DESC
             LIMIT ?1",
        )?;
        let rows = statement.query_map(params![limit as i64], |row| {
            Ok(DuplicateGroupSummary {
                id: row.get(0)?,
                size: row.get(1)?,
                file_count: row.get(2)?,
                reclaimable_bytes: row.get(3)?,
                confidence: row.get(4)?,
                sample_paths: Vec::new(),
            })
        })?;
        let mut groups = rows.collect::<Result<Vec<_>, _>>().map_err(IndexError::from)?;

        // A few member paths per group, in one pass — enough for the Board to
        // relate duplicate groups to findings without a per-group fetch.
        let mut sample_statement = self.connection.prepare(
            "WITH top_groups AS (
               SELECT dg.id
               FROM duplicate_groups dg
               JOIN duplicate_group_files dgf ON dgf.group_id = dg.id
               GROUP BY dg.id
               ORDER BY dg.reclaimable_bytes DESC
               LIMIT ?1
             ),
             ranked AS (
               SELECT dgf.group_id AS group_id,
                      files.path AS path,
                      ROW_NUMBER() OVER (
                        PARTITION BY dgf.group_id
                        ORDER BY files.size DESC, files.path ASC
                      ) AS rank
               FROM duplicate_group_files dgf
               JOIN files ON files.id = dgf.file_id
               WHERE files.deleted_at IS NULL
                 AND dgf.group_id IN (SELECT id FROM top_groups)
             )
             SELECT group_id, path FROM ranked WHERE rank <= ?2 ORDER BY group_id, rank",
        )?;
        let sample_rows = sample_statement
            .query_map(params![limit as i64, SAMPLE_PATHS_PER_GROUP], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut paths_by_group: HashMap<i64, Vec<String>> = HashMap::new();
        for (group_id, path) in sample_rows {
            paths_by_group.entry(group_id).or_default().push(path);
        }
        for group in &mut groups {
            if let Some(paths) = paths_by_group.remove(&group.id) {
                group.sample_paths = paths;
            }
        }
        Ok(groups)
    }

    pub fn duplicate_group_files(
        &self,
        group_id: i64,
        limit: usize,
    ) -> Result<Vec<DuplicateFileSummary>, IndexError> {
        let mut statement = self.connection.prepare(
            "SELECT files.path, files.size, files.modified_at, files.hash_state
             FROM duplicate_group_files dgf
             JOIN files ON files.id = dgf.file_id
             WHERE dgf.group_id = ?1 AND files.deleted_at IS NULL
             ORDER BY files.path
             LIMIT ?2",
        )?;
        let rows = statement.query_map(params![group_id, limit as i64], |row| {
            Ok(DuplicateFileSummary {
                path: row.get(0)?,
                size: row.get(1)?,
                modified_at: row.get(2)?,
                hash_state: row.get(3)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Rebuild the materialized overview aggregates (media, per-folder media,
    /// monthly activity, age bands). Runs once per scan finalization so the
    /// startup overview reads small tables instead of full-scanning `files`.
    fn rebuild_derived_stats(&mut self) -> Result<(), IndexError> {
        let tx = self.connection.transaction()?;
        tx.execute_batch(
            "DELETE FROM media_stats;
             INSERT INTO media_stats (media_kind, file_count, total_bytes)
             SELECT media_kind, COUNT(*), COALESCE(SUM(size), 0)
             FROM files
             WHERE deleted_at IS NULL
             GROUP BY media_kind;

             DELETE FROM folder_media_stats;
             INSERT INTO folder_media_stats (folder_path, media_kind, total_bytes)
             SELECT f.path, files.media_kind, COALESCE(SUM(files.size), 0)
             FROM files
             JOIN folders f ON f.id = files.folder_id
             WHERE files.deleted_at IS NULL
             GROUP BY f.path, files.media_kind;

             DELETE FROM month_stats;
             INSERT INTO month_stats (bucket, file_count, total_bytes)
             SELECT COALESCE(strftime('%Y-%m', modified_at, 'unixepoch'), 'unknown'),
                    COUNT(*),
                    COALESCE(SUM(size), 0)
             FROM files
             WHERE deleted_at IS NULL
             GROUP BY 1;

             DELETE FROM age_stats;
             INSERT INTO age_stats (bucket, file_count, total_bytes)
             SELECT CASE
                      WHEN modified_at IS NULL THEN 'unknown'
                      WHEN age < 2592000 THEN 'lt1mo'
                      WHEN age < 7776000 THEN '1to3mo'
                      WHEN age < 15552000 THEN '3to6mo'
                      WHEN age < 31536000 THEN '6to12mo'
                      WHEN age < 63072000 THEN '1to2yr'
                      ELSE 'gt2yr'
                    END AS bucket,
                    COUNT(*),
                    COALESCE(SUM(size), 0)
             FROM (
               SELECT modified_at,
                      size,
                      CAST(strftime('%s', 'now') AS INTEGER) - modified_at AS age
               FROM files
               WHERE deleted_at IS NULL
             )
             GROUP BY bucket;",
        )?;
        tx.commit()?;
        Ok(())
    }

    fn has_rows(&self, table: &str) -> Result<bool, IndexError> {
        let count: i64 = self
            .connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0))?;
        Ok(count > 0)
    }

    pub fn media_summaries(&self) -> Result<Vec<MediaSummary>, IndexError> {
        // Empty stats table = index last scanned before materialization landed
        // (or an empty index) — fall back to the live aggregate.
        let sql = if self.has_rows("media_stats")? {
            "SELECT media_kind, file_count, total_bytes
             FROM media_stats
             ORDER BY total_bytes DESC"
        } else {
            "SELECT media_kind, COUNT(*), COALESCE(SUM(size), 0)
             FROM files
             WHERE deleted_at IS NULL
             GROUP BY media_kind
             ORDER BY SUM(size) DESC"
        };
        let mut statement = self.connection.prepare(sql)?;
        let rows = statement.query_map([], |row| {
            Ok(MediaSummary {
                media_kind: row.get(0)?,
                file_count: row.get(1)?,
                total_bytes: row.get(2)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn folder_media_summaries(
        &self,
        limit: usize,
    ) -> Result<Vec<FolderMediaSummary>, IndexError> {
        let sql = if self.has_rows("folder_media_stats")? {
            "SELECT folder_path, media_kind, total_bytes
             FROM folder_media_stats
             ORDER BY total_bytes DESC
             LIMIT ?1"
        } else {
            "SELECT f.path, files.media_kind, COALESCE(SUM(files.size), 0) AS total_bytes
             FROM files
             JOIN folders f ON f.id = files.folder_id
             WHERE files.deleted_at IS NULL
             GROUP BY f.path, files.media_kind
             ORDER BY total_bytes DESC
             LIMIT ?1"
        };
        let mut statement = self.connection.prepare(sql)?;
        let rows = statement.query_map(params![limit as i64], |row| {
            Ok(FolderMediaSummary {
                folder_path: row.get(0)?,
                media_kind: row.get(1)?,
                total_bytes: row.get(2)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    fn migrate(&self) -> Result<(), IndexError> {
        self.connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
              version INTEGER PRIMARY KEY,
              applied_at INTEGER NOT NULL
            );",
        )?;

        for (version, migration) in ALL_MIGRATIONS {
            let already_applied = self
                .connection
                .query_row(
                    "SELECT 1 FROM schema_migrations WHERE version = ?1",
                    params![*version as i64],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();

            if !already_applied {
                self.connection.execute_batch(migration)?;
            }
        }
        Ok(())
    }

    fn start_session(&mut self, root: &Path) -> Result<(), IndexError> {
        let started_at = now_millis();
        self.folder_ids.clear();
        self.files_since_commit = 0;
        self.begin_scan_transaction()?;
        self.connection.execute(
            "INSERT INTO scan_sessions (root_path, started_at, status, scan_strategy) VALUES (?1, ?2, 'running', ?3)",
            params![path_to_string(root), started_at, self.active_scan_mode.as_id()],
        )?;
        self.session_id = Some(self.connection.last_insert_rowid());
        self.active_root = Some(root.to_path_buf());
        self.active_scan_started_at = Some(started_at);
        self.ensure_folder(root)?;
        Ok(())
    }

    fn begin_scan_transaction(&mut self) -> Result<(), IndexError> {
        if !self.scan_transaction_open {
            self.connection
                .execute_batch("BEGIN IMMEDIATE TRANSACTION")?;
            self.scan_transaction_open = true;
        }
        Ok(())
    }

    fn commit_scan_transaction(&mut self) -> Result<(), IndexError> {
        if self.scan_transaction_open {
            self.connection.execute_batch("COMMIT")?;
            self.scan_transaction_open = false;
        }
        Ok(())
    }

    fn finish_session(&mut self, status: &str, stats: &ScanStats) -> Result<(), IndexError> {
        let session_id = self.session_id.ok_or(IndexError::MissingSession)?;
        self.connection.execute(
            "UPDATE scan_sessions
             SET finished_at = ?1,
                 status = ?2,
                 files_scanned = ?3,
                 folders_scanned = ?4,
                 bytes_scanned = ?5,
                 inaccessible_entries = ?6
             WHERE id = ?7",
            params![
                now_millis(),
                status,
                stats.files_scanned as i64,
                stats.folders_scanned as i64,
                stats.bytes_scanned as i64,
                stats.inaccessible_entries as i64,
                session_id
            ],
        )?;
        Ok(())
    }

    fn record_scan_issue(&mut self, phase: &str, path: &str, message: &str) -> Result<(), IndexError> {
        let scan_id = self.current_scan_session_id()?;
        insert_scan_issue(&self.connection, scan_id, phase, path, message)
    }

    fn current_scan_session_id(&self) -> Result<i64, IndexError> {
        if let Some(session_id) = self.session_id {
            return Ok(session_id);
        }

        self.connection
            .query_row(
                "SELECT id FROM scan_sessions ORDER BY started_at DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()?
            .ok_or(IndexError::MissingSession)
    }

    fn prepare_duplicate_refinement_jobs(&mut self) -> Result<(), IndexError> {
        let scan_id = self.current_scan_session_id()?;
        let now = now_millis();
        let tx = self.connection.transaction()?;

        tx.execute("DELETE FROM duplicate_group_files", [])?;
        tx.execute("DELETE FROM duplicate_groups", [])?;
        tx.execute("DELETE FROM hash_jobs WHERE scan_id = ?1", params![scan_id])?;
        tx.execute(
            "DELETE FROM duplicate_candidates WHERE scan_id = ?1",
            params![scan_id],
        )?;
        tx.execute(
            "INSERT INTO duplicate_candidates (scan_id, size, file_count, total_bytes, status, updated_at)
             SELECT ?1, size, COUNT(*), COALESCE(SUM(size), 0), 'pending', ?2
             FROM files
             WHERE deleted_at IS NULL AND size > 0
             GROUP BY size
             HAVING COUNT(*) > 1",
            params![scan_id, now],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO hash_jobs (scan_id, file_id, job_type, priority, status, created_at)
             SELECT ?1, files.id, 'sample', files.size, 'pending', ?2
             FROM files
             JOIN duplicate_candidates dc ON dc.scan_id = ?1 AND dc.size = files.size
             WHERE files.deleted_at IS NULL",
            params![scan_id, now],
        )?;

        tx.commit()?;
        Ok(())
    }

    fn mark_duplicate_candidates_status(
        &mut self,
        scan_id: i64,
        status: &str,
    ) -> Result<(), IndexError> {
        self.connection.execute(
            "UPDATE duplicate_candidates SET status = ?1, updated_at = ?2 WHERE scan_id = ?3",
            params![status, now_millis(), scan_id],
        )?;
        Ok(())
    }

    fn mark_hash_jobs_running(&mut self, scan_id: i64, job_type: &str) -> Result<(), IndexError> {
        self.connection.execute(
            "UPDATE hash_jobs
             SET status = 'running', started_at = ?1
             WHERE scan_id = ?2 AND job_type = ?3 AND status = 'pending'",
            params![now_millis(), scan_id, job_type],
        )?;
        Ok(())
    }

    fn mark_hash_jobs_completed(&mut self, scan_id: i64, job_type: &str) -> Result<(), IndexError> {
        self.connection.execute(
            "UPDATE hash_jobs
             SET status = 'completed', completed_at = ?1
             WHERE scan_id = ?2 AND job_type = ?3 AND status IN ('pending', 'running')",
            params![now_millis(), scan_id, job_type],
        )?;
        Ok(())
    }

    fn record_completed_full_hash_jobs(&mut self, scan_id: i64) -> Result<(), IndexError> {
        let now = now_millis();
        self.connection.execute(
            "INSERT OR IGNORE INTO hash_jobs (
                 scan_id, file_id, job_type, priority, status, created_at, started_at, completed_at
             )
             SELECT ?1, id, 'full', size, 'completed', ?2, ?2, ?2
             FROM files
             WHERE deleted_at IS NULL AND full_hash IS NOT NULL",
            params![scan_id, now],
        )?;
        Ok(())
    }

    fn mark_missing_files_deleted(&self) -> Result<(), IndexError> {
        let Some(root) = &self.active_root else {
            return Ok(());
        };
        let Some(started_at) = self.active_scan_started_at else {
            return Ok(());
        };

        let root_text = path_to_string(root);
        let root_prefix = path_prefix(root);
        self.connection.execute(
            "UPDATE files
             SET deleted_at = ?1
             WHERE deleted_at IS NULL
               AND indexed_at < ?2
               AND (path = ?3 OR path LIKE ?4)",
            params![
                now_millis(),
                started_at,
                root_text,
                format!("{root_prefix}%")
            ],
        )?;
        Ok(())
    }

    fn capture_timeline(&self, root: &Path, stats: &ScanStats) -> Result<(), IndexError> {
        self.connection.execute(
            "INSERT INTO timeline_history (root_path, captured_at, total_bytes, file_count, folder_count)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                path_to_string(root),
                now_millis(),
                stats.bytes_scanned as i64,
                stats.files_scanned as i64,
                stats.folders_scanned as i64
            ],
        )?;
        Ok(())
    }

    fn rebuild_extension_stats(&mut self) -> Result<(), IndexError> {
        let tx = self.connection.transaction()?;
        tx.execute("DELETE FROM extension_stats", [])?;
        tx.execute(
            "INSERT INTO extension_stats (extension, file_count, total_bytes, updated_at)
             SELECT extension, COUNT(*), COALESCE(SUM(size), 0), ?1
             FROM files
             WHERE deleted_at IS NULL AND extension IS NOT NULL
             GROUP BY extension",
            params![now_millis()],
        )?;
        tx.commit()?;
        Ok(())
    }

    fn rebuild_duplicate_size_groups(&mut self) -> Result<(), IndexError> {
        let tx = self.connection.transaction()?;
        tx.execute("DELETE FROM duplicate_group_files", [])?;
        tx.execute("DELETE FROM duplicate_groups", [])?;

        let groups = {
            let mut statement = tx.prepare(
                "SELECT size,
                        partial_hash,
                        sample_hash,
                        full_hash,
                        CASE
                          WHEN full_hash IS NOT NULL THEN 1.0
                          WHEN sample_hash IS NOT NULL THEN 0.80
                          ELSE 0.60
                        END AS confidence,
                        COUNT(*) AS file_count,
                        size * (COUNT(*) - 1) AS reclaimable_bytes
                 FROM files
                 -- Files whose hashing failed or was skipped (locked, permission
                 -- denied, cloud placeholders, vanished) keep NULL hashes; SQL
                 -- GROUP BY treats NULLs as equal, so without this filter every
                 -- same-size unhashed file — a video and a document alike —
                 -- collapses into one phantom \"duplicate\" group.
                 WHERE deleted_at IS NULL AND size > 0 AND partial_hash IS NOT NULL
                 GROUP BY size, partial_hash, sample_hash, full_hash
                 HAVING COUNT(*) > 1
                 ORDER BY reclaimable_bytes DESC",
            )?;
            let rows = statement.query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, f64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                ))
            })?;

            rows.collect::<Result<Vec<_>, _>>()?
        };

        for (
            size,
            partial_hash,
            sample_hash,
            full_hash,
            confidence,
            _file_count,
            reclaimable_bytes,
        ) in groups
        {
            tx.execute(
                "INSERT INTO duplicate_groups (size, partial_hash, sample_hash, full_hash, confidence, reclaimable_bytes, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![size, partial_hash, sample_hash, full_hash, confidence, reclaimable_bytes, now_millis()],
            )?;
            let group_id = tx.last_insert_rowid();
            if let Some(full_hash) = full_hash {
                tx.execute(
                    "INSERT INTO duplicate_group_files (group_id, file_id)
                     SELECT ?1, id FROM files
                     WHERE deleted_at IS NULL AND size = ?2 AND full_hash = ?3",
                    params![group_id, size, full_hash],
                )?;
            } else if let Some(sample_hash) = sample_hash {
                tx.execute(
                    "INSERT INTO duplicate_group_files (group_id, file_id)
                     SELECT ?1, id FROM files WHERE deleted_at IS NULL AND size = ?2 AND sample_hash = ?3",
                    params![group_id, size, sample_hash],
                )?;
            } else if let Some(partial_hash) = partial_hash {
                tx.execute(
                    "INSERT INTO duplicate_group_files (group_id, file_id)
                     SELECT ?1, id FROM files WHERE deleted_at IS NULL AND size = ?2 AND partial_hash = ?3",
                    params![group_id, size, partial_hash],
                )?;
            }
            // No hash at all never forms a group: the grouping query above
            // requires partial_hash, so size-only coincidences are excluded.
        }

        tx.commit()?;
        Ok(())
    }

    fn recompute_folder_rollups<F>(&mut self, progress: &mut F) -> Result<(), IndexError>
    where
        F: FnMut(FinalizationProgress),
    {
        progress_stage(progress, "Computing folder totals", 0, 1);
        let tx = self.connection.transaction()?;

        // Clean up any leftover temp table from a previous interrupted run.
        tx.execute("DROP TABLE IF EXISTS _folder_direct", [])?;

        // Per-folder direct file counts/bytes.
        tx.execute(
            "CREATE TEMP TABLE _folder_direct AS
             SELECT folder_id AS id,
                    COUNT(*)             AS direct_files,
                    COALESCE(SUM(size),0) AS direct_bytes
             FROM files
             WHERE deleted_at IS NULL
             GROUP BY folder_id",
            [],
        )?;

        // Roll each folder's direct totals up to every ancestor via a recursive
        // walk from each folder to the root.
        tx.execute(
            "WITH RECURSIVE ancestry(start_id, node_id) AS (
                 SELECT id, id FROM folders
                 UNION ALL
                 SELECT a.start_id, f.parent_id
                 FROM ancestry a
                 JOIN folders f ON f.id = a.node_id
                 WHERE f.parent_id IS NOT NULL
             )
             UPDATE folders SET
                total_files = COALESCE((
                    SELECT SUM(d.direct_files)
                    FROM ancestry a
                    JOIN _folder_direct d ON d.id = a.start_id
                    WHERE a.node_id = folders.id), 0),
                total_bytes = COALESCE((
                    SELECT SUM(d.direct_bytes)
                    FROM ancestry a
                    JOIN _folder_direct d ON d.id = a.start_id
                    WHERE a.node_id = folders.id), 0)",
            [],
        )?;

        tx.execute("DROP TABLE _folder_direct", [])?;
        tx.commit()?;
        progress_stage(progress, "Computing folder totals", 1, 1);
        Ok(())
    }

    fn index_folder(&mut self, folder: &FolderRecord) -> Result<(), IndexError> {
        let folder_id = self.ensure_folder(&folder.path)?;
        self.connection.execute(
            "UPDATE folders
             SET direct_files = ?1,
                 direct_bytes = ?2,
                 total_files = MAX(total_files, ?1),
                 total_bytes = MAX(total_bytes, ?2),
                 indexed_at = ?3
             WHERE id = ?4",
            params![
                folder.direct_files as i64,
                folder.direct_bytes as i64,
                self.active_scan_started_at.unwrap_or_else(now_millis),
                folder_id
            ],
        )?;
        Ok(())
    }

    fn index_file(&mut self, file: &FileRecord) -> Result<(), IndexError> {
        let folder_id = self.ensure_folder(&file.parent)?;
        self.connection.execute(
            "INSERT INTO files (
                folder_id, path, name, extension, size, modified_at, accessed_at, created_at, media_kind, indexed_at, deleted_at
             )
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL)
             ON CONFLICT(path) DO UPDATE SET
                partial_hash = CASE
                    WHEN files.size IS NOT excluded.size
                      OR files.modified_at IS NOT excluded.modified_at
                      OR files.created_at IS NOT excluded.created_at
                    THEN NULL ELSE files.partial_hash END,
                sample_hash = CASE
                    WHEN files.size IS NOT excluded.size
                      OR files.modified_at IS NOT excluded.modified_at
                      OR files.created_at IS NOT excluded.created_at
                    THEN NULL ELSE files.sample_hash END,
                full_hash = CASE
                    WHEN files.size IS NOT excluded.size
                      OR files.modified_at IS NOT excluded.modified_at
                      OR files.created_at IS NOT excluded.created_at
                    THEN NULL ELSE files.full_hash END,
                hash_algorithm = CASE
                    WHEN files.size IS NOT excluded.size
                      OR files.modified_at IS NOT excluded.modified_at
                      OR files.created_at IS NOT excluded.created_at
                    THEN NULL ELSE files.hash_algorithm END,
                hash_state = CASE
                    WHEN files.size IS NOT excluded.size
                      OR files.modified_at IS NOT excluded.modified_at
                      OR files.created_at IS NOT excluded.created_at
                    THEN 0 ELSE files.hash_state END,
                folder_id = excluded.folder_id,
                name = excluded.name,
                extension = excluded.extension,
                size = excluded.size,
                modified_at = excluded.modified_at,
                accessed_at = excluded.accessed_at,
                created_at = excluded.created_at,
                media_kind = excluded.media_kind,
                indexed_at = excluded.indexed_at,
                deleted_at = NULL",
            params![
                folder_id,
                path_to_string(&file.path),
                file.name,
                file.extension,
                file.size as i64,
                system_time_to_unix(file.modified),
                system_time_to_unix(file.accessed),
                system_time_to_unix(file.created),
                classify_media_kind(file.extension.as_deref()),
                self.active_scan_started_at.unwrap_or_else(now_millis)
            ],
        )?;

        self.maybe_commit_crawl_batch()?;
        Ok(())
    }

    fn ensure_folder(&mut self, path: &Path) -> Result<i64, IndexError> {
        if let Some(id) = self.folder_ids.get(path) {
            return Ok(*id);
        }

        let parent_id = path
            .parent()
            .filter(|parent| *parent != path && !parent.as_os_str().is_empty())
            .map(|parent| self.ensure_folder(parent))
            .transpose()?;

        let path_text = path_to_string(path);
        let existing = self
            .connection
            .query_row(
                "SELECT id FROM folders WHERE path = ?1",
                params![path_text],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;

        if let Some(id) = existing {
            self.folder_ids.insert(path.to_path_buf(), id);
            return Ok(id);
        }

        self.connection.execute(
            "INSERT INTO folders (parent_id, path, name, depth, indexed_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                parent_id,
                path_text,
                folder_name(path),
                path.components().count() as i64,
                self.active_scan_started_at.unwrap_or_else(now_millis)
            ],
        )?;
        let id = self.connection.last_insert_rowid();
        self.folder_ids.insert(path.to_path_buf(), id);
        Ok(id)
    }
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Insert one scan issue, silently dropping rows past the per-scan cap.
/// Shared by the walk (writer) and hash (algorithms) phases.
pub(crate) fn insert_scan_issue(
    connection: &Connection,
    scan_id: i64,
    phase: &str,
    path: &str,
    message: &str,
) -> Result<(), IndexError> {
    connection.execute(
        "INSERT INTO scan_issues (scan_id, phase, path, message, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5
         WHERE (SELECT COUNT(*) FROM scan_issues WHERE scan_id = ?1) < ?6",
        params![scan_id, phase, path, message, now_millis(), SCAN_ISSUES_CAP],
    )?;
    Ok(())
}

fn path_prefix(path: &Path) -> String {
    let mut path = path_to_string(path);
    if !path.ends_with(std::path::MAIN_SEPARATOR) {
        path.push(std::path::MAIN_SEPARATOR);
    }
    path
}

fn folder_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| path_to_string(path))
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

fn system_time_to_unix(time: Option<SystemTime>) -> Option<i64> {
    time.and_then(|time| {
        time.duration_since(UNIX_EPOCH)
            .ok()
            .map(|duration| duration.as_secs() as i64)
    })
}

fn classify_media_kind(extension: Option<&str>) -> &'static str {
    match extension.unwrap_or_default() {
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "tiff" | "heic" | "raw" => "photo",
        "mp4" | "mkv" | "avi" | "mov" | "wmv" | "flv" | "webm" | "m4v" => "video",
        "mp3" | "flac" | "wav" | "aac" | "ogg" | "m4a" => "music",
        "zip" | "rar" | "7z" | "tar" | "gz" | "xz" => "archive",
        "pdf" | "doc" | "docx" | "xls" | "xlsx" | "txt" | "md" => "document",
        "rs" | "js" | "ts" | "tsx" | "jsx" | "py" | "go" | "java" | "html" | "css" => "code",
        "exe" | "msi" | "dmg" | "pkg" | "deb" | "rpm" => "installer",
        "safetensors" | "ckpt" | "pt" | "pth" | "onnx" | "gguf" => "model",
        _ => "other",
    }
}

fn escape_like_pattern(query: &str) -> String {
    let mut escaped = String::with_capacity(query.len());
    for character in query.chars() {
        if matches!(character, '%' | '_' | '\\') {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

pub(crate) fn progress_stage<F>(
    progress: &mut F,
    message: &str,
    progress_current: u64,
    progress_total: u64,
) where
    F: FnMut(FinalizationProgress),
{
    progress(FinalizationProgress {
        message: message.to_owned(),
        progress_current,
        progress_total,
    });
}

pub(crate) fn emit_counted_progress<F>(
    progress: &mut F,
    message: &str,
    progress_current: u64,
    progress_total: u64,
) where
    F: FnMut(FinalizationProgress),
{
    if progress_total <= 1
        || progress_current == progress_total
        || progress_current == 1
        || progress_current % 128 == 0
    {
        progress_stage(progress, message, progress_current, progress_total);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scanner::{ScanEvent, ScanOptions, Scanner};
    use std::fs::{self, File};
    use std::io::Write;

    #[test]
    fn writes_scan_events_to_sqlite() {
        let root = test_root("writer");
        fs::create_dir_all(root.join("media")).expect("failed to create folders");
        write_file(&root.join("media").join("clip.mp4"), &[1; 128]);
        write_file(&root.join("notes.md"), b"hello");

        let scanner = Scanner::new(ScanOptions {
            root: root.clone(),
            workers: 2,
        });
        let events = scanner.scan();
        let mut writer = IndexWriter::open_in_memory().expect("failed to open sqlite index");

        for event in events {
            writer.handle_event(&event).expect("failed to index event");
            if matches!(event, ScanEvent::Finished(_)) {
                break;
            }
        }

        let file_count: i64 = writer
            .connection()
            .query_row("SELECT COUNT(*) FROM files", [], |row| row.get(0))
            .expect("failed to count files");
        let session_status: String = writer
            .connection()
            .query_row("SELECT status FROM scan_sessions LIMIT 1", [], |row| {
                row.get(0)
            })
            .expect("failed to read session");
        let timeline_count: i64 = writer
            .connection()
            .query_row("SELECT COUNT(*) FROM timeline_history", [], |row| {
                row.get(0)
            })
            .expect("failed to count timeline rows");
        let duplicate_group_count: i64 = writer
            .connection()
            .query_row("SELECT COUNT(*) FROM duplicate_groups", [], |row| {
                row.get(0)
            })
            .expect("failed to count duplicate groups");
        let root_total_bytes: i64 = writer
            .connection()
            .query_row(
                "SELECT total_bytes FROM folders WHERE path = ?1",
                params![path_to_string(&root)],
                |row| row.get(0),
            )
            .expect("failed to read root rollup");

        assert_eq!(file_count, 2);
        assert_eq!(session_status, "complete");
        assert_eq!(timeline_count, 1);
        assert_eq!(duplicate_group_count, 0);
        assert_eq!(root_total_bytes, 133);
        cleanup(&root);
    }

    #[test]
    fn creates_stage_one_duplicate_groups_by_size() {
        let root = test_root("duplicates");
        fs::create_dir_all(&root).expect("failed to create folder");
        write_file(&root.join("one.bin"), &[1; 32]);
        write_file(&root.join("two.bin"), &[1; 32]);
        write_file(&root.join("unique.bin"), &[3; 64]);

        let scanner = Scanner::new(ScanOptions {
            root: root.clone(),
            workers: 2,
        });
        let events = scanner.scan();
        let mut writer = IndexWriter::open_in_memory().expect("failed to open sqlite index");

        for event in events {
            writer.handle_event(&event).expect("failed to index event");
            if matches!(event, ScanEvent::Finished(_)) {
                break;
            }
        }
        writer
            .refine_duplicates()
            .expect("failed to refine duplicates");

        let duplicate_group_count: i64 = writer
            .connection()
            .query_row("SELECT COUNT(*) FROM duplicate_groups", [], |row| {
                row.get(0)
            })
            .expect("failed to count duplicate groups");
        let duplicate_group_id: i64 = writer
            .connection()
            .query_row("SELECT id FROM duplicate_groups", [], |row| row.get(0))
            .expect("failed to read duplicate group id");
        let duplicate_file_count: i64 = writer
            .connection()
            .query_row("SELECT COUNT(*) FROM duplicate_group_files", [], |row| {
                row.get(0)
            })
            .expect("failed to count duplicate files");
        let reclaimable_bytes: i64 = writer
            .connection()
            .query_row(
                "SELECT reclaimable_bytes FROM duplicate_groups",
                [],
                |row| row.get(0),
            )
            .expect("failed to read reclaimable bytes");
        let confidence: f64 = writer
            .connection()
            .query_row("SELECT confidence FROM duplicate_groups", [], |row| {
                row.get(0)
            })
            .expect("failed to read confidence");
        let full_hashes: i64 = writer
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM files WHERE full_hash IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .expect("failed to count full hashes");

        assert_eq!(duplicate_group_count, 1);
        assert_eq!(duplicate_file_count, 2);
        assert_eq!(reclaimable_bytes, 32);
        assert_eq!(confidence, 1.0);
        assert_eq!(full_hashes, 2);
        assert_eq!(
            writer
                .duplicate_group_files(duplicate_group_id, 10)
                .expect("duplicate group files")
                .len(),
            2
        );
        cleanup(&root);
    }

    #[test]
    fn unhashed_same_size_files_never_group_as_duplicates() {
        // Files whose hashing failed (locked, permission denied, cloud
        // placeholders) keep NULL hashes. Same size + NULL hashes must NOT
        // form a group — that's how a video and a document got paired.
        let mut writer = IndexWriter::open_in_memory().expect("failed to open sqlite index");
        writer
            .connection()
            .execute_batch(
                "INSERT INTO folders (id, path, name, depth, indexed_at) VALUES (1, '/r', 'r', 0, 0);
                 INSERT INTO files (folder_id, path, name, size, indexed_at)
                 VALUES (1, '/r/movie.mp4', 'movie.mp4', 4096, 0),
                        (1, '/r/report.pdf', 'report.pdf', 4096, 0);",
            )
            .expect("failed to seed unhashed files");

        writer
            .rebuild_duplicate_size_groups()
            .expect("failed to rebuild duplicate groups");

        let group_count: i64 = writer
            .connection()
            .query_row("SELECT COUNT(*) FROM duplicate_groups", [], |row| {
                row.get(0)
            })
            .expect("failed to count duplicate groups");
        assert_eq!(group_count, 0, "size-only coincidences are not duplicates");
    }

    #[test]
    fn walk_errors_are_recorded_as_scan_issues() {
        let root = test_root("issues-walk");
        fs::create_dir_all(&root).expect("failed to create folder");
        write_file(&root.join("one.bin"), &[1; 16]);

        let scanner = Scanner::new(ScanOptions {
            root: root.clone(),
            workers: 1,
        });
        let events = scanner.scan();
        let mut writer = IndexWriter::open_in_memory().expect("failed to open sqlite index");
        for event in events {
            let finished = matches!(event, ScanEvent::Finished(_));
            if finished {
                // Inject an unreadable-directory error the way a worker reports one.
                writer
                    .handle_event(&ScanEvent::Error(crate::scanner::ScanError {
                        path: root.join("locked-folder"),
                        message: "Access is denied. (os error 5)".to_owned(),
                    }))
                    .expect("failed to record error event");
            }
            writer.handle_event(&event).expect("failed to index event");
            if finished {
                break;
            }
        }

        let issues = writer.scan_issues(10).expect("scan issues");
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].phase, "walk");
        assert!(issues[0].path.ends_with("locked-folder"));
        assert!(issues[0].message.contains("denied"));
        cleanup(&root);
    }

    #[test]
    fn hash_failures_surface_as_scan_issues() {
        let root = test_root("issues-hash");
        fs::create_dir_all(&root).expect("failed to create folder");
        write_file(&root.join("real.bin"), &[7; 64]);

        let scanner = Scanner::new(ScanOptions {
            root: root.clone(),
            workers: 1,
        });
        let events = scanner.scan();
        let mut writer = IndexWriter::open_in_memory().expect("failed to open sqlite index");
        for event in events {
            writer.handle_event(&event).expect("failed to index event");
            if matches!(event, ScanEvent::Finished(_)) {
                break;
            }
        }

        // Two same-size candidates whose backing files no longer exist —
        // hashing must fail, record issues, and never group them.
        writer
            .connection()
            .execute_batch(
                "INSERT INTO files (folder_id, path, name, size, indexed_at)
                 SELECT id, '/gone/movie.mp4', 'movie.mp4', 4096, 0 FROM folders LIMIT 1;
                 INSERT INTO files (folder_id, path, name, size, indexed_at)
                 SELECT id, '/gone/report.pdf', 'report.pdf', 4096, 0 FROM folders LIMIT 1;",
            )
            .expect("failed to seed phantom files");

        writer.refine_duplicates().expect("failed to refine");

        let issues = writer.scan_issues(10).expect("scan issues");
        let hash_issues: Vec<_> = issues.iter().filter(|i| i.phase == "hash").collect();
        assert_eq!(hash_issues.len(), 2, "both unreadable files reported");
        let (_, hash_count) = writer.scan_issue_counts().expect("issue counts");
        assert_eq!(hash_count, 2);
        let groups: i64 = writer
            .connection()
            .query_row("SELECT COUNT(*) FROM duplicate_groups", [], |row| row.get(0))
            .expect("group count");
        assert_eq!(groups, 0, "unhashable files never form groups");
        cleanup(&root);
    }

    /// Not a correctness test — a measurement harness for the startup "load
    /// index" cost. Builds a ~700k-file index on disk (cold-cache HDD effects
    /// excluded) and times every section the overview query runs.
    /// Run: cargo test --release bench_overview -- --ignored --nocapture
    #[test]
    #[ignore]
    fn bench_overview_sections_on_large_index() {
        use std::time::Instant;
        const FILES: i64 = 700_000;
        const FOLDERS: i64 = 25_000;
        const DUP_PAIRS: i64 = 3_000;

        let dir = std::env::temp_dir().join("birdseye-bench");
        fs::create_dir_all(&dir).expect("bench dir");
        let db = dir.join("bench.sqlite");
        let _ = fs::remove_file(&db);
        let mut writer = IndexWriter::open(&db).expect("open bench index");

        let build_start = Instant::now();
        {
            let tx = writer.connection.transaction().expect("tx");
            tx.execute(
                "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at) VALUES (1, NULL, 'D:\\bench', 'bench', 1, 0)",
                [],
            )
            .expect("root");
            {
                let mut stmt = tx
                    .prepare("INSERT INTO folders (id, parent_id, path, name, depth, indexed_at) VALUES (?1, 1, ?2, ?3, 2, 0)")
                    .expect("prep folders");
                for i in 0..FOLDERS {
                    stmt.execute(params![i + 2, format!("D:\\bench\\f{i}"), format!("f{i}")])
                        .expect("folder row");
                }
            }
            {
                let exts = ["jpg", "mp4", "pdf", "rs", "zip", "exe", "txt", "png", "mp3", "bin"];
                let mut stmt = tx
                    .prepare(
                        "INSERT INTO files (folder_id, path, name, extension, size, modified_at, media_kind, indexed_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)",
                    )
                    .expect("prep files");
                for i in 0..FILES {
                    let h = (i.wrapping_mul(2654435761)) as u64;
                    let ext = exts[(h % 10) as usize];
                    stmt.execute(params![
                        (i % FOLDERS) + 2,
                        format!("D:\\bench\\f{}\\file{i}.{ext}", i % FOLDERS),
                        format!("file{i}.{ext}"),
                        ext,
                        (h % 500_000_000) as i64,
                        1_600_000_000_i64 + ((h % 94_608_000) as i64), // ~3yr spread
                        classify_media_kind(Some(ext)),
                    ])
                    .expect("file row");
                }
            }
            {
                // Duplicate pairs: shared size+hashes so group rebuilding is exercised.
                let mut stmt = tx
                    .prepare(
                        "INSERT INTO files (folder_id, path, name, extension, size, modified_at, media_kind,
                                            partial_hash, sample_hash, full_hash, hash_state, indexed_at)
                         VALUES (?1, ?2, ?3, 'dup', ?4, 0, 'other', ?5, ?5, ?5, 4, 0)",
                    )
                    .expect("prep dups");
                for i in 0..DUP_PAIRS {
                    for copy in 0..2 {
                        stmt.execute(params![
                            (i % FOLDERS) + 2,
                            format!("D:\\bench\\f{}\\dup{i}-{copy}.dup", i % FOLDERS),
                            format!("dup{i}-{copy}.dup"),
                            1_000_000 + i,
                            format!("{i:032x}"),
                        ])
                        .expect("dup row");
                    }
                }
            }
            tx.commit().expect("commit");
        }
        writer
            .recompute_folder_rollups(&mut |_| {})
            .expect("rollups");
        writer.rebuild_extension_stats().expect("ext stats");
        writer
            .rebuild_duplicate_size_groups()
            .expect("dup groups");
        writer.rebuild_derived_stats().expect("derived stats");
        println!("build: {:?}", build_start.elapsed());

        // Fresh writer = fresh connection + page cache like a real app start.
        drop(writer);
        let open_start = Instant::now();
        let writer = IndexWriter::open(&db).expect("reopen");
        println!("open+migrate: {:?}", open_start.elapsed());

        let section = |name: &str, run: &mut dyn FnMut()| {
            let t = Instant::now();
            run();
            println!("{name}: {:?}", t.elapsed());
        };
        section("largest_folders(4000)", &mut || {
            writer.largest_folders(4000).expect("folders");
        });
        section("largest_files(4000)", &mut || {
            writer.largest_files(4000).expect("files");
        });
        section("extension_summaries(4000)", &mut || {
            writer.extension_summaries(4000).expect("ext");
        });
        section("duplicate_groups(4000)", &mut || {
            writer.duplicate_groups(4000).expect("dups");
        });
        section("media_summaries", &mut || {
            writer.media_summaries().expect("media");
        });
        section("folder_media_summaries(24000)", &mut || {
            writer.folder_media_summaries(24000).expect("folder media");
        });
        section("timeline_summaries(24)", &mut || {
            writer.timeline_summaries(24).expect("timeline");
        });
        section("age_summaries", &mut || {
            writer.age_summaries().expect("age");
        });
        section("scan_issue_counts", &mut || {
            writer.scan_issue_counts().ok();
        });
    }

    #[test]
    fn probe_folders_recovers_previously_unreadable_directories() {
        let root = test_root("issues-probe");
        fs::create_dir_all(&root).expect("failed to create folder");
        write_file(&root.join("seen.bin"), &[1; 16]);

        let scanner = Scanner::new(ScanOptions {
            root: root.clone(),
            workers: 1,
        });
        let events = scanner.scan();
        let mut writer = IndexWriter::open_in_memory().expect("failed to open sqlite index");
        for event in events {
            writer.handle_event(&event).expect("failed to index event");
            if matches!(event, ScanEvent::Finished(_)) {
                break;
            }
        }

        // A directory the walk couldn't read at scan time... that is readable now.
        let locked = root.join("was-locked");
        fs::create_dir_all(&locked).expect("failed to create folder");
        write_file(&locked.join("recovered.bin"), &[2; 96]);
        writer
            .handle_event(&ScanEvent::Error(crate::scanner::ScanError {
                path: locked.clone(),
                message: "Access is denied. (os error 5)".to_owned(),
            }))
            .expect("failed to record error event");
        assert_eq!(writer.scan_issues(10).expect("issues").len(), 1);

        writer.probe_folders(&[locked.clone()]).expect("probe failed");

        let issues = writer.scan_issues(10).expect("issues");
        assert!(issues.is_empty(), "recovered directory clears its issue");
        let (walk_count, _) = writer.scan_issue_counts().expect("counts");
        assert_eq!(walk_count, 0, "session tally reconciled after probe");
        let recovered: i64 = writer
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM files WHERE deleted_at IS NULL AND path LIKE '%recovered.bin'",
                [],
                |row| row.get(0),
            )
            .expect("recovered file count");
        assert_eq!(recovered, 1, "probed file lands in the index");
        let rollup: i64 = writer
            .connection()
            .query_row(
                "SELECT total_bytes FROM folders WHERE path = ?1",
                params![path_to_string(&root)],
                |row| row.get(0),
            )
            .expect("root rollup");
        assert_eq!(rollup, 16 + 96, "rollups fold in the probed subtree");
        cleanup(&root);
    }

    #[test]
    fn sample_hashing_filters_partial_hash_collisions_before_full_hashing() {
        let root = test_root("full-hash");
        fs::create_dir_all(&root).expect("failed to create folder");

        // Use >1 MiB files so sample_chunk_plan picks the 3-point (head+middle+tail) ladder;
        // the difference sits in the middle chunk, which is caught by sampling → no full hash.
        let mut first = vec![1_u8; 1024 * 1024];
        first.extend(vec![9_u8; 16]);
        first.extend(vec![2_u8; 1024 * 1024]);

        let mut second = vec![1_u8; 1024 * 1024];
        second.extend(vec![8_u8; 16]);
        second.extend(vec![2_u8; 1024 * 1024]);

        write_file(&root.join("one.bin"), &first);
        write_file(&root.join("two.bin"), &second);

        let mut writer = IndexWriter::open_in_memory().expect("failed to open sqlite index");
        scan_into_index(&root, &mut writer);
        writer
            .refine_duplicates()
            .expect("failed to refine duplicates");

        let duplicate_group_count: i64 = writer
            .connection()
            .query_row("SELECT COUNT(*) FROM duplicate_groups", [], |row| {
                row.get(0)
            })
            .expect("failed to count duplicate groups");
        let full_hashes: i64 = writer
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM files WHERE full_hash IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .expect("failed to count full hashes");
        let sample_hashes: i64 = writer
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM files WHERE sample_hash IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .expect("failed to count sample hashes");

        assert_eq!(duplicate_group_count, 0);
        assert_eq!(full_hashes, 0);
        assert_eq!(sample_hashes, 2);
        cleanup(&root);
    }

    #[test]
    fn three_point_sampling_filters_same_edges_different_middle() {
        let root = test_root("three-point-sample");
        fs::create_dir_all(&root).expect("failed to create folder");

        // Use >1 MiB files so sample_chunk_plan picks the 3-point (head+middle+tail) ladder;
        // the difference sits in the middle chunk so it is caught without a full hash.
        let mut first = vec![1_u8; 1024 * 1024];
        first.extend(vec![9_u8; 16]);
        first.extend(vec![2_u8; 1024 * 1024]);

        let mut second = vec![1_u8; 1024 * 1024];
        second.extend(vec![8_u8; 16]);
        second.extend(vec![2_u8; 1024 * 1024]);

        write_file(&root.join("one.bin"), &first);
        write_file(&root.join("two.bin"), &second);

        let mut writer = IndexWriter::open_in_memory().expect("failed to open sqlite index");
        scan_into_index(&root, &mut writer);
        writer
            .refine_duplicates()
            .expect("failed to refine duplicates");

        let duplicate_group_count: i64 = writer
            .connection()
            .query_row("SELECT COUNT(*) FROM duplicate_groups", [], |row| {
                row.get(0)
            })
            .expect("failed to count duplicate groups");
        let full_hashes: i64 = writer
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM files WHERE full_hash IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .expect("failed to count full hashes");

        assert_eq!(duplicate_group_count, 0);
        assert_eq!(full_hashes, 0);
        cleanup(&root);
    }

    #[test]
    fn rescan_clears_stale_hashes_when_file_changes() {
        let root = test_root("stale-hash");
        fs::create_dir_all(&root).expect("failed to create folder");

        let mut original = vec![1_u8; 64 * 1024];
        original.extend(vec![7_u8; 16]);
        original.extend(vec![2_u8; 64 * 1024]);

        let mut changed = vec![1_u8; 64 * 1024];
        changed.extend(vec![8_u8; 16]);
        changed.extend(vec![2_u8; 64 * 1024]);

        let first_path = root.join("one.bin");
        let second_path = root.join("two.bin");
        write_file(&first_path, &original);
        write_file(&second_path, &original);

        let mut writer = IndexWriter::open_in_memory().expect("failed to open sqlite index");
        scan_into_index(&root, &mut writer);
        writer
            .refine_duplicates()
            .expect("failed to refine duplicates");

        let initial_groups: i64 = writer
            .connection()
            .query_row("SELECT COUNT(*) FROM duplicate_groups", [], |row| {
                row.get(0)
            })
            .expect("failed to count initial duplicate groups");
        assert_eq!(initial_groups, 1);

        std::thread::sleep(std::time::Duration::from_millis(1100));
        write_file(&second_path, &changed);
        scan_into_index(&root, &mut writer);
        writer
            .refine_duplicates()
            .expect("failed to refine duplicates");

        let duplicate_group_count: i64 = writer
            .connection()
            .query_row("SELECT COUNT(*) FROM duplicate_groups", [], |row| {
                row.get(0)
            })
            .expect("failed to count duplicate groups after rescan");

        assert_eq!(duplicate_group_count, 0);
        assert!(first_path.exists());
        cleanup(&root);
    }

    #[test]
    fn partial_hashing_filters_same_size_different_content() {
        let root = test_root("partial-hash");
        fs::create_dir_all(&root).expect("failed to create folder");
        write_file(&root.join("one.bin"), &[1; 32]);
        write_file(&root.join("two.bin"), &[2; 32]);

        let mut writer = IndexWriter::open_in_memory().expect("failed to open sqlite index");
        scan_into_index(&root, &mut writer);
        writer
            .refine_duplicates()
            .expect("failed to refine duplicates");

        let duplicate_group_count: i64 = writer
            .connection()
            .query_row("SELECT COUNT(*) FROM duplicate_groups", [], |row| {
                row.get(0)
            })
            .expect("failed to count duplicate groups");
        let hashed_files: i64 = writer
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM files WHERE partial_hash IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .expect("failed to count hashed files");

        assert_eq!(duplicate_group_count, 0);
        assert_eq!(hashed_files, 2);
        cleanup(&root);
    }

    #[test]
    fn rescans_mark_missing_files_deleted_and_rebuild_projections() {
        let root = test_root("incremental");
        fs::create_dir_all(&root).expect("failed to create folder");
        let keep_path = root.join("keep.bin");
        let remove_path = root.join("remove.bin");
        write_file(&keep_path, &[1; 32]);
        write_file(&remove_path, &[2; 32]);

        let mut writer = IndexWriter::open_in_memory().expect("failed to open sqlite index");
        scan_into_index(&root, &mut writer);

        fs::remove_file(&remove_path).expect("failed to remove test file");
        scan_into_index(&root, &mut writer);

        let active_files: i64 = writer
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM files WHERE deleted_at IS NULL",
                [],
                |row| row.get(0),
            )
            .expect("failed to count active files");
        let deleted_files: i64 = writer
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM files WHERE deleted_at IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .expect("failed to count deleted files");
        let duplicate_groups: i64 = writer
            .connection()
            .query_row("SELECT COUNT(*) FROM duplicate_groups", [], |row| {
                row.get(0)
            })
            .expect("failed to count duplicate groups");
        let extension_file_count: i64 = writer
            .connection()
            .query_row(
                "SELECT file_count FROM extension_stats WHERE extension = 'bin'",
                [],
                |row| row.get(0),
            )
            .expect("failed to read extension stats");
        let root_total_bytes: i64 = writer
            .connection()
            .query_row(
                "SELECT total_bytes FROM folders WHERE path = ?1",
                params![path_to_string(&root)],
                |row| row.get(0),
            )
            .expect("failed to read root rollup");

        assert_eq!(active_files, 1);
        assert_eq!(deleted_files, 1);
        assert_eq!(duplicate_groups, 0);
        assert_eq!(extension_file_count, 1);
        assert_eq!(root_total_bytes, 32);
        assert_eq!(writer.largest_files(10).expect("largest files").len(), 1);
        assert_eq!(
            writer
                .extension_summaries(10)
                .expect("extension summaries")
                .first()
                .map(|summary| summary.file_count),
            Some(1)
        );
        assert!(keep_path.exists());
        cleanup(&root);
    }

    #[test]
    fn finished_scan_finalizes_metadata_without_duplicate_refinement() {
        let root = test_root("progressive-refinement");
        fs::create_dir_all(&root).expect("failed to create folder");
        write_file(&root.join("one.bin"), &[1; 32]);
        write_file(&root.join("two.bin"), &[1; 32]);
        write_file(&root.join("unique.bin"), &[3; 64]);

        let mut writer = IndexWriter::open_in_memory().expect("failed to open sqlite index");
        scan_into_index(&root, &mut writer);

        let session_status: String = writer
            .connection()
            .query_row("SELECT status FROM scan_sessions LIMIT 1", [], |row| {
                row.get(0)
            })
            .expect("failed to read session status");
        let duplicate_candidates: i64 = writer
            .connection()
            .query_row("SELECT COUNT(*) FROM duplicate_candidates", [], |row| {
                row.get(0)
            })
            .expect("failed to count duplicate candidates");
        let pending_hash_jobs: i64 = writer
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM hash_jobs WHERE status = 'pending'",
                [],
                |row| row.get(0),
            )
            .expect("failed to count pending hash jobs");
        let duplicate_groups: i64 = writer
            .connection()
            .query_row("SELECT COUNT(*) FROM duplicate_groups", [], |row| {
                row.get(0)
            })
            .expect("failed to count duplicate groups");
        let hashed_files: i64 = writer
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM files WHERE partial_hash IS NOT NULL OR sample_hash IS NOT NULL OR full_hash IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .expect("failed to count hashed files");
        let root_total_bytes: i64 = writer
            .connection()
            .query_row(
                "SELECT total_bytes FROM folders WHERE path = ?1",
                params![path_to_string(&root)],
                |row| row.get(0),
            )
            .expect("failed to read root rollup");

        assert_eq!(session_status, "complete");
        assert_eq!(duplicate_candidates, 0);
        assert_eq!(pending_hash_jobs, 0);
        assert_eq!(duplicate_groups, 0);
        assert_eq!(hashed_files, 0);
        assert_eq!(root_total_bytes, 128);
        cleanup(&root);
    }

    #[test]
    fn duplicate_refinement_builds_groups_after_scan_completion() {
        let root = test_root("refinement-groups");
        fs::create_dir_all(&root).expect("failed to create folder");
        write_file(&root.join("one.bin"), &[1; 32]);
        write_file(&root.join("two.bin"), &[1; 32]);

        let mut writer = IndexWriter::open_in_memory().expect("failed to open sqlite index");
        scan_into_index(&root, &mut writer);

        writer
            .refine_duplicates_with_progress(&|| false, |_| {})
            .expect("failed to refine duplicates");

        let duplicate_groups: i64 = writer
            .connection()
            .query_row("SELECT COUNT(*) FROM duplicate_groups", [], |row| {
                row.get(0)
            })
            .expect("failed to count duplicate groups");
        let completed_sample_jobs: i64 = writer
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM hash_jobs WHERE job_type = 'sample' AND status = 'completed'",
                [],
                |row| row.get(0),
            )
            .expect("failed to count completed sample jobs");
        let completed_full_jobs: i64 = writer
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM hash_jobs WHERE job_type = 'full' AND status = 'completed'",
                [],
                |row| row.get(0),
            )
            .expect("failed to count completed full jobs");
        let completed_candidates: i64 = writer
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM duplicate_candidates WHERE status = 'completed'",
                [],
                |row| row.get(0),
            )
            .expect("failed to count completed candidates");

        assert_eq!(duplicate_groups, 1);
        assert_eq!(completed_sample_jobs, 2);
        assert_eq!(completed_full_jobs, 2);
        assert_eq!(completed_candidates, 1);

        // The group summary carries member sample paths (largest first).
        let summaries = writer.duplicate_groups(10).expect("group summaries");
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].sample_paths.len(), 2);
        assert!(summaries[0]
            .sample_paths
            .iter()
            .all(|path| path.ends_with("one.bin") || path.ends_with("two.bin")));

        cleanup(&root);
    }

    #[test]
    fn exposes_index_query_summaries() {
        let root = test_root("queries");
        fs::create_dir_all(root.join("nested")).expect("failed to create folder");
        write_file(&root.join("nested").join("large.mp4"), &[1; 128]);
        write_file(&root.join("small.txt"), &[2; 16]);
        write_file(&root.join("copy.txt"), &[3; 16]);

        let mut writer = IndexWriter::open_in_memory().expect("failed to open sqlite index");
        scan_into_index(&root, &mut writer);

        let folders = writer.largest_folders(3).expect("largest folders");
        let files = writer.largest_files(2).expect("largest files");
        let extensions = writer.extension_summaries(3).expect("extensions");
        let duplicates = writer.duplicate_groups(3).expect("duplicates");
        let media = writer.media_summaries().expect("media summaries");
        let folder_media = writer.folder_media_summaries(6).expect("folder media");

        assert_eq!(folders.first().map(|folder| folder.total_bytes), Some(160));
        assert_eq!(files.first().map(|file| file.size), Some(128));
        assert_eq!(
            extensions
                .first()
                .map(|extension| extension.extension.as_str()),
            Some("mp4")
        );
        assert!(duplicates.is_empty());
        assert_eq!(
            media.first().map(|summary| summary.media_kind.as_str()),
            Some("video")
        );
        assert!(folder_media
            .iter()
            .any(|summary| summary.media_kind == "video"));
        cleanup(&root);
    }

    #[test]
    fn exposes_timeline_and_age_summaries() {
        let root = test_root("timeline");
        fs::create_dir_all(&root).expect("failed to create folder");
        write_file(&root.join("fresh.txt"), &[1; 64]);
        write_file(&root.join("also-fresh.bin"), &[2; 32]);

        let mut writer = IndexWriter::open_in_memory().expect("failed to open sqlite index");
        scan_into_index(&root, &mut writer);

        // Freshly written files land in the current month's bucket…
        let timeline = writer.timeline_summaries(24).expect("timeline summaries");
        assert_eq!(timeline.len(), 1);
        assert_eq!(timeline[0].file_count, 2);
        assert_eq!(timeline[0].total_bytes, 96);

        // …and in the youngest age band.
        let ages = writer.age_summaries().expect("age summaries");
        assert_eq!(ages.len(), 1);
        assert_eq!(ages[0].bucket, "lt1mo");
        assert_eq!(ages[0].file_count, 2);

        // A file backdated two years lands in the oldest band and off the 24-month timeline.
        // Summaries are materialized at scan finalization, so an out-of-band SQL
        // mutation needs an explicit rebuild — a real rescan does this itself.
        writer
            .connection()
            .execute(
                "UPDATE files SET modified_at = strftime('%s', 'now', '-30 months')
                 WHERE name = 'fresh.txt'",
                [],
            )
            .expect("failed to backdate file");
        writer.rebuild_derived_stats().expect("rebuild stats");
        let ages = writer.age_summaries().expect("age summaries");
        assert!(ages.iter().any(|bucket| bucket.bucket == "gt2yr" && bucket.file_count == 1));
        let timeline = writer.timeline_summaries(24).expect("timeline summaries");
        assert_eq!(timeline.iter().map(|bucket| bucket.file_count).sum::<i64>(), 1);

        cleanup(&root);
    }

    #[test]
    fn searches_active_files_by_name_or_path() {
        let root = test_root("search");
        fs::create_dir_all(root.join("photos")).expect("failed to create folder");
        fs::create_dir_all(root.join("docs")).expect("failed to create folder");
        write_file(&root.join("photos").join("vacation.raw"), &[1; 96]);
        write_file(&root.join("docs").join("budget.txt"), &[2; 16]);

        let mut writer = IndexWriter::open_in_memory().expect("failed to open sqlite index");
        scan_into_index(&root, &mut writer);

        let by_name = writer.search_files("vacation", 10).expect("search by name");
        let by_path = writer.search_files("photos", 10).expect("search by path");
        let empty = writer.search_files("   ", 10).expect("empty search");

        assert_eq!(
            by_name.first().map(|file| file.name.as_str()),
            Some("vacation.raw")
        );
        assert_eq!(
            by_name.first().map(|file| file.media_kind.as_str()),
            Some("photo")
        );
        assert_eq!(by_path.len(), 1);
        assert!(empty.is_empty());
        cleanup(&root);
    }

    fn test_root(name: &str) -> PathBuf {
        let root = std::env::current_dir()
            .expect("failed to get current dir")
            .join("target")
            .join("index-tests")
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

    fn write_file(path: &Path, bytes: &[u8]) {
        let mut file = File::create(path).expect("failed to create file");
        file.write_all(bytes).expect("failed to write file");
    }

    fn scan_into_index(root: &Path, writer: &mut IndexWriter) {
        let scanner = Scanner::new(ScanOptions {
            root: root.to_path_buf(),
            workers: 2,
        });
        let events = scanner.scan();

        for event in events {
            writer.handle_event(&event).expect("failed to index event");
            if matches!(event, ScanEvent::Finished(_)) {
                break;
            }
        }
    }

    fn cleanup(root: &Path) {
        if root.exists() {
            fs::remove_dir_all(root).expect("failed to remove test folder");
        }
    }

    #[test]
    fn crawl_commits_in_batches_before_finish() {
        let root = test_root("batched-commits");
        std::fs::create_dir_all(&root).expect("create root");
        for i in 0..25_000 {
            std::fs::write(root.join(format!("f{i}.bin")), b"x").expect("write file");
        }

        let mut writer = IndexWriter::open_in_memory().expect("open writer");
        let scanner = crate::scanner::Scanner::new(crate::scanner::ScanOptions {
            root: root.clone(),
            workers: 2,
        });
        let events = scanner.scan();

        let mut committed_mid_crawl = 0_i64;
        for event in events {
            let is_finished = matches!(event, ScanEvent::Finished(_));
            writer.handle_event(&event).expect("handle event");
            if !is_finished {
                committed_mid_crawl = writer
                    .connection()
                    .query_row("SELECT COUNT(*) FROM files", [], |r| r.get(0))
                    .unwrap_or(0);
            }
            if is_finished {
                break;
            }
        }

        assert!(
            committed_mid_crawl > 0,
            "expected files to be visible before Finished, saw {committed_mid_crawl}"
        );
        cleanup(&root);
    }

    #[test]
    fn scan_mode_round_trips_ids() {
        use crate::index::writer::ScanMode;
        assert_eq!(ScanMode::from_id("smart"), ScanMode::Smart);
        assert_eq!(ScanMode::from_id("metadata"), ScanMode::MetadataOnly);
        assert_eq!(ScanMode::from_id("anything-else"), ScanMode::Smart);
        assert_eq!(ScanMode::Smart.as_id(), "smart");
        assert_eq!(ScanMode::MetadataOnly.as_id(), "metadata");
        assert_eq!(ScanMode::default(), ScanMode::Smart);
    }

    #[test]
    fn folder_rollups_match_nested_tree() {
        let root = test_root("rollup-tree");
        let child = root.join("child");
        let grandchild = child.join("grandchild");
        std::fs::create_dir_all(&grandchild).expect("create dirs");
        std::fs::write(root.join("a.bin"), vec![0_u8; 100]).expect("write a");
        std::fs::write(child.join("b.bin"), vec![0_u8; 200]).expect("write b");
        std::fs::write(grandchild.join("c.bin"), vec![0_u8; 300]).expect("write c");

        let mut writer = IndexWriter::open_in_memory().expect("open writer");
        let scanner = crate::scanner::Scanner::new(crate::scanner::ScanOptions {
            root: root.clone(),
            workers: 1,
        });
        for event in scanner.scan() {
            let finished = matches!(event, ScanEvent::Finished(_));
            writer.handle_event(&event).expect("handle event");
            if finished {
                break;
            }
        }

        let (root_files, root_bytes): (i64, i64) = writer
            .connection()
            .query_row(
                "SELECT total_files, total_bytes FROM folders WHERE path = ?1",
                params![path_to_string(&root)],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("query root folder");

        assert_eq!(root_files, 3, "root should roll up all 3 files");
        assert_eq!(root_bytes, 600, "root should roll up 100+200+300 bytes");

        let (child_files, child_bytes): (i64, i64) = writer
            .connection()
            .query_row(
                "SELECT total_files, total_bytes FROM folders WHERE path = ?1",
                params![path_to_string(&child)],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("query child folder");

        assert_eq!(child_files, 2, "child should roll up 2 files (its own + grandchild)");
        assert_eq!(child_bytes, 500, "child should roll up 200+300 bytes");
        cleanup(&root);
    }
}
