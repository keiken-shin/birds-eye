//! Cataloging integration: suggestion → plan → execute → undo, on real files.

use birds_eye::index::schema::ALL_MIGRATIONS;
use birds_eye::native::api::{
    execute_relocation_plan, move_files, relocation_plan, ExecuteRelocationPlanRequest,
    MoveFilesRequest, MoveSpec, RelocationMoveInput, RelocationPlanRequest,
};
use rusqlite::Connection;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

fn unique_dir(name: &str) -> PathBuf {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join("catalog-integration-tests")
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

#[test]
fn relocation_round_trips_and_undoes() {
    let dir = unique_dir("round-trip");
    let inbox = dir.join("inbox");
    let home = dir.join("home");
    fs::create_dir_all(&inbox).unwrap();
    fs::create_dir_all(&home).unwrap();

    let from = inbox.join("setup.exe");
    fs::write(&from, [1u8; 64]).unwrap();
    let to = home.join("setup.exe");
    let index_path = dir.join("index.sqlite");

    {
        let conn = migrate(&index_path);
        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
             VALUES (1, NULL, ?1, 'inbox', 0, 0)",
            rusqlite::params![inbox.to_string_lossy()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, size, media_kind, indexed_at)
             VALUES (1, 1, ?1, 'setup.exe', 64, 'installer', 0)",
            rusqlite::params![from.to_string_lossy()],
        )
        .unwrap();
    }

    let plan = relocation_plan(RelocationPlanRequest {
        index_path: index_path.clone(),
        moves: vec![RelocationMoveInput {
            file_id: 1,
            from: from.to_string_lossy().to_string(),
            to: to.to_string_lossy().to_string(),
            discovery_id: None,
        }],
    })
    .expect("relocation_plan");
    assert_eq!(plan.total_files, 1);

    let result = execute_relocation_plan(ExecuteRelocationPlanRequest {
        index_path: index_path.clone(),
        plan_id: plan.plan_id,
    })
    .expect("execute_relocation_plan");

    assert_eq!(result.moved, 1);
    assert!(to.exists(), "file moved to its destination");
    assert!(!from.exists(), "source is gone");

    // Undo is the reversed pairs through move_files — no dedicated command.
    let undo = move_files(MoveFilesRequest {
        moves: result
            .pairs
            .iter()
            .map(|p| MoveSpec {
                from: p.to.clone(),
                to: p.from.clone(),
            })
            .collect(),
        index_path: Some(index_path),
    });

    assert_eq!(undo.moved, 1);
    assert!(from.exists(), "undo restored the source");
    assert!(!to.exists(), "undo emptied the destination");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_destination_collision_is_dropped_at_plan_time() {
    let dir = unique_dir("collision");
    let inbox = dir.join("inbox");
    let home = dir.join("home");
    fs::create_dir_all(&inbox).unwrap();
    fs::create_dir_all(&home).unwrap();

    let from = inbox.join("a.exe");
    fs::write(&from, [1u8; 8]).unwrap();
    let to = home.join("a.exe");
    fs::write(&to, [2u8; 8]).unwrap(); // already taken

    let index_path = dir.join("index.sqlite");
    {
        let conn = migrate(&index_path);
        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
             VALUES (1, NULL, ?1, 'inbox', 0, 0)",
            rusqlite::params![inbox.to_string_lossy()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, size, media_kind, indexed_at)
             VALUES (1, 1, ?1, 'a.exe', 8, 'installer', 0)",
            rusqlite::params![from.to_string_lossy()],
        )
        .unwrap();
    }

    let plan = relocation_plan(RelocationPlanRequest {
        index_path,
        moves: vec![RelocationMoveInput {
            file_id: 1,
            from: from.to_string_lossy().to_string(),
            to: to.to_string_lossy().to_string(),
            discovery_id: None,
        }],
    })
    .expect("relocation_plan");

    assert_eq!(plan.total_files, 0);
    assert_eq!(plan.dropped.len(), 1);
    assert_eq!(fs::read(&to).unwrap(), vec![2u8; 8], "the existing file is untouched");

    let _ = fs::remove_dir_all(&dir);
}
