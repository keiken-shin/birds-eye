//! Traversal must never follow a reparse point.
//!
//! The guard exists (`DirEntry::metadata()` does not traverse, and Rust's Windows
//! `FileType::is_symlink()` is true for every name-surrogate reparse tag, which
//! covers directory junctions as well as symlinks) — but it had no test, and
//! "symlink-safe" was doing more work in the docs than the code promised.
//!
//! The fixture is a **junction**, not a symbolic link, and that choice is the
//! point: `std::os::windows::fs::symlink_dir` needs Developer Mode or elevation,
//! so a symlink-based test skips on a default CI runner and proves nothing.
//! `mklink /J` needs no privilege at all.
//!
//! What this catches, established by mutation rather than assumed: swapping the
//! non-traversing `entry.metadata()` for `fs::metadata()` — which follows the
//! link — fails it on both counts at once, the junction walked and the payload
//! indexed twice. Deleting the explicit `is_symlink()` guard alone does *not*
//! fail it, and that is worth knowing rather than papering over: Rust's Windows
//! `FileType::is_dir()` is itself `!is_symlink() && is_directory()`, so a name
//! surrogate already falls through both the dir and the file branch. The guard
//! is the belt; `is_dir()` is the braces. The test pins the outcome, which is
//! what survives a future switch to `walkdir`/`jwalk` or to a traversing stat.
//!
//! What it does NOT cover, stated rather than implied: **hard links** are not
//! reparse points, so both names are indexed and the bytes counted twice.

#![cfg(windows)]

use birds_eye::scanner::{ScanEvent, ScanOptions, Scanner};
use std::path::{Path, PathBuf};
use std::process::Command;

fn test_root(name: &str) -> PathBuf {
    let root = std::env::current_dir()
        .expect("cwd")
        .join("target")
        .join("reparse-tests")
        .join(format!(
            "{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
    if root.exists() {
        std::fs::remove_dir_all(&root).expect("clear");
    }
    std::fs::create_dir_all(&root).expect("create");
    root
}

/// A directory junction, which needs no elevation — unlike a symbolic link.
fn make_junction(link: &Path, target: &Path) -> bool {
    Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

#[test]
fn a_junction_is_never_followed_and_nothing_is_counted_twice() {
    let root = test_root("junction");
    let real = root.join("real");
    let data = real.join("data");
    std::fs::create_dir_all(&data).expect("create real tree");
    std::fs::write(data.join("huge.bin"), vec![7u8; 4096]).expect("write payload");

    let link = root.join("link");
    if !make_junction(&link, &real) {
        eprintln!("skipping: could not create a junction on this machine");
        return;
    }
    assert!(link.join("data").join("huge.bin").exists(), "the junction resolves");

    // Straight off the event stream — this is what the walk actually saw, with
    // no index writer in between to blur the result.
    let events = Scanner::new(ScanOptions::new(root.clone())).scan();
    let mut paths: Vec<String> = Vec::new();
    for event in events {
        if let ScanEvent::FileIndexed(record) = event {
            paths.push(record.path.to_string_lossy().to_string());
        }
    }
    assert!(!paths.is_empty(), "the real file was walked");

    let through_link: Vec<&String> = paths
        .iter()
        .filter(|p| p.to_lowercase().contains("\\link\\"))
        .collect();
    assert!(
        through_link.is_empty(),
        "traversal followed the junction and indexed {through_link:?}"
    );

    let payloads = paths.iter().filter(|p| p.ends_with("huge.bin")).count();
    assert_eq!(payloads, 1, "the file must be indexed exactly once, not once per name");

    std::fs::remove_dir_all(&root).ok();
}
