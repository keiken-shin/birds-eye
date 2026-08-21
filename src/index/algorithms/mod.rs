use rusqlite::Connection;

use crate::index::writer::{FinalizationProgress, IndexError};

mod remote_sha256;
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

/// Test seam: the same two stages against any transport, so the protocol can be
/// exercised with the real helper run locally instead of over a network.
pub(crate) use remote_sha256::{update_hashes_with_transport, HashTransport};
/// Test-only: lets `writer.rs` build a `Local` transport that runs the real
/// helper, instead of duplicating the encoder or the script.
#[cfg(test)]
pub(crate) use remote_sha256::{base64_std, PYTHON_HELPER};
