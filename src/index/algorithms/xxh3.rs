use rusqlite::{params, Connection};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use xxhash_rust::xxh3::Xxh3;

use crate::index::writer::{
    emit_counted_progress, progress_stage, FinalizationProgress, IndexError,
};

pub fn update_hashes_for_duplicate_candidates<F>(
    connection: &mut Connection,
    progress: &mut F,
) -> Result<(), IndexError>
where
    F: FnMut(FinalizationProgress),
{
    update_partial_hashes_for_duplicate_candidates(connection, progress)?;
    update_full_hashes_for_partial_matches(connection, progress)
}

fn update_full_hashes_for_partial_matches<F>(
    connection: &mut Connection,
    progress: &mut F,
) -> Result<(), IndexError>
where
    F: FnMut(FinalizationProgress),
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

    progress_stage(progress, "Full hashing strong matches", 0, candidates.len() as u64);
    let tx = connection.transaction()?;
    let total = candidates.len() as u64;
    for (index, (id, path)) in candidates.into_iter().enumerate() {
        let full_hash = full_file_hash(Path::new(&path));
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

fn update_partial_hashes_for_duplicate_candidates<F>(
    connection: &mut Connection,
    progress: &mut F,
) -> Result<(), IndexError>
where
    F: FnMut(FinalizationProgress),
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

    progress_stage(progress, "Sampling duplicate candidates", 0, candidates.len() as u64);
    let tx = connection.transaction()?;
    let total = candidates.len() as u64;
    for (index, (id, path, size)) in candidates.into_iter().enumerate() {
        let partial_hash = partial_file_hash(Path::new(&path), size as u64);
        let sample_hash = sample_file_hash(Path::new(&path), size as u64);
        if let (Some(partial_hash), Some(sample_hash)) = (partial_hash, sample_hash) {
            tx.execute(
                "UPDATE files
                 SET partial_hash = ?1,
                     sample_hash = ?2,
                     full_hash = NULL,
                     hash_algorithm = ?3,
                     hash_state = 2
                 WHERE id = ?4",
                params![partial_hash, sample_hash, "xxh3-sample-v1", id],
            )?;
        }
        emit_counted_progress(progress, "Sampling duplicate candidates", index as u64 + 1, total);
    }
    tx.commit()?;
    Ok(())
}

fn partial_file_hash(path: &Path, size: u64) -> Option<String> {
    const BLOCK_SIZE: usize = 64 * 1024;

    if size == 0 {
        return None;
    }

    let last_offset = size.saturating_sub(BLOCK_SIZE as u64);
    hash_file_chunks(path, size, &[(0, BLOCK_SIZE), (last_offset, BLOCK_SIZE)])
}

fn sample_file_hash(path: &Path, size: u64) -> Option<String> {
    const BLOCK_SIZE: usize = 64 * 1024;

    if size == 0 {
        return None;
    }

    let block = BLOCK_SIZE.min(size as usize);
    let middle_offset = size.saturating_sub(block as u64) / 2;
    let last_offset = size.saturating_sub(block as u64);
    hash_file_chunks(
        path,
        size,
        &[(0, block), (middle_offset, block), (last_offset, block)],
    )
}

fn full_file_hash(path: &Path) -> Option<String> {
    const BLOCK_SIZE: usize = 128 * 1024;

    let mut file = File::open(path).ok()?;
    let mut hasher = Xxh3::new();
    let mut buffer = vec![0_u8; BLOCK_SIZE];

    loop {
        let read = file.read(&mut buffer).ok()?;
        if read == 0 {
            break;
        }

        hasher.update(&buffer[..read]);
    }

    Some(format!("{:032x}", hasher.digest128()))
}

fn hash_file_chunks(path: &Path, size: u64, chunks: &[(u64, usize)]) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let mut hasher = Xxh3::new();
    let mut buffer = vec![0_u8; chunks.iter().map(|(_, len)| *len).max().unwrap_or(0)];

    hasher.update(&size.to_le_bytes());

    for (offset, requested_len) in chunks {
        if *requested_len == 0 || *offset >= size {
            continue;
        }

        let read_len = (*requested_len).min((size - *offset) as usize);
        file.seek(SeekFrom::Start(*offset)).ok()?;
        let read = file.read(&mut buffer[..read_len]).ok()?;

        hasher.update(&offset.to_le_bytes());
        hasher.update(&(read as u64).to_le_bytes());
        hasher.update(&buffer[..read]);
    }

    Some(format!("{:032x}", hasher.digest128()))
}
