//! Perceptual-hash populator and near-duplicate discovery emitter.
//!
//! Wave 1 keeps this dependency-light and opt-in. The hash is a coarse
//! content-sampled fingerprint suitable for triage discoveries; user
//! confirmation is still required before any cleanup semantics attach to a
//! near-duplicate cluster.

use crate::ontology::discoveries::{insert_discovery, NewDiscovery};
use crate::ontology::populators::{
    CostTier, Populator, PopulatorContext, PopulatorError, PopulatorOutcome,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::fs;

const BATCH_SIZE: i64 = 100;
const MAX_HASH_BYTES: usize = 4 * 1024 * 1024;
const NEAR_DUPLICATE_DISTANCE: u32 = 10;

pub struct PerceptualHashPopulator;

impl PerceptualHashPopulator {
    pub fn new() -> Self {
        Self
    }
}

impl Populator for PerceptualHashPopulator {
    fn name(&self) -> &'static str {
        "PerceptualHashPopulator"
    }

    fn cost_tier(&self) -> CostTier {
        CostTier::Expensive
    }

    fn run(
        &self,
        conn: &mut Connection,
        ctx: &mut PopulatorContext,
        resume_cursor: Option<&str>,
    ) -> Result<PopulatorOutcome, PopulatorError> {
        let mut last_id = resume_cursor
            .and_then(|cursor| cursor.parse::<i64>().ok())
            .unwrap_or(0);

        loop {
            if ctx.is_paused() {
                return Ok(PopulatorOutcome::Paused {
                    cursor: last_id.to_string(),
                    partial: ctx.snapshot(),
                });
            }

            let files = load_image_batch(conn, last_id)?;
            if files.is_empty() {
                break;
            }

            for file in files {
                ctx.note_file();
                if let Some((phash, dhash)) = hash_file(&file.path) {
                    upsert_hash(conn, file.id, phash, dhash)?;
                    ctx.note_assertion();
                }
                last_id = file.id;
            }
        }

        emit_near_duplicate_discoveries(conn, ctx)?;
        Ok(PopulatorOutcome::Completed(ctx.snapshot()))
    }
}

fn load_image_batch(conn: &Connection, after_id: i64) -> Result<Vec<ImageFile>, PopulatorError> {
    let mut stmt = conn.prepare(
        "SELECT id, path
         FROM files
         WHERE id > ?1
           AND deleted_at IS NULL
           AND lower(COALESCE(extension, '')) IN ('jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic')
         ORDER BY id ASC
         LIMIT ?2",
    )?;
    let rows = stmt.query_map((after_id, BATCH_SIZE), |row| {
        Ok(ImageFile {
            id: row.get(0)?,
            path: row.get(1)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn hash_file(path: &str) -> Option<([u8; 8], [u8; 8])> {
    let Ok(bytes) = fs::read(path) else {
        return None;
    };
    if bytes.is_empty() {
        return None;
    }
    let bytes = if bytes.len() > MAX_HASH_BYTES {
        &bytes[..MAX_HASH_BYTES]
    } else {
        &bytes
    };
    Some((average_hash(bytes), difference_hash(bytes)))
}

fn upsert_hash(
    conn: &Connection,
    file_id: i64,
    phash: [u8; 8],
    dhash: [u8; 8],
) -> Result<(), PopulatorError> {
    conn.execute(
        "INSERT INTO ontology_perceptual_hashes (file_id, phash, dhash, computed_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(file_id) DO UPDATE SET
           phash = excluded.phash,
           dhash = excluded.dhash,
           computed_at = excluded.computed_at",
        params![file_id, phash.to_vec(), dhash.to_vec(), unix_now()],
    )?;
    Ok(())
}

fn emit_near_duplicate_discoveries(
    conn: &Connection,
    ctx: &mut PopulatorContext,
) -> Result<(), PopulatorError> {
    let hashes = load_hashes(conn)?;
    for left_idx in 0..hashes.len() {
        for right in hashes.iter().skip(left_idx + 1) {
            if hashes[left_idx].file_id == right.file_id {
                continue;
            }
            let distance = hamming_distance(&hashes[left_idx].phash, &right.phash)
                + hamming_distance(&hashes[left_idx].dhash, &right.dhash);
            if distance > NEAR_DUPLICATE_DISTANCE {
                continue;
            }

            let payload = NearDuplicatePayload {
                files: vec![
                    NearDuplicateFile {
                        file_id: hashes[left_idx].file_id,
                        path: hashes[left_idx].path.clone(),
                        size: hashes[left_idx].size.max(0) as u64,
                    },
                    NearDuplicateFile {
                        file_id: right.file_id,
                        path: right.path.clone(),
                        size: right.size.max(0) as u64,
                    },
                ],
                hamming_distance: distance,
            };
            let payload_json = serde_json::to_string(&payload)?;
            if discovery_exists(conn, "near-duplicate-cluster", &payload_json)? {
                continue;
            }
            insert_discovery(
                conn,
                &NewDiscovery {
                    kind: "near-duplicate-cluster",
                    payload_json: &payload_json,
                    confidence: confidence_for_distance(distance),
                    potential_bytes_unlocked: hashes[left_idx]
                        .size
                        .min(right.size)
                        .max(0) as u64,
                },
            )?;
            ctx.note_discovery();
        }
    }
    Ok(())
}

fn load_hashes(conn: &Connection) -> Result<Vec<HashRow>, PopulatorError> {
    let mut stmt = conn.prepare(
        "SELECT f.id, f.path, f.size, p.phash, p.dhash
         FROM ontology_perceptual_hashes p
         JOIN files f ON f.id = p.file_id
         WHERE f.deleted_at IS NULL
         ORDER BY f.id ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(HashRow {
            file_id: row.get(0)?,
            path: row.get(1)?,
            size: row.get(2)?,
            phash: blob_to_hash(row.get::<_, Vec<u8>>(3)?),
            dhash: blob_to_hash(row.get::<_, Vec<u8>>(4)?),
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn discovery_exists(conn: &Connection, kind: &str, payload: &str) -> Result<bool, PopulatorError> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM ontology_discoveries WHERE kind = ?1 AND payload = ?2 LIMIT 1",
            (kind, payload),
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

fn average_hash(bytes: &[u8]) -> [u8; 8] {
    let samples = sample_buckets(bytes, 64);
    let mean = samples.iter().copied().sum::<u32>() / samples.len() as u32;
    bits_to_bytes(samples.iter().map(|sample| *sample >= mean))
}

fn difference_hash(bytes: &[u8]) -> [u8; 8] {
    let samples = sample_buckets(bytes, 65);
    bits_to_bytes(samples.windows(2).take(64).map(|pair| pair[1] >= pair[0]))
}

fn sample_buckets(bytes: &[u8], buckets: usize) -> Vec<u32> {
    (0..buckets)
        .map(|idx| {
            let start = idx * bytes.len() / buckets;
            let end = ((idx + 1) * bytes.len() / buckets).max(start + 1).min(bytes.len());
            let slice = &bytes[start..end];
            slice.iter().map(|byte| *byte as u32).sum::<u32>() / slice.len() as u32
        })
        .collect()
}

fn bits_to_bytes(bits: impl IntoIterator<Item = bool>) -> [u8; 8] {
    let mut out = [0_u8; 8];
    for (idx, bit) in bits.into_iter().take(64).enumerate() {
        if bit {
            out[idx / 8] |= 1 << (idx % 8);
        }
    }
    out
}

fn hamming_distance(left: &[u8; 8], right: &[u8; 8]) -> u32 {
    left.iter()
        .zip(right)
        .map(|(left, right)| (left ^ right).count_ones())
        .sum()
}

fn blob_to_hash(blob: Vec<u8>) -> [u8; 8] {
    let mut out = [0_u8; 8];
    for (idx, byte) in blob.into_iter().take(8).enumerate() {
        out[idx] = byte;
    }
    out
}

fn confidence_for_distance(distance: u32) -> f32 {
    (0.95 - (distance as f32 * 0.03)).max(0.6)
}

fn unix_now() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[derive(Debug)]
struct ImageFile {
    id: i64,
    path: String,
}

struct HashRow {
    file_id: i64,
    path: String,
    size: i64,
    phash: [u8; 8],
    dhash: [u8; 8],
}

#[derive(Serialize)]
struct NearDuplicatePayload {
    files: Vec<NearDuplicateFile>,
    hamming_distance: u32,
}

#[derive(Serialize)]
struct NearDuplicateFile {
    file_id: i64,
    path: String,
    size: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::schema::ALL_MIGRATIONS;
    use crate::ontology::discoveries::list_pending_by_kind;
    use crate::ontology::populators::{BudgetTier, PopulatorContext};
    use rusqlite::Connection;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn migrated_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        for (_, sql) in ALL_MIGRATIONS {
            conn.execute_batch(sql).unwrap();
        }
        conn
    }

    fn ctx() -> PopulatorContext {
        PopulatorContext::new(BudgetTier::AllOptIn, Arc::new(AtomicBool::new(false)))
    }

    fn temp_file(name: &str, bytes: &[u8]) -> String {
        let dir = std::env::temp_dir().join(format!(
            "be-phash-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        path.to_string_lossy().into_owned()
    }

    fn seed_file(conn: &Connection, id: i64, path: &str, extension: &str, size: i64) {
        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
             VALUES (1, NULL, '/root', 'root', 0, 0)",
            [],
        )
        .ok();
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, extension, size, indexed_at)
             VALUES (?1, 1, ?2, ?3, ?4, ?5, 0)",
            (id, path, format!("file-{id}.{extension}"), extension, size),
        )
        .unwrap();
    }

    #[test]
    fn hash_functions_are_stable_and_distance_is_small_for_tiny_change() {
        let mut bytes = (0_u8..=127).collect::<Vec<_>>();
        let first = average_hash(&bytes);
        bytes[64] = bytes[64].saturating_add(1);
        let second = average_hash(&bytes);

        assert_eq!(first, average_hash(&(0_u8..=127).collect::<Vec<_>>()));
        assert!(hamming_distance(&first, &second) <= 2);
    }

    #[test]
    fn populator_stores_hashes_for_image_files_only() {
        let mut conn = migrated_conn();
        let image = temp_file("one.jpg", &(0_u8..=127).collect::<Vec<_>>());
        let text = temp_file("notes.txt", b"hello");
        seed_file(&conn, 1, &image, "jpg", 128);
        seed_file(&conn, 2, &text, "txt", 5);

        PerceptualHashPopulator::new()
            .run(&mut conn, &mut ctx(), None)
            .unwrap();

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM ontology_perceptual_hashes", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn near_duplicate_pair_emits_discovery() {
        let mut conn = migrated_conn();
        let bytes = (0_u8..=127).collect::<Vec<_>>();
        let near = {
            let mut near = bytes.clone();
            near[32] = near[32].saturating_add(1);
            near
        };
        let first = temp_file("one.png", &bytes);
        let second = temp_file("two.png", &near);
        seed_file(&conn, 1, &first, "png", 128);
        seed_file(&conn, 2, &second, "png", 128);

        let mut context = ctx();
        PerceptualHashPopulator::new()
            .run(&mut conn, &mut context, None)
            .unwrap();

        let discoveries = list_pending_by_kind(&conn, "near-duplicate-cluster", 10).unwrap();
        assert_eq!(discoveries.len(), 1);
        assert!(discoveries[0].payload.contains("\"file_id\":1"));
        assert!(discoveries[0].payload.contains("\"file_id\":2"));
        assert_eq!(discoveries[0].potential_bytes_unlocked, 128);
        assert_eq!(context.snapshot().discoveries_emitted, 1);
    }

    #[test]
    fn rerun_does_not_duplicate_near_duplicate_discovery() {
        let mut conn = migrated_conn();
        let bytes = (0_u8..=127).collect::<Vec<_>>();
        let first = temp_file("one.jpg", &bytes);
        let second = temp_file("two.jpg", &bytes);
        seed_file(&conn, 1, &first, "jpg", 128);
        seed_file(&conn, 2, &second, "jpg", 128);

        PerceptualHashPopulator::new()
            .run(&mut conn, &mut ctx(), None)
            .unwrap();
        PerceptualHashPopulator::new()
            .run(&mut conn, &mut ctx(), None)
            .unwrap();

        let discoveries = list_pending_by_kind(&conn, "near-duplicate-cluster", 10).unwrap();
        assert_eq!(discoveries.len(), 1);
    }

    #[test]
    fn populator_is_expensive_cost() {
        assert_eq!(PerceptualHashPopulator::new().cost_tier(), CostTier::Expensive);
    }
}
