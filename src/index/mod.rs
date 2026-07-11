pub mod algorithms;
pub mod schema;
pub mod writer;

pub use writer::{
    DuplicateFileSummary, DuplicateGroupSummary, ExtensionSummary, FileSearchResult, FileSummary,
    FinalizationProgress, FolderMediaSummary, FolderSummary, IndexError, IndexWriter, MediaSummary,
};

/// The one way to open an index connection. Concurrent access is normal (the UI reads
/// while a scan or enrichment writes), so every connection waits for locks instead of
/// failing with "database is locked", and WAL keeps readers off the writer's back.
pub fn open_index_connection(
    path: impl AsRef<std::path::Path>,
) -> rusqlite::Result<rusqlite::Connection> {
    let conn = rusqlite::Connection::open(path)?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    let _: String = conn.query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))?;
    Ok(conn)
}
