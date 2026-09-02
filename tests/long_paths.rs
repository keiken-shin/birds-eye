//! Files Windows makes hard to reach.
//!
//! `MAX_PATH` is 260 characters. Past that, the plain Win32 calls fail unless
//! the path carries the `\\?\` extended-length prefix, and on a machine with
//! `LongPathsEnabled = 0` -- still the default -- that limit is live.
//!
//! A file the scanner cannot open is not a small problem. It is a file missing
//! from every total, every recommendation, and every "you have used X" claim,
//! with nothing on screen to say so. Deep paths are exactly where build output,
//! node_modules and old backups live, which is exactly what a person opens this
//! app to find.
//!
//! So this asks the only question that matters: given a file whose path is
//! longer than `MAX_PATH`, does the scan find it, and if it cannot, does it say
//! so?

use birds_eye::native::jobs::{JobStatusDto, ScanJobManager, StartScanJobRequest};
use std::path::PathBuf;

struct Rig {
    base: PathBuf,
    root: PathBuf,
    index: PathBuf,
}

impl Rig {
    fn new(name: &str) -> Self {
        let base = std::env::temp_dir()
            .join("birdseye-long-paths")
            .join(format!(
                "{name}-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        let root = base.join("tree");
        std::fs::create_dir_all(&root).expect("create rig root");
        Self {
            index: base.join("index.sqlite"),
            base,
            root,
        }
    }

    fn scan(&self) {
        let manager = ScanJobManager::new();
        let job = manager
            .start_scan_job(StartScanJobRequest {
                root: self.root.clone(),
                index_path: self.index.clone(),
                scan_strategy: None,
                enable_intelligence: Some(false),
            })
            .expect("start scan job");
        for _ in 0..600 {
            if !matches!(
                manager.job_status(job.job_id).expect("status"),
                JobStatusDto::Running
            ) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        panic!("the scan job never finished");
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

/// Nest until the path is comfortably past `MAX_PATH`, then put a file at the
/// bottom. Returns the file's path.
fn bury_a_file(root: &std::path::Path) -> PathBuf {
    let mut deep = root.to_path_buf();
    while deep.as_os_str().len() < 400 {
        deep = deep.join("a-long-directory-name-that-eats-path-budget");
    }
    std::fs::create_dir_all(&deep).expect("create the deep folders");
    let file = deep.join("buried.bin");
    std::fs::write(&file, vec![7u8; 4096]).expect("write the buried file");
    file
}

#[test]
fn a_file_past_max_path_is_indexed_or_reported_but_never_silently_dropped() {
    let rig = Rig::new("deep");
    let buried = bury_a_file(&rig.root);
    assert!(
        buried.as_os_str().len() > 260,
        "the fixture must actually exceed MAX_PATH: {} chars",
        buried.as_os_str().len()
    );
    std::fs::write(rig.root.join("shallow.bin"), vec![1u8; 100]).expect("shallow file");

    rig.scan();

    let conn = birds_eye::index::open_index_connection(&rig.index).expect("open index");
    let indexed: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM files WHERE name = 'buried.bin' AND deleted_at IS NULL",
            [],
            |r| r.get(0),
        )
        .expect("count");
    let issues: Vec<(String, String)> = conn
        .prepare("SELECT phase, message FROM scan_issues")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect();

    // Either outcome is defensible. Finding nothing and saying nothing is not.
    assert!(
        indexed == 1 || !issues.is_empty(),
        "the buried file was neither indexed nor reported as a problem: {issues:?}"
    );
    assert_eq!(
        indexed, 1,
        "the file is readable through the extended-length path, so it must be indexed. issues: {issues:?}"
    );
}

/// One file, two spellings of its folder. NTFS is case-insensitive, so both
/// reach the same object -- but `files.path` is unique on the raw string, so
/// two spellings would be two rows for one file.
#[test]
fn one_file_reached_by_two_spellings_of_its_path_is_still_one_file() {
    let rig = Rig::new("case");
    let folder = rig.root.join("Photos");
    std::fs::create_dir_all(&folder).expect("create folder");
    std::fs::write(folder.join("a.bin"), vec![3u8; 2048]).expect("write");

    rig.scan();
    let original_id: i64 = birds_eye::index::open_index_connection(&rig.index)
        .expect("open index")
        .query_row("SELECT id FROM files", [], |r| r.get(0))
        .expect("the file must be indexed once");

    // Scan again through a differently-cased spelling of the same tree. NTFS
    // resolves both to the same folder, so nothing new exists to find.
    let manager = ScanJobManager::new();
    let shouty = PathBuf::from(rig.root.to_string_lossy().to_uppercase());
    let job = manager
        .start_scan_job(StartScanJobRequest {
            root: shouty,
            index_path: rig.index.clone(),
            scan_strategy: None,
            enable_intelligence: Some(false),
        })
        .expect("start second scan");
    for _ in 0..600 {
        if !matches!(
            manager.job_status(job.job_id).expect("status"),
            JobStatusDto::Running
        ) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    let conn = birds_eye::index::open_index_connection(&rig.index).expect("open index");
    // Guard against the test passing for the wrong reason: if the second scan
    // could not open the shouty path at all, it would find nothing and the
    // assertion below would be vacuous.
    let (files_seen, status): (i64, String) = conn
        .query_row(
            "SELECT files_scanned, status FROM scan_sessions ORDER BY started_at DESC LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .expect("read the second session");
    assert_eq!(status, "complete", "the second scan must have run");
    assert_eq!(
        files_seen, 1,
        "the second scan must actually have walked the tree it was pointed at"
    );

    let live: Vec<(i64, String)> = conn
        .prepare("SELECT id, path FROM files WHERE deleted_at IS NULL")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(
        live.len(),
        1,
        "one file must not become two because a path was typed differently: {live:#?}"
    );
    assert_eq!(
        live[0].0, original_id,
        "and it must be the same row, so nothing attached to it is orphaned"
    );
}
