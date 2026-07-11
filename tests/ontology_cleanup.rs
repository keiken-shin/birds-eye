//! Cleanup-engine integration tests + constitutional static audits.
//!
//! Invariants exercised here:
//!   #1  No raw `fs::remove_file` / `fs::rename` in `src/ontology/` (static audit).
//!   #2  execute_cleanup_plan recycle-bins (never hard-deletes) — round trip.
//!   V3  backup protected once origin is deleted.
//!   V4  recycle-bin-first + restore round trip.

use birds_eye::index::schema::ALL_MIGRATIONS;
use birds_eye::native::api::{
    cleanup_plan, execute_cleanup_plan, recently_cleaned_log, restore_from_cleanup_log,
    CleanupPlanRequest, ExecuteCleanupPlanRequest, RecentlyCleanedRequest, RestoreCleanupRequest,
};
use rusqlite::Connection;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

fn unique_dir(name: &str) -> PathBuf {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join("cleanup-integration-tests")
        .join(format!("{name}-{nanos}"));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn migrate(index_path: &Path) -> Connection {
    let conn = Connection::open(index_path).unwrap();
    for (_, sql) in ALL_MIGRATIONS {
        conn.execute_batch(sql).unwrap();
    }
    conn
}

/// Seed a real on-disk scratch file + its index row + role=scratch fact.
fn seed_real_scratch_file(conn: &Connection, data_dir: &Path) -> PathBuf {
    let file_path = data_dir.join("scratch.bin");
    fs::write(&file_path, [7u8; 128]).unwrap();
    let path_str = file_path.to_string_lossy().to_string();

    conn.execute(
        "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
         VALUES (1, NULL, ?1, 'data', 0, 0)",
        rusqlite::params![data_dir.to_string_lossy()],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO files (id, folder_id, path, name, size, indexed_at)
         VALUES (1, 1, ?1, 'scratch.bin', 128, 0)",
        rusqlite::params![path_str],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO ontology_entities (kind, canonical_id, linked_file_id, created_at)
         VALUES ('File', ?1, 1, 0)",
        rusqlite::params![path_str],
    )
    .unwrap();
    let eid: i64 = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO ontology_attrs
            (entity_id, key, value, source, confidence, asserted_at, vocabulary_version, display_in_global_views)
         VALUES (?1, 'role', 'scratch', 'rule:test', 0.95, 0, 1, 1)",
        rusqlite::params![eid],
    )
    .unwrap();
    file_path
}

#[test]
fn invariant_1_no_raw_fs_deletes_in_ontology() {
    // Static audit: cleanup uses the `trash` crate exclusively; no module under
    // src/ontology/ may call std::fs::remove_file / remove_dir* / rename.
    let ontology_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("ontology");
    let mut offenders = Vec::new();
    visit_rs_files(&ontology_dir, &mut |path, contents| {
        for needle in ["fs::remove_file", "fs::remove_dir", "fs::rename"] {
            if contents.contains(needle) {
                offenders.push(format!("{}: {needle}", path.display()));
            }
        }
    });
    assert!(
        offenders.is_empty(),
        "src/ontology/ must not call raw filesystem delete/rename (invariant #1): {offenders:?}"
    );
}

fn visit_rs_files(dir: &Path, f: &mut impl FnMut(&Path, &str)) {
    for entry in fs::read_dir(dir).unwrap() {
        let entry = entry.unwrap();
        let path = entry.path();
        if path.is_dir() {
            visit_rs_files(&path, f);
        } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
            let contents = fs::read_to_string(&path).unwrap_or_default();
            // Strip `#[cfg(test)]` module blocks so the audit only applies to
            // production code, not unit-test helpers that legitimately clean up
            // temp files via std::fs.
            let production = strip_cfg_test_blocks(&contents);
            f(&path, &production);
        }
    }
}

/// Remove lines from a Rust source file that fall inside `#[cfg(test)]` blocks.
/// This is a best-effort line-level heuristic (not a full parser): it tracks
/// brace depth after seeing `#[cfg(test)]` and drops everything until the
/// matching closing brace.
fn strip_cfg_test_blocks(src: &str) -> String {
    let mut out = Vec::new();
    let mut in_test_block = false;
    let mut depth: i32 = 0;
    let mut pending_cfg_test = false;

    for line in src.lines() {
        let trimmed = line.trim();

        if trimmed == "#[cfg(test)]" {
            pending_cfg_test = true;
            // Drop this attribute line too.
            continue;
        }

        if pending_cfg_test {
            pending_cfg_test = false;
            if trimmed.starts_with("mod ") || trimmed == "{" {
                in_test_block = true;
                depth = 0;
                // Count braces on this line.
                for ch in line.chars() {
                    match ch {
                        '{' => depth += 1,
                        '}' => depth -= 1,
                        _ => {}
                    }
                }
                if depth <= 0 {
                    in_test_block = false;
                }
                continue;
            } else {
                // Not a mod block — emit the line normally.
                out.push(line);
                continue;
            }
        }

        if in_test_block {
            for ch in line.chars() {
                match ch {
                    '{' => depth += 1,
                    '}' => depth -= 1,
                    _ => {}
                }
            }
            if depth <= 0 {
                in_test_block = false;
            }
            // Drop this line.
            continue;
        }

        out.push(line);
    }

    out.join("\n")
}

#[test]
fn invariant_2_and_v4_recycle_bin_first_round_trip() {
    let dir = unique_dir("recycle-round-trip");
    let data_dir = dir.join("data");
    fs::create_dir_all(&data_dir).unwrap();
    let index_path = dir.join("index.sqlite");

    let file_path = {
        let conn = migrate(&index_path);
        seed_real_scratch_file(&conn, &data_dir)
    };

    // Build the plan.
    let plan = cleanup_plan(CleanupPlanRequest {
        index_path: index_path.clone(),
        reasons: vec!["scratch".to_string()],
        max_size: None,
        path_prefix: None,
    })
    .expect("cleanup_plan");
    assert_eq!(plan.total_files, 1);

    // Execute: send to recycle bin. In headless/CI environments without a recycle
    // bin this fails per-file (recorded in `failed`) rather than panicking.
    let result = execute_cleanup_plan(ExecuteCleanupPlanRequest {
        index_path: index_path.clone(),
        plan_id: plan.plan_id,
        retention_days: None,
    })
    .expect("execute_cleanup_plan");

    if result.cleaned == 0 {
        eprintln!(
            "skipping recycle-bin assertions: no recycle bin available ({:?})",
            result.failed
        );
        let _ = fs::remove_dir_all(&dir);
        return;
    }

    // #2: file is NOT at its original path (it's in the recycle bin, not hard-deleted-then-gone).
    assert!(!file_path.exists(), "file must be moved out of its original path");

    // A log row exists, in_recycle_bin.
    let log = recently_cleaned_log(RecentlyCleanedRequest {
        index_path: index_path.clone(),
        limit: 10,
        offset: 0,
    })
    .expect("recently_cleaned");
    assert_eq!(log.len(), 1);
    assert_eq!(log[0].restore_status, "in_recycle_bin");

    // Restore: file comes back to its original path.
    restore_from_cleanup_log(RestoreCleanupRequest {
        index_path: index_path.clone(),
        entry_id: log[0].id,
    })
    .expect("restore");

    assert!(file_path.exists(), "file must be restored to its original path");
    let log_after = recently_cleaned_log(RecentlyCleanedRequest {
        index_path,
        limit: 10,
        offset: 0,
    })
    .expect("recently_cleaned after restore");
    assert_eq!(log_after[0].restore_status, "restored");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn v3_backup_protected_once_origin_deleted() {
    // Pure DB-level check via the candidate API: a backup with a deleted origin
    // must not be a cleanup candidate.
    let dir = unique_dir("backup-protection");
    let index_path = dir.join("index.sqlite");
    let conn = migrate(&index_path);

    conn.execute(
        "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
         VALUES (1, NULL, '/root', 'root', 0, 0)",
        [],
    )
    .unwrap();
    // backup (id 1) + origin (id 2)
    for (id, path) in [(1i64, "/root/Backup/x.txt"), (2i64, "/root/Active/x.txt")] {
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, size, indexed_at)
             VALUES (?1, 1, ?2, 'x.txt', 1000, 0)",
            rusqlite::params![id, path],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ontology_entities (kind, canonical_id, linked_file_id, created_at)
             VALUES ('File', ?1, ?2, 0)",
            rusqlite::params![path, id],
        )
        .unwrap();
    }
    // backup role on entity 1, backupOf relation 1 -> 2
    conn.execute(
        "INSERT INTO ontology_attrs (entity_id, key, value, source, confidence, asserted_at, vocabulary_version, display_in_global_views)
         VALUES (1, 'role', 'backup', 'rule:test', 0.85, 0, 1, 1)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO ontology_relations (subject_id, predicate, object_id, source, confidence, asserted_at, vocabulary_version)
         VALUES (1, 'backupOf', 2, 'user', 1.0, 0, 1)",
        [],
    )
    .unwrap();
    drop(conn); // release the connection so api functions can open fresh ones

    // With origin alive → redundant-backup candidate.
    let alive = cleanup_plan(CleanupPlanRequest {
        index_path: index_path.clone(),
        reasons: vec![],
        max_size: None,
        path_prefix: None,
    })
    .unwrap();
    assert_eq!(alive.total_files, 1);
    assert_eq!(alive.candidates[0].reason, "redundant-backup");

    // Delete the origin → backup is protected.
    let conn2 = Connection::open(&index_path).unwrap();
    conn2.execute("UPDATE files SET deleted_at = 1 WHERE id = 2", []).unwrap();
    drop(conn2);

    let protected = cleanup_plan(CleanupPlanRequest {
        index_path,
        reasons: vec![],
        max_size: None,
        path_prefix: None,
    })
    .unwrap();
    assert_eq!(protected.total_files, 0, "backup must be protected once origin is gone");

    let _ = fs::remove_dir_all(&dir);
}
