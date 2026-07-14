use rusqlite::Connection;

use crate::index::writer::{FinalizationProgress, IndexError};

mod xxh3;

/// Compute progressive XXH3 sample and full hashes for duplicate candidates,
/// then leave duplicate-group rebuilding to the caller. `cancel` is polled per
/// file so a cancelled scan stops hashing promptly. Files whose hashing fails
/// are recorded as `scan_issues` rows (phase 'hash') under `scan_id`.
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
    xxh3::update_hashes_for_duplicate_candidates(connection, scan_id, cancel, progress)
}
