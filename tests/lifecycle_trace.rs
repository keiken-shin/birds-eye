//! One file, traced end to end, on a real volume.
//!
//! Every other test here holds one hop still and checks it. This one walks the
//! whole chain the way a person does -- scan, enrich, recommend, plan, execute,
//! restore, rescan -- and asserts the things that have to stay true *across*
//! hops, which is exactly where a static read of the code cannot see.
//!
//! The questions it asks at every hop are the ones from the lifecycle audit:
//!
//! - is an identity carried, or re-derived from a path?
//! - is a fact used later than it was observed, without revalidation?
//! - is a failure counted, or swallowed?
//! - is a state stored, or inferred?
//!
//! It runs against real files on a real filesystem, not fixtures in memory, so
//! the filesystem gets to disagree with the model if it wants to.

use birds_eye::native::api::{
    cleanup_plan, execute_cleanup_plan, list_cleanup_candidates, recently_cleaned_log,
    restore_from_cleanup_log, run_ontology_enrichment, scan_coverage, CleanupPlanRequest,
    ExecuteCleanupPlanRequest, RecentlyCleanedRequest, RestoreCleanupRequest,
    stage_item, staged_items, RunOntologyEnrichmentRequest, ScanCoverageRequest, StageItemRequest,
    StagedItemsRequest,
};
use birds_eye::ontology::staging::NewStagedItem;
use birds_eye::native::jobs::{JobStatusDto, ScanJobManager, StartScanJobRequest};
use rusqlite::Connection;
use std::path::{Path, PathBuf};

/// What one indexed file looks like from outside: its row id, the identity the
/// filesystem gave it, what it occupies, and whether the index thinks it is
/// gone.
type FileRow = (i64, Option<String>, Option<i64>, Option<i64>);

struct Rig {
    root: PathBuf,
    index: PathBuf,
}

impl Rig {
    fn new(name: &str) -> Self {
        let base = std::env::temp_dir()
            .join("birdseye-lifecycle")
            .join(format!(
                "{name}-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        let root = base;
        // The index lives beside the tree, not inside it: an index file in the
        // scanned folder is a file the scan then indexes, which quietly changes
        // every count this test makes.
        std::fs::create_dir_all(root.join("tree")).expect("create rig root");
        let index = root.join("index.sqlite");
        Self {
            root: root.join("tree"),
            index,
        }
    }

    fn write(&self, rel: &str, bytes: &[u8]) -> PathBuf {
        let path = self.root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).expect("create parent");
        std::fs::write(&path, bytes).expect("write fixture");
        path
    }

    /// The path the app itself takes: a background job, which is the only entry
    /// point that runs the hashing and duplicate phases after the walk.
    fn scan(&self) {
        let manager = ScanJobManager::new();
        let job = manager
            .start_scan_job(StartScanJobRequest {
                root: self.root.clone(),
                index_path: self.index.clone(),
                scan_strategy: None,
                enable_intelligence: Some(true),
            })
            .expect("start scan job");

        for _ in 0..600 {
            if !matches!(
                manager.job_status(job.job_id).expect("status"),
                JobStatusDto::Running
            ) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        for _ in 0..600 {
            let done = manager
                .job_events_since(job.job_id, 0)
                .expect("events")
                .iter()
                .any(|e| e.message == "Duplicate analysis complete");
            if done {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        panic!("the scan job never finished its duplicate analysis");
    }

    fn conn(&self) -> Connection {
        birds_eye::index::open_index_connection(&self.index).expect("open index")
    }

    fn row(&self, path: &Path) -> Option<FileRow> {
        self.conn()
            .query_row(
                "SELECT id, object_id, allocated_size, deleted_at FROM files WHERE path = ?1",
                rusqlite::params![path.to_string_lossy().replace('/', "\\")],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .ok()
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        if let Some(base) = self.root.parent() {
            let _ = std::fs::remove_dir_all(base);
        }
    }
}

/// A shape a person would actually have: a project with build output that
/// should be offered for cleanup, and a pair of identical files that should be
/// offered as duplicates.
fn seed(rig: &Rig) -> (PathBuf, PathBuf, PathBuf) {
    let source = rig.write("project/src/main.rs", b"fn main() { println!(\"hi\"); }\n");
    let built = rig.write("project/target/debug/app.exe", &vec![9u8; 300_000]);
    let copy_a = rig.write("photos/holiday.jpg", &vec![4u8; 200_000]);
    let _copy_b = rig.write("photos/backup/holiday.jpg", &vec![4u8; 200_000]);
    (source, built, copy_a)
}

/// The whole chain, in order, with the cross-hop invariants asserted as it goes.
#[test]
fn a_file_keeps_its_identity_and_its_evidence_across_the_whole_lifecycle() {
    let rig = Rig::new("full");
    let (source, built, copy_a) = seed(&rig);

    // --- Hop 1: filesystem -> scanner -> SQLite -------------------------
    rig.scan();

    let (source_id, source_object, source_alloc, deleted) =
        rig.row(&source).expect("the source file must be indexed");
    assert!(
        source_object.is_some(),
        "identity must be carried from the filesystem, not re-derived from the path"
    );
    assert!(
        source_alloc.is_some(),
        "what the file occupies must be recorded at the same moment as what it claims"
    );
    assert_eq!(deleted, None);

    // --- Hop 2: coverage is stored, not inferred -------------------------
    let coverage = scan_coverage(ScanCoverageRequest {
        index_path: rig.index.clone(),
    })
    .expect("coverage");
    assert!(
        coverage.files_indexed >= 4,
        "the scan must account for every file it saw: {coverage:?}"
    );
    assert_eq!(
        coverage.skipped_offline
            + coverage.skipped_locked
            + coverage.skipped_denied
            + coverage.skipped_changed
            + coverage.skipped_failed,
        0,
        "nothing on this rig is unreadable, so nothing may be reported as skipped"
    );

    // --- Hop 3: hashing -> duplicate grouping ---------------------------
    let groups: i64 = rig
        .conn()
        .query_row("SELECT COUNT(*) FROM duplicate_groups", [], |r| r.get(0))
        .expect("count groups");
    if groups != 1 {
        let rows: Vec<(String, i64, Option<String>, i64)> = rig
            .conn()
            .prepare("SELECT path, size, sample_hash, hash_state FROM files ORDER BY path")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        panic!("expected one duplicate group, found {groups}. files: {rows:#?}");
    }
    let (group_confidence, reclaimable): (f64, i64) = rig
        .conn()
        .query_row(
            "SELECT confidence, reclaimable_bytes FROM duplicate_groups",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .expect("read group");
    assert!(
        reclaimable > 0 && reclaimable <= 200_000 + 4096,
        "reclaim must be one copy's worth of occupied bytes, not two: {reclaimable}"
    );
    assert!(
        (0.0..=1.0).contains(&group_confidence),
        "confidence must stay inside its stated range"
    );

    // --- Hop 4: ontology enrichment -> recommendation -------------------
    run_ontology_enrichment(RunOntologyEnrichmentRequest {
        index_path: rig.index.clone(),
        budget: "standard".to_string(),
    })
    .expect("enrichment");

    let candidates = list_cleanup_candidates(rig.index.clone()).expect("candidates");
    assert!(
        candidates.iter().any(|c| c.path.contains("app.exe")),
        "build output under target/ must be offered for cleanup: {:?}",
        candidates.iter().map(|c| &c.path).collect::<Vec<_>>()
    );
    assert!(
        !candidates.iter().any(|c| c.path.contains("main.rs")),
        "source must never be offered for cleanup"
    );

    // --- Hop 5: plan -> execute -----------------------------------------
    let built_row = rig.row(&built).expect("built file row");
    let plan = cleanup_plan(CleanupPlanRequest {
        index_path: rig.index.clone(),
        reasons: vec![],
        max_size: None,
        path_prefix: None,
        file_ids: Some(vec![built_row.0]),
    })
    .expect("plan");
    assert_eq!(plan.total_files, 1, "the plan must contain what was staged");

    let result = execute_cleanup_plan(ExecuteCleanupPlanRequest {
        index_path: rig.index.clone(),
        plan_id: plan.plan_id,
        retention_days: Some(30),
    })
    .expect("execute");
    assert_eq!(result.cleaned, 1, "failures: {:?}", result.failed);
    assert!(!built.exists(), "the file must actually be gone");
    assert_eq!(
        result.bytes_cleaned,
        built_row.2.unwrap_or(300_000) as u64,
        "the freed figure must be what the file occupied"
    );

    // --- Hop 6: the log is a record, not an inference --------------------
    let log = recently_cleaned_log(RecentlyCleanedRequest {
        index_path: rig.index.clone(),
        limit: 10,
        offset: 0,
    })
    .expect("log");
    let entry = log
        .iter()
        .find(|e| e.original_path.contains("app.exe"))
        .expect("the removal must be recorded");
    assert_eq!(
        entry.restore_status, "in_recycle_bin",
        "the undo must be offered while the file is still recoverable"
    );

    // --- Hop 7: restore -------------------------------------------------
    restore_from_cleanup_log(RestoreCleanupRequest {
        index_path: rig.index.clone(),
        entry_id: entry.id,
    })
    .expect("restore");
    assert!(built.exists(), "restore must put the file back");
    let restored = rig.row(&built).expect("restored row");
    assert_eq!(restored.3, None, "the row must stop claiming the file is gone");

    // --- Hop 8: rescan carries identity forward --------------------------
    let moved = rig.root.join("photos/moved-holiday.jpg");
    std::fs::rename(&copy_a, &moved).expect("rename");
    rig.scan();

    let after = rig.row(&moved).expect("the moved file must still be indexed");
    let (copy_id, _, _, _) = after;
    let orphan: i64 = rig
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM files WHERE path LIKE '%holiday.jpg' AND deleted_at IS NOT NULL",
            [],
            |r| r.get(0),
        )
        .expect("count orphans");
    assert_eq!(orphan, 0, "a move is not a death");
    assert_ne!(copy_id, source_id, "different files keep different rows");

    // --- Hop 9: does the ontology follow the rename? --------------------
    run_ontology_enrichment(RunOntologyEnrichmentRequest {
        index_path: rig.index.clone(),
        budget: "standard".to_string(),
    })
    .expect("enrichment after rename");

    let entities: Vec<(i64, String, Option<i64>)> = rig
        .conn()
        .prepare(
            "SELECT id, canonical_id, linked_file_id FROM ontology_entities
             WHERE kind = 'File' AND linked_file_id = ?1",
        )
        .unwrap()
        .query_map(rusqlite::params![copy_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(
        entities.len(),
        1,
        "one file must have one entity, not one per path it has ever had: {entities:#?}"
    );
}

/// Staging remembers a path. A rename after staging leaves the basket pointing
/// at a name that no longer exists, and nothing reconciles it.
#[test]
fn a_staged_file_survives_being_renamed_underneath_the_basket() {
    let rig = Rig::new("staged-rename");
    let target = rig.write("photos/keep.jpg", &vec![1u8; 50_000]);
    rig.write("photos/other.jpg", &vec![2u8; 50_000]);
    rig.scan();

    let row = rig.row(&target).expect("indexed");
    stage_item(StageItemRequest {
        index_path: rig.index.clone(),
        item: NewStagedItem {
            kind: "file".to_string(),
            path: target.to_string_lossy().replace('/', "\\"),
            file_id: Some(row.0),
            name: "keep.jpg".to_string(),
            bytes: 50_000,
            verdict: None,
            reason: None,
            group_name: None,
            note: None,
        },
    })
    .expect("stage");

    let renamed = rig.root.join("photos/keep-2026.jpg");
    std::fs::rename(&target, &renamed).expect("rename");
    rig.scan();

    let staged = staged_items(StagedItemsRequest {
        index_path: rig.index.clone(),
    })
    .expect("staged");
    assert_eq!(staged.len(), 1, "the basket still holds one thing");
    assert_eq!(
        staged[0].path,
        renamed.to_string_lossy().replace('/', "\\"),
        "the basket must follow the file, not keep pointing at a name that is gone"
    );
}

/// One set of bytes with two names is one file's worth of disk, not two, and
/// deleting one of the names frees nothing.
#[test]
fn a_hard_link_is_counted_once_and_is_not_offered_as_a_duplicate() {
    let rig = Rig::new("hard-link");
    let original = rig.write("data/one.bin", &vec![5u8; 100_000]);
    let link = rig.root.join("data/also-one.bin");
    std::fs::hard_link(&original, &link).expect("hard link");
    rig.scan();

    let conn = rig.conn();
    let rows: i64 = conn
        .query_row("SELECT COUNT(*) FROM files WHERE deleted_at IS NULL", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(rows, 2, "both names are real files and both stay listed");

    let carriers: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM files WHERE deleted_at IS NULL AND shares_bytes_with IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(carriers, 1, "only one name may carry the bytes");

    // Matched exactly, not with LIKE: SQLite's LIKE is case-insensitive for
    // ASCII, and "AppData" ends in "data".
    let folder_bytes: i64 = conn
        .query_row(
            "SELECT direct_bytes FROM folders WHERE path = ?1",
            rusqlite::params![rig.root.join("data").to_string_lossy().replace('/', "\\")],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        folder_bytes, 100_000,
        "the folder holds one file's worth of disk, not two"
    );

    let groups: i64 = conn
        .query_row("SELECT COUNT(*) FROM duplicate_groups", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        groups, 0,
        "two names for one file are not a duplicate pair -- deleting one frees nothing"
    );
}

/// More candidates than one hashing page. The passes read, hash and write in
/// fixed-size batches now, so this proves the paging advances and terminates
/// rather than re-handing the same rows forever.
#[test]
fn hashing_covers_every_candidate_past_one_batch() {
    const FILES: usize = 5_000;
    let rig = Rig::new("paging");
    std::fs::create_dir_all(rig.root.join("many")).expect("create folder");
    // Two sizes, so every file has at least one same-size peer and therefore
    // every file is a candidate.
    for i in 0..FILES {
        let size = if i % 2 == 0 { 800 } else { 900 };
        std::fs::write(
            rig.root.join("many").join(format!("f{i:05}.bin")),
            vec![(i % 251) as u8; size],
        )
        .expect("write");
    }

    rig.scan();

    let conn = rig.conn();
    let unhashed: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM files WHERE deleted_at IS NULL AND sample_hash IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        unhashed, 0,
        "every candidate must be hashed, not just the first page"
    );
    let indexed: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM files WHERE deleted_at IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(indexed, FILES as i64);
}
