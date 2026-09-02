//! "Is this really a duplicate of something that will still be here?"
//!
//! Duplicate detection is staged: files are grouped by size, then by a sampled
//! hash, and only candidates at or below the eager hashing cap are ever promoted
//! to a complete digest. That cap exists for a good reason -- fully reading every
//! same-size candidate on a multi-terabyte volume would make a scan unusable --
//! but it means the largest files, which are exactly the ones a person deletes to
//! reclaim space, can only ever reach sampled evidence.
//!
//! A sampled match on a 20 GB file compares about 320 KiB of it. That is a fine
//! basis for saying "look at these two". It is not a basis for deleting one.
//!
//! So the complete read happens here instead: at the moment of deletion, on the
//! handful of files the person actually selected, and only when the stored
//! evidence is weaker than a full-content match. The roadmap's line for this is
//! that cleanup of a duplicate requires complete verification or an explicit
//! override; this is the complete verification half.
//!
//! Two refusals matter as much as the match itself:
//!
//! - the copies turn out to differ, so the group was a sampling artefact
//! - every other copy is also being deleted in this same batch, so the file is
//!   not a redundant copy, it is the last one
//!
//! ponytail: reads the whole file inline, with no progress and no cancel.
//! Deleting a sampled 20 GB pair therefore reads 40 GB before anything moves.
//! That is the honest cost of the claim; giving it progress and a cancel means a
//! background job, which is worth building only once this proves slow in use.

use crate::index::algorithms::full_file_hash;
use crate::ontology::fs_identity::unchanged_at;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashSet;
use std::path::Path;

/// Evidence at or above this counts as a complete-content match already.
/// Mirrors the confidence the duplicate-group builder assigns to a full hash.
const VERIFIED_CONFIDENCE: f64 = 0.99;

struct FileRow {
    id: i64,
    size: i64,
    modified_at: Option<i64>,
}

/// Decides, for one batch of paths, which may be sent to the recycle bin.
///
/// Returns a refusal reason per path that must not be deleted. A path with no
/// entry in the result is cleared. Paths the index has never heard of are
/// cleared too: the person is pointing at a file directly, and inventing an
/// objection to a file Bird's Eye knows nothing about would only be noise.
pub fn refusals(conn: &Connection, paths: &[String]) -> Vec<(String, String)> {
    let batch: HashSet<&str> = paths.iter().map(String::as_str).collect();
    let mut out = Vec::new();

    for path in paths {
        let Some(row) = file_row(conn, path) else {
            continue;
        };

        // Same check the cleanup and relocation executors make: the path must
        // still hold the object the index describes.
        if let Err(reason) = unchanged_at(Path::new(path), row.size, row.modified_at) {
            out.push((path.clone(), reason));
            continue;
        }

        if let Some(reason) = verify_group_membership(conn, path, &row, &batch) {
            out.push((path.clone(), reason));
        }
    }

    out
}

fn file_row(conn: &Connection, path: &str) -> Option<FileRow> {
    conn.query_row(
        "SELECT id, size, modified_at FROM files WHERE path = ?1 AND deleted_at IS NULL",
        params![path],
        |row| {
            Ok(FileRow {
                id: row.get(0)?,
                size: row.get(1)?,
                modified_at: row.get(2)?,
            })
        },
    )
    .optional()
    .ok()
    .flatten()
}

/// `None` means nothing stands in the way. `Some(reason)` is shown to the person.
fn verify_group_membership(
    conn: &Connection,
    path: &str,
    row: &FileRow,
    batch: &HashSet<&str>,
) -> Option<String> {
    let group: Option<(i64, f64)> = conn
        .query_row(
            "SELECT dg.id, dg.confidence
             FROM duplicate_group_files dgf
             JOIN duplicate_groups dg ON dg.id = dgf.group_id
             WHERE dgf.file_id = ?1",
            params![row.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .ok()
        .flatten();

    // Not offered as a duplicate at all: this is an ordinary delete and the
    // identity check above is the whole contract.
    let (group_id, confidence) = group?;

    // Already backed by a complete-content match. The group builder only assigns
    // this when every member carries a full hash.
    if confidence >= VERIFIED_CONFIDENCE {
        return None;
    }

    let siblings = surviving_siblings(conn, group_id, row.id, batch);
    if siblings.is_empty() {
        return Some(
            "this would remove the last copy -- every other file in its duplicate group is in \
             this same batch"
                .to_string(),
        );
    }

    // The complete read. Hash this file once, then each survivor until one
    // matches, so the common case costs two files rather than the whole group.
    let Ok(mine) = full_file_hash(Path::new(path)) else {
        return Some("the file could not be read completely, so it cannot be verified".to_string());
    };
    store_full_hash(conn, row.id, &mine);

    for (sibling_id, sibling_path) in &siblings {
        let Ok(theirs) = full_file_hash(Path::new(sibling_path)) else {
            // A sibling we cannot read proves nothing either way. Try the next.
            continue;
        };
        store_full_hash(conn, *sibling_id, &theirs);
        if theirs == mine {
            return None;
        }
    }

    Some(
        "the copies are not identical after all -- they matched only on sampled parts of the file"
            .to_string(),
    )
}

/// Other members of the group that are not themselves being deleted right now.
fn surviving_siblings(
    conn: &Connection,
    group_id: i64,
    file_id: i64,
    batch: &HashSet<&str>,
) -> Vec<(i64, String)> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT f.id, f.path
         FROM duplicate_group_files dgf
         JOIN files f ON f.id = dgf.file_id
         WHERE dgf.group_id = ?1 AND f.id != ?2 AND f.deleted_at IS NULL",
    ) else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map(params![group_id, file_id], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    }) else {
        return Vec::new();
    };
    rows.filter_map(Result::ok)
        .filter(|(_, path)| !batch.contains(path.as_str()))
        .filter(|(_, path)| Path::new(path).exists())
        .collect()
}

/// Keep what the complete read cost us. Best-effort: a failed write means the
/// next verification pays for the read again, which is worse than free but far
/// better than refusing the deletion over a bookkeeping error.
fn store_full_hash(conn: &Connection, file_id: i64, hash: &str) {
    let _ = conn.execute(
        "UPDATE files SET full_hash = ?1, hash_algorithm = 'xxh3-full-v1', hash_state = 4
         WHERE id = ?2",
        params![hash, file_id],
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::schema::ALL_MIGRATIONS;

    fn migrated_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        for (_, sql) in ALL_MIGRATIONS {
            conn.execute_batch(sql).unwrap();
        }
        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
             VALUES (1, NULL, '/root', 'root', 0, 0)",
            [],
        )
        .unwrap();
        conn
    }

    struct Fixture {
        root: std::path::PathBuf,
    }

    impl Fixture {
        fn new(name: &str) -> Self {
            let root = std::env::temp_dir().join("birdseye-dupe-guard").join(format!(
                "{name}-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&root).unwrap();
            Self { root }
        }

        fn add(&self, conn: &Connection, id: i64, name: &str, bytes: &[u8]) -> String {
            let path = self.root.join(name);
            std::fs::write(&path, bytes).unwrap();
            let meta = std::fs::metadata(&path).unwrap();
            let modified = crate::ontology::fs_identity::modified_secs(&meta);
            let path = path.display().to_string();
            conn.execute(
                "INSERT INTO files (id, folder_id, path, name, size, modified_at, indexed_at)
                 VALUES (?1, 1, ?2, ?3, ?4, ?5, 0)",
                params![id, path, name, meta.len() as i64, modified],
            )
            .unwrap();
            path
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    /// `confidence` is what the group builder assigns: 1.0 for a full-hash
    /// group, 0.80 for a sampled one.
    fn group(conn: &Connection, confidence: f64, members: &[i64]) {
        conn.execute(
            "INSERT INTO duplicate_groups (id, size, confidence, reclaimable_bytes, created_at)
             VALUES (1, 0, ?1, 0, 0)",
            params![confidence],
        )
        .unwrap();
        for id in members {
            conn.execute(
                "INSERT INTO duplicate_group_files (group_id, file_id) VALUES (1, ?1)",
                params![id],
            )
            .unwrap();
        }
    }

    /// A large sampled group whose members only agree at the sampled offsets.
    /// The head, tail and middle match; the bytes in between do not. This is the
    /// exact case the eager hashing cap leaves unverified.
    fn sampled_pair_bodies() -> (Vec<u8>, Vec<u8>) {
        let size = 2 * 1024 * 1024;
        let mut a = vec![0_u8; size];
        let mut b = vec![0_u8; size];
        for (i, byte) in a.iter_mut().enumerate() {
            *byte = (i % 251) as u8;
        }
        b.copy_from_slice(&a);
        // A difference well away from head, middle and tail.
        b[size / 8] ^= 0xFF;
        (a, b)
    }

    #[test]
    fn a_verified_group_needs_no_further_reading() {
        let conn = migrated_conn();
        let fx = Fixture::new("verified");
        let a = fx.add(&conn, 1, "a.bin", b"identical bytes");
        fx.add(&conn, 2, "b.bin", b"identical bytes");
        group(&conn, 1.0, &[1, 2]);

        assert!(refusals(&conn, &[a]).is_empty());
    }

    #[test]
    fn a_sampled_group_whose_copies_really_match_is_allowed() {
        let conn = migrated_conn();
        let fx = Fixture::new("sampled-ok");
        let (body, _) = sampled_pair_bodies();
        let a = fx.add(&conn, 1, "a.bin", &body);
        fx.add(&conn, 2, "b.bin", &body);
        group(&conn, 0.80, &[1, 2]);

        assert!(refusals(&conn, &[a]).is_empty());
    }

    /// The defect this module exists for: a sampled group that is not actually a
    /// duplicate, which no amount of sampling would have caught.
    #[test]
    fn a_sampled_group_whose_copies_differ_is_refused() {
        let conn = migrated_conn();
        let fx = Fixture::new("sampled-lie");
        let (body_a, body_b) = sampled_pair_bodies();
        let a = fx.add(&conn, 1, "a.bin", &body_a);
        fx.add(&conn, 2, "b.bin", &body_b);
        group(&conn, 0.80, &[1, 2]);

        let refused = refusals(&conn, std::slice::from_ref(&a));
        assert_eq!(refused.len(), 1, "a false duplicate must not be deleted");
        assert_eq!(refused[0].0, a);
        assert!(refused[0].1.contains("not identical"), "{}", refused[0].1);
    }

    /// Deleting every member of a group is not reclaiming redundancy, it is
    /// deleting the file.
    #[test]
    fn deleting_every_copy_in_one_batch_is_refused() {
        let conn = migrated_conn();
        let fx = Fixture::new("last-copy");
        let (body, _) = sampled_pair_bodies();
        let a = fx.add(&conn, 1, "a.bin", &body);
        let b = fx.add(&conn, 2, "b.bin", &body);
        group(&conn, 0.80, &[1, 2]);

        let refused = refusals(&conn, &[a, b]);
        assert_eq!(refused.len(), 2, "both must be refused, not just one");
        assert!(refused[0].1.contains("last copy"), "{}", refused[0].1);
    }

    #[test]
    fn a_file_that_changed_since_indexing_is_refused() {
        let conn = migrated_conn();
        let fx = Fixture::new("changed");
        let a = fx.add(&conn, 1, "a.bin", b"original bytes");
        std::fs::write(&a, b"rather different bytes").unwrap();

        let refused = refusals(&conn, &[a]);
        assert_eq!(refused.len(), 1);
        assert!(
            refused[0].1.contains("changed since it was reviewed"),
            "{}",
            refused[0].1
        );
    }

    /// A path Bird's Eye has no row for is the person acting directly. Nothing
    /// here has an opinion about it.
    #[test]
    fn an_unindexed_path_is_left_alone() {
        let conn = migrated_conn();
        let fx = Fixture::new("unindexed");
        let path = fx.root.join("loose.bin");
        std::fs::write(&path, b"whatever").unwrap();

        assert!(refusals(&conn, &[path.display().to_string()]).is_empty());
    }

    /// A file with no duplicate group is an ordinary delete: identity is checked,
    /// nothing is read in full.
    #[test]
    fn a_file_in_no_group_is_allowed_without_hashing() {
        let conn = migrated_conn();
        let fx = Fixture::new("no-group");
        let a = fx.add(&conn, 1, "a.bin", b"solitary");

        assert!(refusals(&conn, &[a]).is_empty());
        let state: i64 = conn
            .query_row("SELECT hash_state FROM files WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(state, 0, "no group means no reason to read the file");
    }

    /// The complete read is expensive; its result is kept.
    #[test]
    fn verification_stores_the_full_hash_it_computed() {
        let conn = migrated_conn();
        let fx = Fixture::new("stores");
        let (body, _) = sampled_pair_bodies();
        let a = fx.add(&conn, 1, "a.bin", &body);
        fx.add(&conn, 2, "b.bin", &body);
        group(&conn, 0.80, &[1, 2]);

        assert!(refusals(&conn, &[a]).is_empty());
        let (hash, state): (Option<String>, i64) = conn
            .query_row("SELECT full_hash, hash_state FROM files WHERE id = 1", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert!(hash.is_some(), "the digest we paid for must be kept");
        assert_eq!(state, 4);
    }
}
