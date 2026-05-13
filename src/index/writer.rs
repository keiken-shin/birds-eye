use crate::index::schema::ALL_MIGRATIONS;
use crate::scanner::{FileRecord, FolderRecord, ScanEvent, ScanStats};
use rusqlite::{params, params_from_iter, types::Value, Connection, OptionalExtension};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
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

pub struct IndexWriter {
    connection: Connection,
    session_id: Option<i64>,
    active_root: Option<PathBuf>,
    active_scan_started_at: Option<i64>,
    folder_ids: HashMap<PathBuf, i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FolderSummary {
    pub path: String,
    pub total_files: i64,
    pub total_bytes: i64,
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

#[derive(Debug, Clone, Default, PartialEq)]
pub struct FileSearchFilters {
    pub query: String,
    pub extension: Option<String>,
    pub media_kind: Option<String>,
    pub min_size: Option<i64>,
    pub max_size: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExtensionSummary {
    pub extension: String,
    pub file_count: i64,
    pub total_bytes: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DuplicateGroupSummary {
    pub id: i64,
    pub size: i64,
    pub file_count: i64,
    pub folder_count: i64,
    pub dominant_media_kind: String,
    pub reclaimable_bytes: i64,
    pub confidence: f64,
    pub cleanup_score: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DuplicateFileSummary {
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

#[derive(Debug, Clone, PartialEq)]
pub struct DuplicateOverlapSummary {
    pub folder_a: String,
    pub folder_b: String,
    pub shared_groups: i64,
    pub shared_files: i64,
    pub reclaimable_bytes: i64,
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

#[derive(Debug, Clone, Default, PartialEq)]
pub struct PathRefreshSummary {
    pub refreshed: usize,
    pub deleted: usize,
}

impl IndexWriter {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, IndexError> {
        let connection = Connection::open(path)?;
        let writer = Self {
            connection,
            session_id: None,
            active_root: None,
            active_scan_started_at: None,
            folder_ids: HashMap::new(),
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
            folder_ids: HashMap::new(),
        };
        writer.migrate()?;
        Ok(writer)
    }

    pub fn handle_event(&mut self, event: &ScanEvent) -> Result<(), IndexError> {
        match event {
            ScanEvent::Started { root, .. } => self.start_session(root),
            ScanEvent::FolderIndexed(folder) => self.index_folder(folder),
            ScanEvent::FileIndexed(file) => self.index_file(file),
            ScanEvent::Finished(report) => {
                self.finish_session("complete", &report.stats)?;
                self.mark_missing_files_deleted()?;
                self.recompute_folder_rollups()?;
                self.rebuild_extension_stats()?;
                self.update_partial_hashes_for_duplicate_candidates()?;
                self.update_full_hashes_for_partial_matches()?;
                self.rebuild_duplicate_size_groups()?;
                self.capture_timeline(&report.root, &report.stats)
            }
            ScanEvent::Cancelled(stats) => self.finish_session("cancelled", stats),
            ScanEvent::Error(_) | ScanEvent::Progress(_) => Ok(()),
        }
    }

    pub fn connection(&self) -> &Connection {
        &self.connection
    }

    pub fn refresh_paths(&mut self, paths: &[PathBuf]) -> Result<PathRefreshSummary, IndexError> {
        let mut summary = PathRefreshSummary::default();
        let refreshed_at = now_millis();
        self.active_scan_started_at = Some(refreshed_at);

        for path in paths {
            match fs::metadata(path) {
                Ok(metadata) if metadata.is_file() => {
                    let record = FileRecord {
                        parent: path.parent().unwrap_or(path).to_path_buf(),
                        name: path
                            .file_name()
                            .map(|name| name.to_string_lossy().into_owned())
                            .unwrap_or_else(|| path_to_string(path)),
                        extension: path
                            .extension()
                            .and_then(|extension| extension.to_str())
                            .map(|extension| extension.to_ascii_lowercase()),
                        path: path.to_path_buf(),
                        size: metadata.len(),
                        modified: metadata.modified().ok(),
                        accessed: metadata.accessed().ok(),
                        created: metadata.created().ok(),
                    };
                    self.index_file(&record)?;
                    summary.refreshed += 1;
                }
                _ => {
                    let changed = self.connection.execute(
                        "UPDATE files SET deleted_at = ?1 WHERE path = ?2 AND deleted_at IS NULL",
                        params![refreshed_at, path_to_string(path)],
                    )?;
                    summary.deleted += changed;
                }
            }
        }

        self.recompute_folder_rollups()?;
        self.rebuild_extension_stats()?;
        self.update_partial_hashes_for_duplicate_candidates()?;
        self.update_full_hashes_for_partial_matches()?;
        self.rebuild_duplicate_size_groups()?;
        self.active_scan_started_at = None;
        Ok(summary)
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

    pub fn search_files(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<Vec<FileSearchResult>, IndexError> {
        self.search_files_with_filters(
            FileSearchFilters {
                query: query.to_owned(),
                ..FileSearchFilters::default()
            },
            limit,
        )
    }

    pub fn search_files_with_filters(
        &self,
        filters: FileSearchFilters,
        limit: usize,
    ) -> Result<Vec<FileSearchResult>, IndexError> {
        let trimmed_query = filters.query.trim();
        let has_filters = filters.extension.is_some()
            || filters.media_kind.is_some()
            || filters.min_size.is_some()
            || filters.max_size.is_some();
        if trimmed_query.is_empty() && !has_filters {
            return Ok(Vec::new());
        }

        let mut sql = String::from(
            "SELECT path, name, size, extension, media_kind, modified_at
             FROM files
             WHERE deleted_at IS NULL",
        );
        let mut values = Vec::new();

        if !trimmed_query.is_empty() {
            let escaped_query = escape_like_pattern(trimmed_query);
            sql.push_str(" AND (name LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\')");
            values.push(Value::Text(format!("%{escaped_query}%")));
            values.push(Value::Text(format!("%{escaped_query}%")));
        }

        if let Some(extension) = filters
            .extension
            .filter(|extension| !extension.trim().is_empty())
        {
            sql.push_str(" AND extension = ?");
            values.push(Value::Text(
                extension
                    .trim()
                    .trim_start_matches('.')
                    .to_ascii_lowercase(),
            ));
        }

        if let Some(media_kind) = filters
            .media_kind
            .filter(|media_kind| !media_kind.trim().is_empty())
        {
            sql.push_str(" AND media_kind = ?");
            values.push(Value::Text(media_kind));
        }

        if let Some(min_size) = filters.min_size {
            sql.push_str(" AND size >= ?");
            values.push(Value::Integer(min_size.max(0)));
        }

        if let Some(max_size) = filters.max_size {
            sql.push_str(" AND size <= ?");
            values.push(Value::Integer(max_size.max(0)));
        }

        sql.push_str(" ORDER BY size DESC, modified_at DESC LIMIT ?");
        values.push(Value::Integer(limit as i64));

        let mut statement = self.connection.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(values.iter()), |row| {
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
            "WITH group_stats AS (
               SELECT
                 dg.id,
                 dg.size,
                 COUNT(dgf.file_id) AS file_count,
                 COUNT(DISTINCT files.folder_id) AS folder_count,
                 COALESCE((
                   SELECT f2.media_kind
                   FROM duplicate_group_files dgf2
                   JOIN files f2 ON f2.id = dgf2.file_id
                   WHERE dgf2.group_id = dg.id AND f2.deleted_at IS NULL
                   GROUP BY f2.media_kind
                   ORDER BY COUNT(*) DESC, SUM(f2.size) DESC, f2.media_kind
                   LIMIT 1
                 ), 'other') AS dominant_media_kind,
                 dg.reclaimable_bytes,
                 dg.confidence
               FROM duplicate_groups dg
               JOIN duplicate_group_files dgf ON dgf.group_id = dg.id
               JOIN files ON files.id = dgf.file_id
               WHERE files.deleted_at IS NULL
               GROUP BY dg.id
             )
             SELECT
               id,
               size,
               file_count,
               folder_count,
               dominant_media_kind,
               reclaimable_bytes,
               confidence,
               CAST(reclaimable_bytes AS REAL)
                 * CASE
                     WHEN confidence >= 1.0 THEN 1.25
                     WHEN confidence >= 0.65 THEN 1.05
                     ELSE 0.75
                   END
                 * CASE dominant_media_kind
                     WHEN 'video' THEN 1.15
                     WHEN 'photo' THEN 1.08
                     WHEN 'music' THEN 1.04
                     ELSE 1.0
                   END
                 + (CAST(folder_count AS REAL) * CAST(size AS REAL) * 0.05) AS cleanup_score
             FROM group_stats
             ORDER BY cleanup_score DESC, reclaimable_bytes DESC
             LIMIT ?1",
        )?;
        let rows = statement.query_map(params![limit as i64], |row| {
            Ok(DuplicateGroupSummary {
                id: row.get(0)?,
                size: row.get(1)?,
                file_count: row.get(2)?,
                folder_count: row.get(3)?,
                dominant_media_kind: row.get(4)?,
                reclaimable_bytes: row.get(5)?,
                confidence: row.get(6)?,
                cleanup_score: row.get(7)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn duplicate_group_files(
        &self,
        group_id: i64,
        limit: usize,
    ) -> Result<Vec<DuplicateFileSummary>, IndexError> {
        let mut statement = self.connection.prepare(
            "SELECT files.id,
                    files.path,
                    files.name,
                    folders.path,
                    files.size,
                    files.modified_at,
                    files.extension,
                    files.media_kind,
                    CASE
                      WHEN dg.full_hash IS NOT NULL THEN 'full hash'
                      WHEN dg.partial_hash IS NOT NULL THEN 'partial hash'
                      ELSE 'size'
                    END AS hash_match_type,
                    dg.confidence
             FROM duplicate_group_files dgf
             JOIN files ON files.id = dgf.file_id
             JOIN folders ON folders.id = files.folder_id
             JOIN duplicate_groups dg ON dg.id = dgf.group_id
             WHERE dgf.group_id = ?1 AND files.deleted_at IS NULL
             ORDER BY files.path
             LIMIT ?2",
        )?;
        let rows = statement.query_map(params![group_id, limit as i64], |row| {
            Ok(DuplicateFileSummary {
                id: row.get(0)?,
                path: row.get(1)?,
                name: row.get(2)?,
                folder_path: row.get(3)?,
                size: row.get(4)?,
                modified_at: row.get(5)?,
                extension: row.get(6)?,
                media_kind: row.get(7)?,
                hash_match_type: row.get(8)?,
                confidence: row.get(9)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn timeline_files(&self, per_kind_limit: usize) -> Result<Vec<FileSummary>, IndexError> {
        let mut files = Vec::new();
        let mut statement = self.connection.prepare(
            "SELECT path, size, extension, media_kind, modified_at
             FROM files
             WHERE deleted_at IS NULL AND media_kind = ?1 AND modified_at IS NOT NULL
             ORDER BY modified_at DESC
             LIMIT ?2",
        )?;

        for media_kind in ["photo", "video", "music", "document"] {
            let rows = statement.query_map(params![media_kind, per_kind_limit as i64], |row| {
                Ok(FileSummary {
                    path: row.get(0)?,
                    size: row.get(1)?,
                    extension: row.get(2)?,
                    media_kind: row.get(3)?,
                    modified_at: row.get(4)?,
                })
            })?;
            files.extend(rows.collect::<Result<Vec<_>, _>>()?);
        }

        files.sort_by(|a, b| a.modified_at.cmp(&b.modified_at));
        Ok(files)
    }

    pub fn duplicate_overlaps(
        &self,
        limit: usize,
    ) -> Result<Vec<DuplicateOverlapSummary>, IndexError> {
        let mut statement = self.connection.prepare(
            "WITH group_folders AS (
               SELECT dgf.group_id, files.folder_id, folders.path AS folder_path, COUNT(*) AS file_count
               FROM duplicate_group_files dgf
               JOIN files ON files.id = dgf.file_id
               JOIN folders ON folders.id = files.folder_id
               WHERE files.deleted_at IS NULL
               GROUP BY dgf.group_id, files.folder_id
             )
             SELECT
               a.folder_path,
               b.folder_path,
               COUNT(*) AS shared_groups,
               SUM(a.file_count + b.file_count) AS shared_files,
               SUM(
                 CASE
                   WHEN a.file_count < b.file_count THEN a.file_count
                   ELSE b.file_count
                 END * dg.size
               ) AS reclaimable_bytes
             FROM group_folders a
             JOIN group_folders b ON b.group_id = a.group_id AND b.folder_id > a.folder_id
             JOIN duplicate_groups dg ON dg.id = a.group_id
             GROUP BY a.folder_path, b.folder_path
             ORDER BY reclaimable_bytes DESC, shared_groups DESC
             LIMIT ?1",
        )?;
        let rows = statement.query_map(params![limit as i64], |row| {
            Ok(DuplicateOverlapSummary {
                folder_a: row.get(0)?,
                folder_b: row.get(1)?,
                shared_groups: row.get(2)?,
                shared_files: row.get(3)?,
                reclaimable_bytes: row.get(4)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn media_summaries(&self) -> Result<Vec<MediaSummary>, IndexError> {
        let mut statement = self.connection.prepare(
            "SELECT media_kind, COUNT(*), COALESCE(SUM(size), 0)
             FROM files
             WHERE deleted_at IS NULL
             GROUP BY media_kind
             ORDER BY SUM(size) DESC",
        )?;
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
        let mut statement = self.connection.prepare(
            "SELECT f.path, files.media_kind, COALESCE(SUM(files.size), 0) AS total_bytes
             FROM files
             JOIN folders f ON f.id = files.folder_id
             WHERE files.deleted_at IS NULL
             GROUP BY f.path, files.media_kind
             ORDER BY total_bytes DESC
             LIMIT ?1",
        )?;
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
        for (_, migration) in ALL_MIGRATIONS {
            self.connection.execute_batch(migration)?;
        }
        Ok(())
    }

    fn start_session(&mut self, root: &Path) -> Result<(), IndexError> {
        let started_at = now_millis();
        self.folder_ids.clear();
        self.connection.execute(
            "INSERT INTO scan_sessions (root_path, started_at, status) VALUES (?1, ?2, 'running')",
            params![path_to_string(root), started_at],
        )?;
        self.session_id = Some(self.connection.last_insert_rowid());
        self.active_root = Some(root.to_path_buf());
        self.active_scan_started_at = Some(started_at);
        self.ensure_folder(root)?;
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
                        full_hash,
                        CASE
                          WHEN full_hash IS NOT NULL THEN 1.0
                          WHEN partial_hash IS NOT NULL THEN 0.65
                          ELSE 0.35
                        END AS confidence,
                        COUNT(*) AS file_count,
                        size * (COUNT(*) - 1) AS reclaimable_bytes
                 FROM files
                 WHERE deleted_at IS NULL AND size > 0
                 GROUP BY size, partial_hash, full_hash
                 HAVING COUNT(*) > 1
                 ORDER BY reclaimable_bytes DESC",
            )?;
            let rows = statement.query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, f64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                ))
            })?;

            rows.collect::<Result<Vec<_>, _>>()?
        };

        for (size, partial_hash, full_hash, confidence, _file_count, reclaimable_bytes) in groups {
            tx.execute(
                "INSERT INTO duplicate_groups (size, partial_hash, full_hash, confidence, reclaimable_bytes, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![size, partial_hash, full_hash, confidence, reclaimable_bytes, now_millis()],
            )?;
            let group_id = tx.last_insert_rowid();
            if let Some(full_hash) = full_hash {
                tx.execute(
                    "INSERT INTO duplicate_group_files (group_id, file_id)
                     SELECT ?1, id FROM files
                     WHERE deleted_at IS NULL AND size = ?2 AND full_hash = ?3",
                    params![group_id, size, full_hash],
                )?;
            } else if let Some(partial_hash) = partial_hash {
                tx.execute(
                    "INSERT INTO duplicate_group_files (group_id, file_id)
                     SELECT ?1, id FROM files WHERE deleted_at IS NULL AND size = ?2 AND partial_hash = ?3",
                    params![group_id, size, partial_hash],
                )?;
            } else {
                tx.execute(
                    "INSERT INTO duplicate_group_files (group_id, file_id)
                     SELECT ?1, id FROM files WHERE deleted_at IS NULL AND size = ?2 AND partial_hash IS NULL",
                    params![group_id, size],
                )?;
            }
        }

        tx.commit()?;
        Ok(())
    }

    fn update_full_hashes_for_partial_matches(&mut self) -> Result<(), IndexError> {
        let candidates = {
            let mut statement = self.connection.prepare(
                "SELECT id, path
                 FROM files
                 WHERE deleted_at IS NULL
                   AND partial_hash IS NOT NULL
                   AND full_hash IS NULL
                   AND (size, partial_hash) IN (
                     SELECT size, partial_hash FROM files
                     WHERE deleted_at IS NULL AND partial_hash IS NOT NULL
                     GROUP BY size, partial_hash
                     HAVING COUNT(*) > 1
                   )",
            )?;
            let rows = statement.query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };

        let tx = self.connection.transaction()?;
        for (id, path) in candidates {
            let full_hash = full_file_hash(Path::new(&path));
            if let Some(full_hash) = full_hash {
                tx.execute(
                    "UPDATE files SET full_hash = ?1, hash_algorithm = ?2 WHERE id = ?3",
                    params![full_hash, "fnv1a-full-v1", id],
                )?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    fn update_partial_hashes_for_duplicate_candidates(&mut self) -> Result<(), IndexError> {
        let candidates = {
            let mut statement = self.connection.prepare(
                "SELECT id, path, size
                 FROM files
                 WHERE deleted_at IS NULL
                   AND size IN (
                     SELECT size FROM files
                     WHERE deleted_at IS NULL AND size > 0
                     GROUP BY size
                     HAVING COUNT(*) > 1
                   )",
            )?;
            let rows = statement.query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };

        let tx = self.connection.transaction()?;
        for (id, path, size) in candidates {
            let partial_hash = partial_file_hash(Path::new(&path), size as u64);
            if let Some(partial_hash) = partial_hash {
                tx.execute(
                    "UPDATE files SET partial_hash = ?1, hash_algorithm = ?2 WHERE id = ?3",
                    params![partial_hash, "fnv1a-partial-v1", id],
                )?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    fn recompute_folder_rollups(&mut self) -> Result<(), IndexError> {
        #[derive(Clone, Debug)]
        struct FolderNode {
            id: i64,
            parent_id: Option<i64>,
            total_files: i64,
            total_bytes: i64,
        }

        let mut folders = {
            let mut statement = self
                .connection
                .prepare("SELECT id, parent_id FROM folders ORDER BY depth DESC")?;
            let rows = statement.query_map([], |row| {
                Ok(FolderNode {
                    id: row.get(0)?,
                    parent_id: row.get(1)?,
                    total_files: 0,
                    total_bytes: 0,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };

        let positions = folders
            .iter()
            .enumerate()
            .map(|(index, folder)| (folder.id, index))
            .collect::<HashMap<_, _>>();

        {
            let mut statement = self
                .connection
                .prepare("SELECT folder_id, COUNT(*), COALESCE(SUM(size), 0) FROM files WHERE deleted_at IS NULL GROUP BY folder_id")?;
            let rows = statement.query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?;

            for row in rows {
                let (folder_id, file_count, bytes) = row?;
                if let Some(index) = positions.get(&folder_id) {
                    folders[*index].total_files = file_count;
                    folders[*index].total_bytes = bytes;
                }
            }
        }

        for index in 0..folders.len() {
            if let Some(parent_id) = folders[index].parent_id {
                if let Some(parent_index) = positions.get(&parent_id) {
                    folders[*parent_index].total_files += folders[index].total_files;
                    folders[*parent_index].total_bytes += folders[index].total_bytes;
                }
            }
        }

        let tx = self.connection.transaction()?;
        for folder in folders {
            tx.execute(
                "UPDATE folders SET total_files = ?1, total_bytes = ?2 WHERE id = ?3",
                params![folder.total_files, folder.total_bytes, folder.id],
            )?;
        }
        tx.commit()?;
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
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "tif" | "tiff" | "heic" | "heif"
        | "raw" | "cr2" | "nef" | "arw" => "photo",
        "mp4" | "mkv" | "avi" | "mov" | "wmv" | "flv" | "webm" | "m4v" | "ts" => "video",
        "mp3" | "flac" | "wav" | "aac" | "ogg" | "m4a" | "wma" => "music",
        "zip" | "rar" | "7z" | "tar" | "gz" | "bz2" | "xz" => "archive",
        "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "txt" | "md" | "csv"
        | "epub" => "document",
        "rs" | "js" | "tsx" | "jsx" | "py" | "go" | "java" | "cs" | "cpp" | "c" | "html"
        | "css" | "json" => "code",
        "exe" | "msi" | "dmg" | "pkg" | "deb" | "rpm" | "appimage" => "installer",
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

fn partial_file_hash(path: &Path, size: u64) -> Option<String> {
    const BLOCK_SIZE: usize = 64 * 1024;
    const FNV_OFFSET: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x100000001b3;

    let mut file = File::open(path).ok()?;
    let mut hash = FNV_OFFSET;
    let mut buffer = vec![0_u8; BLOCK_SIZE.min(size as usize)];

    let first_read = file.read(&mut buffer).ok()?;
    for byte in &buffer[..first_read] {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }

    if size > BLOCK_SIZE as u64 {
        file.seek(SeekFrom::End(-(BLOCK_SIZE as i64))).ok()?;
        let last_read = file.read(&mut buffer).ok()?;
        for byte in &buffer[..last_read] {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(FNV_PRIME);
        }
    }

    Some(format!("{hash:016x}"))
}

fn full_file_hash(path: &Path) -> Option<String> {
    const BLOCK_SIZE: usize = 128 * 1024;
    const FNV_OFFSET: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x100000001b3;

    let mut file = File::open(path).ok()?;
    let mut hash = FNV_OFFSET;
    let mut buffer = vec![0_u8; BLOCK_SIZE];

    loop {
        let read = file.read(&mut buffer).ok()?;
        if read == 0 {
            break;
        }

        for byte in &buffer[..read] {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(FNV_PRIME);
        }
    }

    Some(format!("{hash:016x}"))
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
    fn full_hashing_filters_partial_hash_collisions() {
        let root = test_root("full-hash");
        fs::create_dir_all(&root).expect("failed to create folder");

        let mut first = vec![1_u8; 128 * 1024];
        first.extend(vec![9_u8; 16]);
        first.extend(vec![2_u8; 128 * 1024]);

        let mut second = vec![1_u8; 128 * 1024];
        second.extend(vec![8_u8; 16]);
        second.extend(vec![2_u8; 128 * 1024]);

        write_file(&root.join("one.bin"), &first);
        write_file(&root.join("two.bin"), &second);

        let mut writer = IndexWriter::open_in_memory().expect("failed to open sqlite index");
        scan_into_index(&root, &mut writer);

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
        assert_eq!(full_hashes, 2);
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
}
