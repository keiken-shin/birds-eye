//! Taking an index off the disk, all of it.
//!
//! An index is not one file. SQLite runs in WAL mode here, so `-wal` and `-shm`
//! sit beside it, and the write-ahead log holds recently written rows verbatim
//! -- paths included. A clean close checkpoints and removes them; a crash does
//! not. And every scan writes its own log file next to the index, named after
//! it, which carries the scan root and the path of anything that could not be
//! read.
//!
//! So deleting the `.sqlite` alone leaves the answer to "what was on that
//! drive" sitting in the same folder. Someone who deletes an index is asking
//! for it to be gone.
//!
//! Best-effort on each file and never on the first failure: a `-wal` that is
//! already gone must not stop the `.log` beside it from being removed.

use std::path::{Path, PathBuf};

/// Everything that belongs to one index, whether or not it exists right now.
///
/// Public so the confirmation can name what it is about to remove. A person
/// agreeing to a deletion is entitled to know what is included.
pub fn index_sidecars(index_path: &Path) -> Vec<PathBuf> {
    let mut out = vec![index_path.to_path_buf()];

    // SQLite's own companions. Their names are the index's name plus a suffix,
    // which is a fact about SQLite rather than a guess.
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut name = index_path.as_os_str().to_owned();
        name.push(suffix);
        out.push(PathBuf::from(name));
    }

    // Scan logs: `<stem>-<timestamp>-<job>.log`, written beside the index by
    // every scan. Matched by the same prefix that wrote them.
    let (Some(dir), Some(stem)) = (index_path.parent(), index_path.file_stem()) else {
        return out;
    };
    let prefix = format!("{}-", stem.to_string_lossy());
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with(&prefix) && name.ends_with(".log") {
                out.push(entry.path());
            }
        }
    }
    out
}

/// Remove an index and everything written beside it. Returns what was actually
/// removed, so the caller can say so rather than claim it.
pub fn delete_index_and_sidecars(index_path: &Path) -> Result<Vec<PathBuf>, String> {
    let mut removed = Vec::new();
    let mut index_error = None;

    for path in index_sidecars(index_path) {
        match std::fs::remove_file(&path) {
            Ok(()) => removed.push(path),
            Err(error) => {
                // The index itself failing is the only failure worth reporting:
                // the rest are usually "it was never there", which is the
                // outcome that was wanted anyway.
                if path == index_path {
                    index_error = Some(format!("failed to delete index: {error}"));
                }
            }
        }
    }

    match index_error {
        Some(error) => Err(error),
        None => Ok(removed),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rig(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("birdseye-removal").join(format!(
            "{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The leak this exists to close: the write-ahead log holds recently
    /// written rows verbatim, and the scan log names the folder that was
    /// scanned. Deleting the .sqlite alone leaves both.
    #[test]
    fn the_write_ahead_log_and_the_scan_logs_go_too() {
        let dir = rig("everything");
        let index = dir.join("alex.sqlite");
        let beside = [
            dir.join("alex.sqlite-wal"),
            dir.join("alex.sqlite-shm"),
            dir.join("alex-1788000000000-3.log"),
            dir.join("alex-1788000009999-4.log"),
        ];
        std::fs::write(&index, b"index").unwrap();
        for path in &beside {
            std::fs::write(path, b"paths a person would not want left behind").unwrap();
        }
        // Not ours: a different index in the same folder must survive.
        let neighbour = dir.join("media.sqlite");
        let neighbour_log = dir.join("media-1788000000000-1.log");
        std::fs::write(&neighbour, b"other").unwrap();
        std::fs::write(&neighbour_log, b"other").unwrap();

        let removed = delete_index_and_sidecars(&index).expect("the index must be removed");

        assert!(!index.exists(), "the index itself");
        for path in &beside {
            assert!(!path.exists(), "left behind: {}", path.display());
        }
        assert_eq!(removed.len(), 5, "the index and its four companions");
        assert!(neighbour.exists(), "another index must not be touched");
        assert!(neighbour_log.exists(), "nor its log");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A missing companion is the outcome that was wanted, not a failure.
    #[test]
    fn a_companion_that_was_never_there_is_not_an_error() {
        let dir = rig("bare");
        let index = dir.join("alex.sqlite");
        std::fs::write(&index, b"index").unwrap();

        let removed = delete_index_and_sidecars(&index).expect("must succeed");
        assert_eq!(removed, vec![index.clone()]);
        assert!(!index.exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_index_that_cannot_be_removed_says_so() {
        let dir = rig("absent");
        let missing = dir.join("nothing.sqlite");
        assert!(delete_index_and_sidecars(&missing).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }
}
