use birds_eye::native::{JobStatusDto, ScanJobManager, StartScanJobRequest};
use birds_eye::ontology::enabled::enable;
use rusqlite::Connection;
use std::path::PathBuf;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn dataset_root() -> Option<PathBuf> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let in_worktree = manifest_dir.join("chapter-2-example-real-dataset");
    if in_worktree.exists() {
        return Some(in_worktree);
    }

    let in_original_repo = manifest_dir
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.join("chapter-2-example-real-dataset"));
    in_original_repo.filter(|p| p.exists())
}

fn test_index_path(name: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock before epoch")
        .as_nanos();
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join("ontology-integration-tests")
        .join(format!("{name}-{nanos}"));
    std::fs::create_dir_all(&dir).expect("failed to create test index folder");
    dir.join("index.sqlite")
}

fn wait_for_terminal(manager: &ScanJobManager, job_id: u64) {
    for _ in 0..120 {
        let status = manager.job_status(job_id).expect("missing job status");
        if status != JobStatusDto::Running {
            assert_eq!(status, JobStatusDto::Completed, "scan job did not complete");
            wait_for_duplicate_analysis_complete(manager, job_id);
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
    panic!("scan job did not reach a terminal state");
}

fn wait_for_duplicate_analysis_complete(manager: &ScanJobManager, job_id: u64) {
    for _ in 0..120 {
        let events = manager
            .job_events_since(job_id, 0)
            .expect("failed to fetch job events");
        if events
            .iter()
            .any(|event| event.message == "Duplicate analysis complete")
        {
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
    panic!("scan job did not emit duplicate-analysis completion event");
}

fn scan_dataset(manager: &ScanJobManager, dataset: PathBuf, index_path: PathBuf) -> u64 {
    let response = manager
        .start_scan_job(StartScanJobRequest {
            root: dataset,
            index_path,
            scan_strategy: None,
        })
        .expect("failed to start scan job");
    wait_for_terminal(manager, response.job_id);
    response.job_id
}

#[test]
fn phase2_populates_sensitivity_and_role_on_real_dataset() {
    let Some(dataset) = dataset_root() else {
        eprintln!("skipping real-dataset ontology integration test: chapter-2-example-real-dataset not found");
        return;
    };

    let index_path = test_index_path("phase2-real-dataset");
    let manager = ScanJobManager::new();

    scan_dataset(&manager, dataset.clone(), index_path.clone());

    let conn = Connection::open(&index_path).expect("failed to open index database");
    enable(&conn).expect("failed to enable ontology");
    drop(conn);

    let second_job_id = scan_dataset(&manager, dataset, index_path.clone());
    let events = manager
        .job_events_since(second_job_id, 0)
        .expect("failed to fetch second job events");
    assert!(
        events.iter().any(|event| {
            event
                .log_line
                .as_ref()
                .map(|line| line.phase == "enrichment" && line.message == "phase 2 completed")
                .unwrap_or(false)
        }),
        "second scan did not emit a completed enrichment log event"
    );

    let conn = Connection::open(index_path).expect("failed to reopen index database");

    let personal_details_files: i64 = conn
        .query_row(
            "SELECT COUNT(*)
             FROM files f
             WHERE f.deleted_at IS NULL
               AND REPLACE(f.path, '\\', '/') LIKE '%Personal Details/%'",
            [],
            |row| row.get(0),
        )
        .expect("failed to count Personal Details files");
    if personal_details_files == 0 {
        eprintln!("note: fixture has no active Personal Details files; skipping Personal Details sensitivity sub-assertion");
    } else {
        let bad_personal_details_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*)
                 FROM files f
                 WHERE f.deleted_at IS NULL
                   AND REPLACE(f.path, '\\', '/') LIKE '%Personal Details/%'
                   AND NOT EXISTS (
                     SELECT 1
                     FROM ontology_entities e
                     JOIN ontology_attrs a ON a.entity_id = e.id
                     WHERE e.linked_file_id = f.id
                       AND a.key = 'sensitivity'
                       AND a.value = 'restricted'
                       AND a.display_in_global_views = 0
                   )",
                [],
                |row| row.get(0),
            )
            .expect("failed to count Personal Details files missing restricted sensitivity");
        assert_eq!(
            bad_personal_details_rows, 0,
            "some active Personal Details files lack restricted sensitivity hidden from global views"
        );
    }

    let list_psd_sources: i64 = conn
        .query_row(
            "SELECT COUNT(*)
             FROM files f
             JOIN ontology_entities e ON e.linked_file_id = f.id
             JOIN ontology_attrs a ON a.entity_id = e.id
             WHERE f.deleted_at IS NULL
               AND REPLACE(f.path, '\\', '/') LIKE '%/Toonie_world/%'
               AND lower(f.name) = 'list.psd'
               AND a.key = 'role'
               AND a.value = 'source'
               AND a.confidence >= 0.85",
            [],
            |row| row.get(0),
        )
        .expect("failed to count Toonie_world/List.psd source-role assertions");
    if list_psd_sources == 0 {
        eprintln!(
            "note: Toonie_world/List.psd not indexed with role=source; checking any active PSD"
        );
        let psd_sources: i64 = conn
            .query_row(
                "SELECT COUNT(*)
                 FROM files f
                 JOIN ontology_entities e ON e.linked_file_id = f.id
                 JOIN ontology_attrs a ON a.entity_id = e.id
                 WHERE f.deleted_at IS NULL
                   AND (
                     lower(COALESCE(f.extension, '')) = 'psd'
                     OR lower(f.name) LIKE '%.psd'
                   )
                   AND a.key = 'role'
                   AND a.value = 'source'
                   AND a.confidence >= 0.85",
                [],
                |row| row.get(0),
            )
            .expect("failed to count PSD source-role assertions");
        assert!(
            psd_sources >= 1,
            "no active PSD received role=source at confidence >= 0.85"
        );
    }

    let completed_populators: i64 = conn
        .query_row(
            "SELECT COUNT(*)
             FROM ontology_populator_state
             WHERE status = 'completed'",
            [],
            |row| row.get(0),
        )
        .expect("failed to count completed ontology populator states");
    assert!(
        completed_populators >= 2,
        "expected at least two completed ontology populator state rows"
    );
}
