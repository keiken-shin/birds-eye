use rusqlite::Connection;

use crate::index::writer::{FinalizationProgress, IndexError};
use crate::scanner::SshSource;

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

/// The same progressive refinement for a catalog whose bytes live on another
/// machine: the digests are SHA-256 and are computed by a helper shipped over
/// ssh, but the staging, thresholds and `hash_state` levels are identical, so
/// everything downstream of the `files` table is unchanged.
pub fn update_hashes_for_duplicate_candidates_remote<F, C>(
    connection: &mut Connection,
    scan_id: i64,
    source: &SshSource,
    cancel: &C,
    progress: &mut F,
) -> Result<(), IndexError>
where
    F: FnMut(FinalizationProgress),
    C: Fn() -> bool + Sync,
{
    update_hashes_with_transport(
        connection,
        scan_id,
        &HashTransport::Ssh(source.clone()),
        cancel,
        progress,
    )
}

/// Test seam: the same two stages against any transport, so the protocol can be
/// exercised with the real helper run locally instead of over a network.
pub(crate) use remote_sha256::{update_hashes_with_transport, HashTransport};
