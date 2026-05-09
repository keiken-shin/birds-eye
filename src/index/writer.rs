use crate::index::schema::ALL_MIGRATIONS;
use crate::scanner::{FileRecord, FolderRecord, ScanEvent, ScanStats};
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

pub struct IndexWriter {
    connection: Connection,
    session_id: Option<i64>,
    folder_ids: HashMap<PathBuf, i64>,
}

impl IndexWriter {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, IndexError> {
        let connection = Connection::open(path)?;
        let writer = Self {
            connection,
            session_id: None,
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
                self.capture_timeline(&report.root, &report.stats)
            }
            ScanEvent::Cancelled(stats) => self.finish_session("cancelled", stats),
            ScanEvent::Error(_) | ScanEvent::Progress(_) => Ok(()),
        }
    }

    pub fn connection(&self) -> &Connection {
        &self.connection
    }

    fn migrate(&self) -> Result<(), IndexError> {
        for (_, migration) in ALL_MIGRATIONS {
            self.connection.execute_batch(migration)?;
        }
        Ok(())
    }

    fn start_session(&mut self, root: &Path) -> Result<(), IndexError> {
        self.folder_ids.clear();
        self.connection.execute(
            "INSERT INTO scan_sessions (root_path, started_at, status) VALUES (?1, ?2, 'running')",
            params![path_to_string(root), unix_now()],
        )?;
        self.session_id = Some(self.connection.last_insert_rowid());
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
                unix_now(),
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

    fn capture_timeline(&self, root: &Path, stats: &ScanStats) -> Result<(), IndexError> {
        self.connection.execute(
            "INSERT INTO timeline_history (root_path, captured_at, total_bytes, file_count, folder_count)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                path_to_string(root),
                unix_now(),
                stats.bytes_scanned as i64,
                stats.files_scanned as i64,
                stats.folders_scanned as i64
            ],
        )?;
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
                unix_now(),
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
                unix_now()
            ],
        )?;

        if let Some(extension) = &file.extension {
            self.connection.execute(
                "INSERT INTO extension_stats (extension, file_count, total_bytes, updated_at)
                 VALUES (?1, 1, ?2, ?3)
                 ON CONFLICT(extension) DO UPDATE SET
                   file_count = file_count + 1,
                   total_bytes = total_bytes + excluded.total_bytes,
                   updated_at = excluded.updated_at",
                params![extension, file.size as i64, unix_now()],
            )?;
        }

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
                unix_now()
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

fn folder_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| path_to_string(path))
}

fn unix_now() -> i64 {
    system_time_to_unix(Some(SystemTime::now())).unwrap_or_default()
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
            .query_row("SELECT status FROM scan_sessions LIMIT 1", [], |row| row.get(0))
            .expect("failed to read session");
        let timeline_count: i64 = writer
            .connection()
            .query_row("SELECT COUNT(*) FROM timeline_history", [], |row| row.get(0))
            .expect("failed to count timeline rows");

        assert_eq!(file_count, 2);
        assert_eq!(session_status, "complete");
        assert_eq!(timeline_count, 1);
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

    fn cleanup(root: &Path) {
        if root.exists() {
            fs::remove_dir_all(root).expect("failed to remove test folder");
        }
    }
}
