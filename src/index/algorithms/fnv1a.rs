use rusqlite::{params, Connection};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

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
               AND (partial_hash IS NULL OR hash_state < 2 OR hash_algorithm IS NULL OR hash_algorithm NOT LIKE 'fnv1a-%')
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
        if let Some(partial_hash) = partial_hash {
            tx.execute(
                "UPDATE files
                 SET partial_hash = ?1,
                     sample_hash = NULL,
                     full_hash = NULL,
                     hash_algorithm = ?2,
                     hash_state = 2
                 WHERE id = ?3",
                params![partial_hash, "fnv1a-partial-v1", id],
            )?;
        }
        emit_counted_progress(progress, "Sampling duplicate candidates", index as u64 + 1, total);
    }
    tx.commit()?;
    Ok(())
}

fn update_full_hashes_for_partial_matches<F>(
    connection: &mut Connection,
    progress: &mut F,
) -> Result<(), IndexError>
where
    F: FnMut(FinalizationProgress),
{
    let candidates = {
        let mut statement = connection.prepare(
            "SELECT id, path
             FROM files
             WHERE deleted_at IS NULL
               AND partial_hash IS NOT NULL
               AND full_hash IS NULL
               AND (size, partial_hash) IN (
                 SELECT size, partial_hash FROM files
                 WHERE deleted_at IS NULL AND partial_hash IS NOT NULL
                 GROUP BY size, partial_hash
                 HAVING COUNT(*) > 1
               )",
        )?;
        let rows = statement.query_map([], |row| {
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
                "UPDATE files
                 SET full_hash = ?1,
                     sample_hash = NULL,
                     hash_algorithm = ?2,
                     hash_state = 4
                 WHERE id = ?3",
                params![full_hash, "fnv1a-full-v1", id],
            )?;
        }
        emit_counted_progress(progress, "Full hashing strong matches", index as u64 + 1, total);
    }
    tx.commit()?;
    Ok(())
}

fn partial_file_hash(path: &Path, size: u64) -> Option<String> {
    const BLOCK_SIZE: usize = 64 * 1024;

    if size == 0 {
        return None;
    }

    let mut file = File::open(path).ok()?;
    let mut hash = fnv_offset();
    let mut buffer = vec![0_u8; BLOCK_SIZE.min(size as usize)];

    let first_read = file.read(&mut buffer).ok()?;
    update_fnv(&mut hash, &buffer[..first_read]);

    if size > BLOCK_SIZE as u64 {
        file.seek(SeekFrom::End(-(BLOCK_SIZE as i64))).ok()?;
        let last_read = file.read(&mut buffer).ok()?;
        update_fnv(&mut hash, &buffer[..last_read]);
    }

    Some(format!("{hash:016x}"))
}

fn full_file_hash(path: &Path) -> Option<String> {
    const BLOCK_SIZE: usize = 128 * 1024;

    let mut file = File::open(path).ok()?;
    let mut hash = fnv_offset();
    let mut buffer = vec![0_u8; BLOCK_SIZE];

    loop {
        let read = file.read(&mut buffer).ok()?;
        if read == 0 {
            break;
        }

        update_fnv(&mut hash, &buffer[..read]);
    }

    Some(format!("{hash:016x}"))
}

fn fnv_offset() -> u64 {
    0xcbf29ce484222325
}

fn update_fnv(hash: &mut u64, bytes: &[u8]) {
    const FNV_PRIME: u64 = 0x100000001b3;

    for byte in bytes {
        *hash ^= u64::from(*byte);
        *hash = hash.wrapping_mul(FNV_PRIME);
    }
}
