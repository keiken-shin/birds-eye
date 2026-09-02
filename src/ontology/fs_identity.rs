//! "Is this still the file we reviewed?"
//!
//! Bird's Eye reviews a file at one moment and acts on it at another. In
//! between, the object at that path can be replaced: the user deletes it and
//! saves a new file with the same name, an installer rewrites it, a sync client
//! swaps it. A path is a name, not an identity, so acting on the name alone can
//! trash or move something nobody ever reviewed.
//!
//! Until real filesystem identity lands (volume serial + file id), size and
//! last-modified are the identity we have. They are weak against a deliberate
//! forgery and strong against the accident that actually happens, which is the
//! trade this module makes explicitly.
//!
//! `relocation_log::restore_move_with` already worked this way; this is that
//! rule pulled out so every destructive path shares one definition of "changed",
//! including its treatment of an unknown recorded identity.

use std::path::Path;

/// Last-modified as unix seconds, matching how `files.modified_at` is stored.
pub fn modified_secs(meta: &std::fs::Metadata) -> Option<i64> {
    meta.modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs() as i64)
}

/// Ok when the file at `path` still matches the reviewed record; `Err` with a
/// sentence for the user when it does not.
///
/// `expected_modified` is `None` when the scanner never read a timestamp. That
/// is not a mismatch -- size alone is still checked, so a file with no recorded
/// timestamp stays actionable instead of becoming permanently refused.
///
/// A vanished file is a mismatch, not a silent skip: "it is already gone" and
/// "something else is here now" are different facts and the caller reports both.
pub fn unchanged_at(
    path: &Path,
    expected_size: i64,
    expected_modified: Option<i64>,
) -> Result<(), String> {
    let Ok(found) = std::fs::metadata(path) else {
        return Err("the file is no longer at this path".to_string());
    };
    if found.is_dir() {
        return Err("a folder is at this path now, not the reviewed file".to_string());
    }
    if found.len() as i64 != expected_size {
        return Err(format!(
            "the file changed since it was reviewed (was {expected_size} bytes, now {} bytes)",
            found.len()
        ));
    }
    if let Some(expected) = expected_modified {
        if modified_secs(&found) != Some(expected) {
            return Err(
                "the file changed since it was reviewed (last-modified differs)".to_string(),
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir()
            .join("birdseye-fs-identity")
            .join(format!(
                "{name}-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn unchanged_file_passes() {
        let dir = temp_dir("same");
        let path = dir.join("a.txt");
        std::fs::write(&path, b"hello").unwrap();
        let meta = std::fs::metadata(&path).unwrap();
        assert!(unchanged_at(&path, 5, modified_secs(&meta)).is_ok());
    }

    #[test]
    fn different_size_is_refused() {
        let dir = temp_dir("resized");
        let path = dir.join("a.txt");
        std::fs::write(&path, b"hello world").unwrap();
        let error = unchanged_at(&path, 5, None).expect_err("a size change must refuse");
        assert!(error.contains("changed since it was reviewed"), "{error}");
    }

    #[test]
    fn missing_file_is_refused() {
        let dir = temp_dir("gone");
        let error =
            unchanged_at(&dir.join("nope.txt"), 5, None).expect_err("a vanished file must refuse");
        assert!(error.contains("no longer at this path"), "{error}");
    }

    /// The swap this whole module exists for: same name, same length, written
    /// later. Size alone would wave it through; the timestamp catches it.
    #[test]
    fn same_size_but_rewritten_is_refused() {
        let dir = temp_dir("swapped");
        let path = dir.join("a.txt");
        std::fs::write(&path, b"aaaaa").unwrap();
        let reviewed = modified_secs(&std::fs::metadata(&path).unwrap());
        assert!(unchanged_at(&path, 5, reviewed).is_ok());

        // Rewrite with the same length and a stamp two minutes on, so the test
        // does not depend on filesystem timestamp resolution or on sleeping.
        std::fs::write(&path, b"bbbbb").unwrap();
        let stale = reviewed.map(|t| t - 120);
        let error = unchanged_at(&path, 5, stale).expect_err("a rewritten file must refuse");
        assert!(error.contains("last-modified differs"), "{error}");
    }

    /// No recorded timestamp must not mean "never actionable".
    #[test]
    fn unknown_recorded_timestamp_still_checks_size() {
        let dir = temp_dir("no-stamp");
        let path = dir.join("a.txt");
        std::fs::write(&path, b"hello").unwrap();
        assert!(unchanged_at(&path, 5, None).is_ok());
    }
}
