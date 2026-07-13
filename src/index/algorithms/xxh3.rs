use rayon::prelude::*;
use rusqlite::{params, Connection};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use xxhash_rust::xxh3::Xxh3;

use crate::index::writer::{
    emit_counted_progress, progress_stage, FinalizationProgress, IndexError,
};

pub fn update_hashes_for_duplicate_candidates<F, C>(
    connection: &mut Connection,
    scan_id: i64,
    cancel: &C,
    progress: &mut F,
) -> Result<(), IndexError>
where
    F: FnMut(FinalizationProgress),
    C: Fn() -> bool + Sync,
{
    update_partial_hashes_for_duplicate_candidates(connection, scan_id, cancel, progress)?;
    if cancel() {
        return Ok(());
    }
    update_full_hashes_for_partial_matches(connection, cancel, progress)
}

fn update_full_hashes_for_partial_matches<F, C>(
    connection: &mut Connection,
    cancel: &C,
    progress: &mut F,
) -> Result<(), IndexError>
where
    F: FnMut(FinalizationProgress),
    C: Fn() -> bool + Sync,
{
    const EAGER_FULL_HASH_MAX_BYTES: i64 = 64 * 1024 * 1024;
    let candidates = {
        let mut statement = connection.prepare(
            "SELECT id, path
             FROM files
             WHERE deleted_at IS NULL
               AND size <= ?1
               AND sample_hash IS NOT NULL
               AND full_hash IS NULL
               AND (size, sample_hash) IN (
                 SELECT size, sample_hash FROM files
                 WHERE deleted_at IS NULL AND sample_hash IS NOT NULL AND size <= ?1
                 GROUP BY size, sample_hash
                 HAVING COUNT(*) > 1
               )",
        )?;
        let rows = statement.query_map(params![EAGER_FULL_HASH_MAX_BYTES], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    let total = candidates.len() as u64;
    progress_stage(progress, "Full hashing strong matches", 0, total);

    let results: Vec<(i64, Option<String>)> = candidates
        .into_par_iter()
        .map(|(id, path)| {
            // A cancelled scan stops hashing right away; remaining files drain
            // as no-ops so the pool winds down within one file's worth of work.
            if cancel() {
                return (id, None);
            }
            // A failure here is not a scan issue: the file keeps its sample
            // hash and stays in duplicate detection at sampled confidence.
            (id, full_file_hash(Path::new(&path)).ok())
        })
        .collect();

    let tx = connection.transaction()?;
    for (index, (id, full_hash)) in results.into_iter().enumerate() {
        if let Some(full_hash) = full_hash {
            tx.execute(
                "UPDATE files SET full_hash = ?1, hash_algorithm = ?2, hash_state = 4 WHERE id = ?3",
                params![full_hash, "xxh3-full-v1", id],
            )?;
        }
        emit_counted_progress(progress, "Full hashing strong matches", index as u64 + 1, total);
    }
    tx.commit()?;
    Ok(())
}

enum SampleResult {
    Sampled { partial_hash: String, sample_hash: String },
    Full { full_hash: String },
    /// Hashing failed — the file ends up with no hashes and is excluded from
    /// duplicate detection, so the reason is surfaced to the user as a scan issue.
    Skipped { reason: String },
    /// The scan was cancelled mid-hash; not an issue, nothing to report.
    Cancelled,
}

fn update_partial_hashes_for_duplicate_candidates<F, C>(
    connection: &mut Connection,
    scan_id: i64,
    cancel: &C,
    progress: &mut F,
) -> Result<(), IndexError>
where
    F: FnMut(FinalizationProgress),
    C: Fn() -> bool + Sync,
{
    let candidates = {
        let mut statement = connection.prepare(
            "SELECT id, path, size
             FROM files
             WHERE deleted_at IS NULL
               AND (sample_hash IS NULL OR hash_state < 2 OR hash_algorithm IS NULL OR hash_algorithm NOT LIKE 'xxh3-%')
               AND size IN (
                 SELECT size FROM files
                 WHERE deleted_at IS NULL AND size > 0
                 GROUP BY size
                 HAVING COUNT(*) > 1
               )",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    let total = candidates.len() as u64;
    progress_stage(progress, "Sampling duplicate candidates", 0, total);

    let results: Vec<(i64, String, SampleResult)> = candidates
        .into_par_iter()
        .map(|(id, path, size)| {
            if cancel() {
                return (id, path, SampleResult::Cancelled);
            }
            let result = if sample_chunk_plan(size as u64).is_empty() {
                // Small file: hash it whole.
                match full_file_hash(Path::new(&path)) {
                    Ok(full_hash) => SampleResult::Full { full_hash },
                    Err(error) => SampleResult::Skipped { reason: error.to_string() },
                }
            } else {
                match sample_file_hash(Path::new(&path), size as u64) {
                    Ok(sample_hash) => match partial_file_hash(Path::new(&path), size as u64) {
                        Ok(partial_hash) => SampleResult::Sampled { partial_hash, sample_hash },
                        Err(error) => SampleResult::Skipped { reason: error.to_string() },
                    },
                    Err(error) => SampleResult::Skipped { reason: error.to_string() },
                }
            };
            (id, path, result)
        })
        .collect();

    let tx = connection.transaction()?;
    for (index, (id, path, result)) in results.into_iter().enumerate() {
        match result {
            SampleResult::Sampled { partial_hash, sample_hash } => {
                tx.execute(
                    "UPDATE files
                     SET partial_hash = ?1, sample_hash = ?2, full_hash = NULL,
                         hash_algorithm = ?3, hash_state = 2
                     WHERE id = ?4",
                    params![partial_hash, sample_hash, "xxh3-sample-v1", id],
                )?;
            }
            SampleResult::Full { full_hash } => {
                tx.execute(
                    "UPDATE files
                     SET partial_hash = ?1, sample_hash = ?1, full_hash = ?1,
                         hash_algorithm = ?2, hash_state = 4
                     WHERE id = ?3",
                    params![full_hash, "xxh3-full-v1", id],
                )?;
            }
            SampleResult::Skipped { reason } => {
                crate::index::writer::insert_scan_issue(&tx, scan_id, "hash", &path, &reason)?;
            }
            SampleResult::Cancelled => {}
        }
        emit_counted_progress(progress, "Sampling duplicate candidates", index as u64 + 1, total);
    }
    tx.commit()?;
    Ok(())
}

const BLOCK: usize = 64 * 1024;
const SMALL_MAX: u64 = 256 * 1024;
const MEDIUM_MAX: u64 = 1024 * 1024;
const LARGE_MAX: u64 = 512 * 1024 * 1024;

/// Returns the (offset, len) chunks to sample for a file of `size` bytes.
/// Empty means "skip sampling, hash the whole file directly".
fn sample_chunk_plan(size: u64) -> Vec<(u64, usize)> {
    if size == 0 || size <= SMALL_MAX {
        return Vec::new();
    }
    let block = BLOCK.min(size as usize);
    let last = size.saturating_sub(block as u64);
    if size <= MEDIUM_MAX {
        return vec![(0, block), (last, block)];
    }
    let middle = size.saturating_sub(block as u64) / 2;
    if size <= LARGE_MAX {
        return vec![(0, block), (middle, block), (last, block)];
    }
    // >512 MiB: head / 25% / 50% / 75% / tail
    let q = |fraction: u64| (size.saturating_sub(block as u64)) * fraction / 4;
    vec![
        (0, block),
        (q(1), block),
        (q(2), block),
        (q(3), block),
        (last, block),
    ]
}

fn partial_file_hash(path: &Path, size: u64) -> std::io::Result<String> {
    const BLOCK_SIZE: usize = 64 * 1024;

    if size == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "empty file",
        ));
    }

    let last_offset = size.saturating_sub(BLOCK_SIZE as u64);
    hash_file_chunks(path, size, &[(0, BLOCK_SIZE), (last_offset, BLOCK_SIZE)])
}

/// Sampled hash for files with a non-empty chunk plan (> 256 KiB); callers
/// check `sample_chunk_plan` first and full-hash small files instead.
fn sample_file_hash(path: &Path, size: u64) -> std::io::Result<String> {
    let plan = sample_chunk_plan(size);
    if plan.is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "file below sampling threshold",
        ));
    }
    hash_file_chunks(path, size, &plan)
}

fn full_file_hash(path: &Path) -> std::io::Result<String> {
    const BLOCK_SIZE: usize = 128 * 1024;

    let mut file = File::open(path)?;
    let mut hasher = Xxh3::new();
    let mut buffer = vec![0_u8; BLOCK_SIZE];

    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }

        hasher.update(&buffer[..read]);
    }

    Ok(format!("{:032x}", hasher.digest128()))
}

fn hash_file_chunks(path: &Path, size: u64, chunks: &[(u64, usize)]) -> std::io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Xxh3::new();
    let mut buffer = vec![0_u8; chunks.iter().map(|(_, len)| *len).max().unwrap_or(0)];

    hasher.update(&size.to_le_bytes());

    for (offset, requested_len) in chunks {
        if *requested_len == 0 || *offset >= size {
            continue;
        }

        let read_len = (*requested_len).min((size - *offset) as usize);
        file.seek(SeekFrom::Start(*offset))?;
        let read = file.read(&mut buffer[..read_len])?;

        hasher.update(&offset.to_le_bytes());
        hasher.update(&(read as u64).to_le_bytes());
        hasher.update(&buffer[..read]);
    }

    Ok(format!("{:032x}", hasher.digest128()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_temp(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("birdseye-xxh3-tests");
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let path = dir.join(name);
        std::fs::write(&path, bytes).expect("write temp file");
        path
    }

    #[test]
    fn small_files_skip_sampling() {
        assert!(sample_chunk_plan(256 * 1024).is_empty());
        assert!(sample_chunk_plan(1024).is_empty());
    }

    #[test]
    fn medium_files_use_head_and_tail() {
        let plan = sample_chunk_plan(512 * 1024);
        assert_eq!(plan.len(), 2, "256KiB-1MiB uses head+tail");
    }

    #[test]
    fn large_files_use_three_points() {
        let plan = sample_chunk_plan(8 * 1024 * 1024);
        assert_eq!(plan.len(), 3, "1MiB-512MiB uses head+middle+tail");
    }

    #[test]
    fn huge_files_use_five_points() {
        let plan = sample_chunk_plan(1024 * 1024 * 1024);
        assert_eq!(plan.len(), 5, ">512MiB uses 5-point sampling");
    }

    #[test]
    fn middle_difference_diverges_for_large_files() {
        let size = 4 * 1024 * 1024usize;
        let mut a = vec![7_u8; size];
        let mut b = vec![7_u8; size];
        a[size / 2] = 1;
        b[size / 2] = 2;
        let pa = write_temp("mid-a.bin", &a);
        let pb = write_temp("mid-b.bin", &b);
        assert_ne!(
            sample_file_hash(&pa, size as u64).expect("hash a"),
            sample_file_hash(&pb, size as u64).expect("hash b"),
            "a middle-byte difference must diverge at the middle chunk"
        );
    }
}
