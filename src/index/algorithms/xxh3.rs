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
    Skipped { kind: SkipKind, reason: String },
    /// The scan was cancelled mid-hash; not an issue, nothing to report.
    Cancelled,
}

/// Why a file has no hash. Stored per issue and tallied per scan, because
/// "we could not open it" and "it was being written while we read it" call for
/// different things from the person reading the report -- and because the issue
/// table is capped, so the tally cannot be recovered by counting rows later.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum SkipKind {
    /// Online-only cloud placeholder; the bytes are not on this machine.
    Offline,
    /// Something else holds it open (Windows sharing violation).
    Locked,
    /// The filesystem refused us.
    Denied,
    /// It moved under the read, so any digest would describe nothing real.
    Changed,
    /// Anything else, kept separate so it never hides inside a named class.
    Failed,
}

impl SkipKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Offline => "offline",
            Self::Locked => "locked",
            Self::Denied => "denied",
            Self::Changed => "changed",
            Self::Failed => "failed",
        }
    }
}

fn classify(error: &std::io::Error) -> SkipKind {
    const SHARING_VIOLATION: i32 = 32;
    if error.kind() == std::io::ErrorKind::PermissionDenied {
        return SkipKind::Denied;
    }
    if error.raw_os_error() == Some(SHARING_VIOLATION) {
        return SkipKind::Locked;
    }
    let message = error.to_string();
    if message == CHANGED_DURING_READ || message == CHANGED_SIZE {
        return SkipKind::Changed;
    }
    SkipKind::Failed
}

fn skipped(error: &std::io::Error) -> SampleResult {
    SampleResult::Skipped { kind: classify(error), reason: error.to_string() }
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
            // Online-only cloud placeholders would stall for the provider's
            // timeout and then fail anyway — classify them up front with the
            // fix in the message instead of a cryptic OS error.
            if is_cloud_placeholder(Path::new(&path)) {
                return (
                    id,
                    path,
                    SampleResult::Skipped {
                        kind: SkipKind::Offline,
                        reason: CLOUD_PLACEHOLDER_REASON.to_owned(),
                    },
                );
            }
            let result = if sample_chunk_plan(size as u64).is_empty() {
                // Small file: hash it whole.
                match with_lock_retry(|| full_file_hash(Path::new(&path))) {
                    Ok(full_hash) => SampleResult::Full { full_hash },
                    Err(error) => skipped(&error),
                }
            } else {
                match with_lock_retry(|| sample_file_hash(Path::new(&path), size as u64)) {
                    Ok(sample_hash) => {
                        match with_lock_retry(|| partial_file_hash(Path::new(&path), size as u64)) {
                            Ok(partial_hash) => SampleResult::Sampled { partial_hash, sample_hash },
                            Err(error) => skipped(&error),
                        }
                    }
                    Err(error) => skipped(&error),
                }
            };
            (id, path, result)
        })
        .collect();

    // Counted here rather than recovered from `scan_issues` later: that table is
    // capped, so past the cap the rows stop and the count would quietly go wrong
    // in the direction that flatters the scan.
    let mut tally: std::collections::HashMap<&'static str, i64> = std::collections::HashMap::new();

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
            SampleResult::Skipped { kind, reason } => {
                *tally.entry(kind.as_str()).or_insert(0) += 1;
                crate::index::writer::insert_scan_issue(
                    &tx,
                    scan_id,
                    "hash",
                    kind.as_str(),
                    &path,
                    &reason,
                )?;
            }
            SampleResult::Cancelled => {}
        }
        emit_counted_progress(progress, "Sampling duplicate candidates", index as u64 + 1, total);
    }
    crate::index::writer::add_scan_skips(&tx, scan_id, &tally)?;
    tx.commit()?;
    Ok(())
}

const BLOCK: usize = 64 * 1024;
const SMALL_MAX: u64 = 256 * 1024;
const MEDIUM_MAX: u64 = 1024 * 1024;
const LARGE_MAX: u64 = 512 * 1024 * 1024;

pub(crate) const CLOUD_PLACEHOLDER_REASON: &str = "online-only cloud file — make it available \
offline (e.g. OneDrive → 'Always keep on this device'), then retry verification";

/// Dehydrated cloud files (OneDrive "Files On-Demand" etc.) report a size but
/// reading them triggers a download or a long provider timeout. Detected via
/// file attributes so they can be reported instead of stalling the scan.
#[cfg(windows)]
fn is_cloud_placeholder(path: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_OFFLINE: u32 = 0x0000_1000;
    const FILE_ATTRIBUTE_RECALL_ON_OPEN: u32 = 0x0004_0000;
    const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
    std::fs::metadata(path)
        .map(|m| {
            m.file_attributes()
                & (FILE_ATTRIBUTE_OFFLINE
                    | FILE_ATTRIBUTE_RECALL_ON_OPEN
                    | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS)
                != 0
        })
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn is_cloud_placeholder(_path: &Path) -> bool {
    false
}

/// One short retry absorbs files that were momentarily locked mid-write
/// (Windows sharing violation, os error 32). Long-lived locks still fail and
/// get reported with the holding process discoverable from the UI.
fn with_lock_retry<T>(op: impl Fn() -> std::io::Result<T>) -> std::io::Result<T> {
    const SHARING_VIOLATION: i32 = 32;
    match op() {
        Err(error) if error.raw_os_error() == Some(SHARING_VIOLATION) => {
            std::thread::sleep(std::time::Duration::from_millis(250));
            op()
        }
        other => other,
    }
}

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

/// Length and last-modified, read from the open handle rather than the path, so
/// the stamp describes the object being read and not whatever the name points at
/// by the time we ask again.
#[derive(PartialEq, Eq)]
struct ReadStamp {
    len: u64,
    modified: Option<std::time::SystemTime>,
}

fn stamp(file: &File) -> std::io::Result<ReadStamp> {
    let meta = file.metadata()?;
    Ok(ReadStamp {
        len: meta.len(),
        modified: meta.modified().ok(),
    })
}

/// Named, because the coverage tally has to tell "it was moving" apart from
/// "it was locked" and matching loose prose would drift the moment someone
/// rewords an error.
pub(crate) const CHANGED_DURING_READ: &str = "the file changed while it was being read";
pub(crate) const CHANGED_SIZE: &str = "the file changed size since it was scanned";

fn changed_while_reading() -> std::io::Error {
    std::io::Error::other(CHANGED_DURING_READ)
}

/// The scanner records a file's size and timestamps during directory
/// enumeration. Hashing happens in a later phase, possibly minutes later. If
/// another process writes the file in between, the digest describes a version of
/// the file that never existed at rest.
///
/// So every read is bracketed: stamp the open handle, read, stamp again, and
/// refuse to return a digest unless the two agree. An unstable read yields an
/// error, which the caller records as a scan issue -- the file then carries no
/// hash and takes no part in duplicate detection, which is the safe direction.
/// A digest that is silently wrong is worse than no digest.
fn stable_read<T>(
    path: &Path,
    expected_len: Option<u64>,
    read: impl FnOnce(&mut File, &ReadStamp) -> std::io::Result<T>,
) -> std::io::Result<T> {
    let mut file = File::open(path)?;
    let before = stamp(&file)?;

    // The caller's chunk plan was computed from the size the scanner recorded.
    // If the file is no longer that size the plan describes a different file,
    // and seeking into it would hash whatever now occupies those offsets.
    if let Some(expected) = expected_len {
        if before.len != expected {
            return Err(std::io::Error::other(CHANGED_SIZE));
        }
    }

    let value = read(&mut file, &before)?;

    let after = stamp(&file)?;
    if before != after {
        return Err(changed_while_reading());
    }
    Ok(value)
}

/// Complete-content digest. Public because verification before a destructive
/// action needs it on demand, for files far above the eager hashing cap.
pub fn full_file_hash(path: &Path) -> std::io::Result<String> {
    const BLOCK_SIZE: usize = 128 * 1024;

    stable_read(path, None, |file, before| {
        let mut hasher = Xxh3::new();
        let mut buffer = vec![0_u8; BLOCK_SIZE];
        let mut total = 0_u64;

        loop {
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            total += read as u64;
            hasher.update(&buffer[..read]);
        }

        // Reaching EOF early is not an error from `read`, so a file truncated
        // mid-pass would otherwise produce a confident digest of a prefix.
        if total != before.len {
            return Err(changed_while_reading());
        }

        Ok(format!("{:032x}", hasher.digest128()))
    })
}

fn hash_file_chunks(path: &Path, size: u64, chunks: &[(u64, usize)]) -> std::io::Result<String> {
    stable_read(path, Some(size), |file, _| {
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
            if read != read_len {
                return Err(changed_while_reading());
            }

            hasher.update(&offset.to_le_bytes());
            hasher.update(&(read as u64).to_le_bytes());
            hasher.update(&buffer[..read]);
        }

        Ok(format!("{:032x}", hasher.digest128()))
    })
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

    /// The race this bracket exists for: the scanner recorded the file minutes
    /// ago, and something rewrites it while the hasher is mid-pass. The digest
    /// would describe a version of the file that never existed at rest.
    #[test]
    fn a_file_rewritten_during_the_read_yields_no_digest() {
        let path = write_temp("grows-mid-read.bin", b"hello");
        let inner = path.clone();
        let error = stable_read(&path, None, move |_file, _before| {
            std::fs::write(&inner, b"hello, considerably longer now")?;
            Ok(())
        })
        .expect_err("an unstable read must not return a value");
        assert!(
            error.to_string().contains("changed while it was being read"),
            "{error}"
        );
    }

    #[test]
    fn a_stable_read_returns_its_value() {
        let path = write_temp("stable.bin", b"hello");
        let value = stable_read(&path, None, |_file, before| Ok(before.len)).expect("stable read");
        assert_eq!(value, 5);
    }

    /// The chunk plan is computed from the size the scanner recorded. If the
    /// file is no longer that size, seeking into it hashes whatever now occupies
    /// those offsets -- a confident digest of a different file.
    #[test]
    fn sampling_refuses_when_the_file_is_no_longer_the_size_that_was_scanned() {
        let size = 4 * 1024 * 1024_usize;
        let path = write_temp("resized.bin", &vec![3_u8; size]);
        let stale_size = (size + 4096) as u64;
        let plan = sample_chunk_plan(stale_size);
        let error = hash_file_chunks(&path, stale_size, &plan)
            .expect_err("a size disagreement must refuse");
        assert!(error.to_string().contains("changed size"), "{error}");
    }

    /// And the honest case still works, so the guard above is not simply
    /// refusing everything.
    #[test]
    fn sampling_succeeds_when_the_size_still_agrees() {
        let size = 4 * 1024 * 1024_usize;
        let path = write_temp("agrees.bin", &vec![3_u8; size]);
        assert!(sample_file_hash(&path, size as u64).is_ok());
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
