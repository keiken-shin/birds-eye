use rusqlite::Connection;

use crate::index::writer::{FinalizationProgress, IndexError};

mod xxh3;

/// Compute progressive XXH3 sample and full hashes for duplicate candidates,
/// then leave duplicate-group rebuilding to the caller.
pub fn update_hashes_for_duplicate_candidates<F>(
    connection: &mut Connection,
    progress: &mut F,
) -> Result<(), IndexError>
where
    F: FnMut(FinalizationProgress),
{
    xxh3::update_hashes_for_duplicate_candidates(connection, progress)
}
