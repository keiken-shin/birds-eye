pub mod algorithms;
pub mod analysis;
pub mod coverage;
pub mod evidence;
pub mod removal;
pub mod schema;
pub mod writer;

pub use writer::{
    DuplicateFileSummary, DuplicateGroupSummary, ExtensionSummary, FileSearchResult, FileSummary,
    FinalizationProgress, FolderMediaSummary, FolderSummary, IndexError, IndexWriter, MediaSummary,
};

/// The one way to open an index connection. Concurrent access is normal (the UI reads
/// while a scan or enrichment writes), so every connection waits for locks instead of
/// failing with "database is locked", and WAL keeps readers off the writer's back.
///
/// It also migrates. An index is a file on disk that outlives the build that
/// wrote it, so any of the forty callers here can be handed one an older
/// version made. Migrating only inside `IndexWriter::open` meant a caller that
/// just reads -- the analysis pass, every query command -- ran against whatever
/// schema happened to be on disk. That fails loudly when a query names a column
/// the file lacks, and silently when there is nothing to process, which is the
/// worse half: analysis reports success having run against a stale schema.
///
/// An already-current index costs one `SELECT` per migration and no writes.
pub fn open_index_connection(
    path: impl AsRef<std::path::Path>,
) -> rusqlite::Result<rusqlite::Connection> {
    let conn = rusqlite::Connection::open(path)?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    let _: String = conn.query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))?;
    // Per-connection, so every connection has to ask. WAL already fsyncs the
    // journal at each checkpoint; NORMAL drops the per-commit fsync that WAL
    // does not need, and a power cut can lose the last commits but cannot
    // corrupt the file.
    conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;")?;
    migrate(&conn)?;
    Ok(conn)
}

/// Bring a connection's schema up to `CURRENT_SCHEMA_VERSION`, applying only
/// what is missing.
pub fn migrate(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    apply_migrations(conn, schema::ALL_MIGRATIONS)
}

/// Apply each missing migration, all of it or none of it.
///
/// A migration is several statements plus the row that records it as done, and
/// `execute_batch` runs them one after another with no transaction of its own.
/// So a batch that died halfway -- a crash, a lock, a bad statement -- left the
/// earlier `ALTER TABLE`s applied and no version row, and the next attempt hit
/// "duplicate column name" and failed the same way forever. The index became
/// permanently unopenable, which is worse than never having migrated it.
///
/// Each migration therefore runs inside a savepoint. SQLite's DDL is
/// transactional, so a failure rolls the schema back to exactly where the retry
/// expects to find it.
fn apply_migrations(
    conn: &rusqlite::Connection,
    migrations: &[(u32, &str)],
) -> rusqlite::Result<()> {
    use rusqlite::OptionalExtension;

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at INTEGER NOT NULL
        );",
    )?;

    for (version, migration) in migrations {
        let already_applied = conn
            .query_row(
                "SELECT 1 FROM schema_migrations WHERE version = ?1",
                rusqlite::params![*version as i64],
                |_| Ok(()),
            )
            .optional()?
            .is_some();

        if already_applied {
            continue;
        }

        conn.execute_batch("SAVEPOINT be_migration")?;
        match conn.execute_batch(migration) {
            Ok(()) => conn.execute_batch("RELEASE be_migration")?,
            Err(error) => {
                // Best effort: if the rollback itself fails there is nothing
                // better to do than report the original cause.
                let _ = conn.execute_batch("ROLLBACK TO be_migration; RELEASE be_migration");
                return Err(error);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An index outlives the build that wrote it. Every caller here can be
    /// handed a stale one, so the door itself has to bring it current -- the
    /// failure this replaces was silent, not loud.
    #[test]
    fn opening_a_stale_index_brings_it_current() {
        let path = std::env::temp_dir().join(format!(
            "be-stale-open-{}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_file(&path);

        // A file carrying only the first migration, the way an old build left it.
        {
            let conn = rusqlite::Connection::open(&path).expect("create index file");
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS schema_migrations (
                   version INTEGER PRIMARY KEY,
                   applied_at INTEGER NOT NULL
                 );",
            )
            .expect("seed migrations table");
            conn.execute_batch(schema::MIGRATION_001).expect("apply 001");
        }

        let conn = open_index_connection(&path).expect("open stale index");
        let version: i64 = conn
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |r| r.get(0))
            .expect("read schema version");
        assert_eq!(version, schema::CURRENT_SCHEMA_VERSION as i64);

        // The columns a stale index was missing are the ones queries name.
        conn.query_row("SELECT COUNT(disk_bytes) FROM files", [], |r| r.get::<_, i64>(0))
            .expect("disk_bytes must exist");
        conn.query_row(
            "SELECT COUNT(source_version) FROM ontology_attrs",
            [],
            |r| r.get::<_, i64>(0),
        )
        .expect("source_version must exist");

        let _ = std::fs::remove_file(&path);
    }

    /// A migration that dies halfway must leave nothing behind. Without this
    /// the retry meets its own half-applied schema and the index can never be
    /// opened again -- a worse outcome than the original failure.
    #[test]
    fn a_migration_that_fails_halfway_leaves_no_trace() {
        let conn = rusqlite::Connection::open_in_memory().expect("open memory db");
        conn.execute_batch("CREATE TABLE t (a INTEGER);")
            .expect("seed a table");

        let broken: &[(u32, &str)] = &[(
            1,
            "ALTER TABLE t ADD COLUMN b INTEGER;
             ALTER TABLE no_such_table ADD COLUMN c INTEGER;
             INSERT INTO schema_migrations (version, applied_at) VALUES (1, 0);",
        )];
        apply_migrations(&conn, broken).expect_err("the bad statement must surface");

        let leftover: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('t') WHERE name = 'b'",
                [],
                |r| r.get(0),
            )
            .expect("inspect columns");
        assert_eq!(leftover, 0, "a failed migration must not leave a column behind");

        let recorded: i64 = conn
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |r| r.get(0))
            .expect("count migrations");
        assert_eq!(recorded, 0, "a failed migration must not be recorded as done");
    }
}
