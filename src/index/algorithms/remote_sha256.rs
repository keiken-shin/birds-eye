//! SHA-256 duplicate detection for SSH-sourced indexes.
//!
//! Remote files cannot be opened here, so the hashing runs on the other machine:
//! a small helper script (Python, or Perl where python3 is missing) is shipped
//! base64'd on the ssh command line, fed NUL-terminated requests on stdin, and
//! answers with NUL-terminated `{key}\t{hex64}` records on stdout.
//!
//! The staging, thresholds and chunk offsets are the local hasher's — [`xxh3`]
//! owns them and this module borrows them — so a remote catalog reaches the same
//! `hash_state` 2/4 confidence levels as a local one and needs no changes
//! anywhere downstream. Only the digest differs (SHA-256, computed remotely),
//! which is why the rows carry their own algorithm tags.

use rusqlite::{params, Connection};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::process::{Command, Stdio};

use super::xxh3;
use crate::index::writer::{
    emit_counted_progress, insert_scan_issue, progress_stage, FinalizationProgress, IndexError,
};
use crate::scanner::{ssh_prefix_args, SshSource};

/// Sampled (stage A) and verified (stage A small files, stage B) row tags. They
/// mirror `xxh3-sample-v1` / `xxh3-full-v1` so a re-scan can tell which hasher
/// wrote a row and re-hash the ones it did not.
pub(crate) const SAMPLE_TAG: &str = "remote-sha256-sample-v1";
pub(crate) const FULL_TAG: &str = "remote-sha256-full-v1";

pub(crate) const PYTHON_HELPER: &str = include_str!("helpers/remote_hash.py");
pub(crate) const PERL_HELPER: &str = include_str!("helpers/remote_hash.pl");

/// One runtime probe, no host or distro special-casing: python3, else perl,
/// else nothing and the user is told why duplicates are unavailable.
pub(crate) const PROBE_COMMAND: &str = "command -v python3 >/dev/null 2>&1 && echo python3 || { command -v perl >/dev/null 2>&1 && echo perl || echo none; }";

/// Requests per child process. Small enough that a dropped connection loses
/// little work and progress keeps moving, large enough that process startup is
/// noise against the hashing.
const REQUEST_BATCH: usize = 5_000;

/// Stage B never full-hashes anything bigger than this, exactly as `xxh3.rs`.
const EAGER_FULL_HASH_MAX_BYTES: i64 = 64 * 1024 * 1024;

/// Longest helper/ssh diagnostic echoed into a scan issue.
const MAX_ISSUE_CHARS: usize = 500;

const SAMPLING_STAGE: &str = "Sampling duplicate candidates";
const FULL_STAGE: &str = "Full hashing strong matches";

const NO_INTERPRETER: &str =
    "duplicate detection needs python3 or perl on the remote host — neither was found";

/// Where the hashing runs. `Local` is the test seam (and what an `Ssh` transport
/// resolves to once the remote interpreter is known: `ssh` is just a program).
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum HashTransport {
    Ssh(SshSource),
    Local { program: String, args: Vec<String> },
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum RemoteExecutor {
    Python3,
    Perl,
}

/// Which hash a request fills in. `p` and `s` mirror the local partial/sample
/// pair; `f` is a whole-file digest (small files in stage A, and all of stage B).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum Kind {
    Partial,
    Sample,
    Full,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Spec {
    Full,
    Chunks(Vec<(u64, usize)>),
}

impl Spec {
    fn encode(&self) -> String {
        match self {
            Spec::Full => "full".to_owned(),
            Spec::Chunks(chunks) => chunks
                .iter()
                .map(|(offset, len)| format!("{offset}:{len}"))
                .collect::<Vec<_>>()
                .join(","),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Request {
    pub key: String,
    pub size: u64,
    pub spec: Spec,
    pub path: String,
}

impl Request {
    /// `{key}\t{size}\t{spec}\t{path}\0` — the path goes last because it is the
    /// one field that may contain tabs.
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.path.len() + 64);
        out.extend_from_slice(self.key.as_bytes());
        out.push(b'\t');
        out.extend_from_slice(self.size.to_string().as_bytes());
        out.push(b'\t');
        out.extend_from_slice(self.spec.encode().as_bytes());
        out.push(b'\t');
        out.extend_from_slice(self.path.as_bytes());
        out.push(0);
        out
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Response {
    Ok { key: String, hex: String },
    Err { key: String, message: String },
}

impl Response {
    fn key(&self) -> &str {
        match self {
            Response::Ok { key, .. } | Response::Err { key, .. } => key,
        }
    }
}

/// A record without its trailing NUL. Anything that is not a well-formed
/// response is dropped rather than trusted: the hex has to be exactly the 64
/// lowercase characters a SHA-256 digest prints as, or it is not a hash.
pub(crate) fn parse_response(record: &[u8]) -> Option<Response> {
    let text = std::str::from_utf8(record).ok()?;
    let (key, rest) = text.split_once('\t')?;
    if key.is_empty() {
        return None;
    }
    if let Some(message) = rest.strip_prefix("ERR\t") {
        return Some(Response::Err {
            key: key.to_owned(),
            message: message.to_owned(),
        });
    }
    if rest.len() != 64 || !rest.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return None;
    }
    Some(Response::Ok {
        key: key.to_owned(),
        hex: rest.to_owned(),
    })
}

pub(crate) fn parse_key(key: &str) -> Option<(i64, Kind)> {
    let (id, kind) = key.split_once(':')?;
    let id: i64 = id.parse().ok()?;
    let kind = match kind {
        "p" => Kind::Partial,
        "s" => Kind::Sample,
        "f" => Kind::Full,
        _ => return None,
    };
    Some((id, kind))
}

/// The local plan, asked of a remote file: small files are hashed whole, larger
/// ones get the head+tail partial and the sampled chunk plan.
pub(crate) fn stage_a_requests(file_id: i64, size: u64, path: &str) -> Vec<Request> {
    let plan = xxh3::sample_chunk_plan(size);
    if plan.is_empty() {
        debug_assert!(size <= xxh3::SMALL_MAX, "only small files skip sampling");
        return vec![Request {
            key: format!("{file_id}:f"),
            size,
            spec: Spec::Full,
            path: path.to_owned(),
        }];
    }
    let last = size.saturating_sub(xxh3::BLOCK as u64);
    vec![
        Request {
            key: format!("{file_id}:p"),
            size,
            spec: Spec::Chunks(vec![(0, xxh3::BLOCK), (last, xxh3::BLOCK)]),
            path: path.to_owned(),
        },
        Request {
            key: format!("{file_id}:s"),
            size,
            spec: Spec::Chunks(plan),
            path: path.to_owned(),
        },
    ]
}

/// Standard base64, ~15 lines instead of a dependency the app would carry
/// forever for one command line.
pub(crate) fn base64_std(input: &str) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let second = chunk.get(1).copied().unwrap_or(0);
        let third = chunk.get(2).copied().unwrap_or(0);
        let packed = ((chunk[0] as u32) << 16) | ((second as u32) << 8) | third as u32;
        out.push(ALPHABET[(packed >> 18 & 63) as usize] as char);
        out.push(ALPHABET[(packed >> 12 & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(packed >> 6 & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[(packed & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// The single remote command string. Base64 is quote-safe in both shells, which
/// is the whole reason the helper travels encoded rather than as a heredoc.
pub(crate) fn helper_command(executor: RemoteExecutor) -> String {
    match executor {
        RemoteExecutor::Python3 => format!(
            "python3 -c \"import base64,sys;exec(base64.b64decode('{}'))\"",
            base64_std(PYTHON_HELPER)
        ),
        RemoteExecutor::Perl => format!(
            "perl -MMIME::Base64 -e 'eval decode_base64(shift); die $@ if $@' {}",
            base64_std(PERL_HELPER)
        ),
    }
}

/// How often the probe looks up from waiting to see whether the scan was cancelled.
const PROBE_POLL: std::time::Duration = std::time::Duration::from_millis(50);

/// Asks the host what it can run. `Ok(None)` is a host with neither interpreter
/// — a real answer, not a failure; `Err` means ssh itself could not ask, and a
/// cancelled scan is one of those (callers check `cancel()` before reporting).
///
/// Deliberately not `Command::output()`: that blocks with no way out, and a
/// remote shell that authenticates and then wedges would park the finalization
/// thread until the app dies, with the scan unable to cancel.
pub(crate) fn probe(
    source: &SshSource,
    cancel: &dyn Fn() -> bool,
) -> Result<Option<RemoteExecutor>, String> {
    // ConnectTimeout only covers the TCP connect. Keepalives are what notice a
    // session that came up and then stopped answering.
    let mut args = vec![
        "-o".to_owned(),
        "ServerAliveInterval=10".to_owned(),
        "-o".to_owned(),
        "ServerAliveCountMax=3".to_owned(),
    ];
    args.extend(ssh_prefix_args(source));
    args.push(PROBE_COMMAND.to_owned());

    let mut child = Command::new("ssh")
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to run ssh — is the OpenSSH client installed? ({error})"))?;

    // Both pipes drain on threads so this one stays free to poll cancel.
    let mut stdout = child.stdout.take().expect("stdout is piped");
    let mut stderr = child.stderr.take().expect("stderr is piped");
    let answer = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stdout.read_to_string(&mut text);
        text
    });
    let diagnostics = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text);
        text
    });

    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(error) => return Err(format!("ssh could not be waited on ({error})")),
        }
        if cancel() {
            let _ = child.kill();
            let _ = child.wait();
            return Err("cancelled".to_owned());
        }
        std::thread::sleep(PROBE_POLL);
    };

    let answer = answer.join().unwrap_or_default();
    let diagnostics = diagnostics.join().unwrap_or_default();
    if !status.success() {
        let tail = tail_chars(&diagnostics, MAX_ISSUE_CHARS);
        return Err(if tail.is_empty() {
            format!("ssh exited with {status}")
        } else {
            tail
        });
    }
    match answer.trim() {
        "python3" => Ok(Some(RemoteExecutor::Python3)),
        "perl" => Ok(Some(RemoteExecutor::Perl)),
        _ => Ok(None),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StreamOutcome {
    Completed,
    Cancelled,
}

/// Streams requests into the child while draining its responses. The write side
/// runs on its own thread: a child that answers as it reads would otherwise
/// deadlock against a full stdin pipe.
pub(crate) fn drive_stream<R: Read, W: Write + Send + 'static>(
    reader: R,
    writer: W,
    requests: Vec<Request>,
    cancel: &dyn Fn() -> bool,
    mut on_response: impl FnMut(Response),
) -> StreamOutcome {
    let pump = std::thread::spawn(move || {
        let mut buffered = BufWriter::new(writer);
        for request in requests {
            if buffered.write_all(&request.encode()).is_err() {
                return;
            }
        }
        let _ = buffered.flush();
        // Dropping the writer closes the child's stdin, which is its EOF signal.
    });

    let mut reader = BufReader::new(reader);
    let mut record = Vec::new();
    // ponytail: cancel is polled per record; a child that has gone silent blocks
    // this read until it dies with the app — add a watchdog kill if that bites.
    let outcome = loop {
        if cancel() {
            break StreamOutcome::Cancelled;
        }
        record.clear();
        match reader.read_until(0, &mut record) {
            Ok(0) | Err(_) => break StreamOutcome::Completed,
            Ok(_) => {}
        }
        if record.last() == Some(&0) {
            record.pop();
        }
        if record.is_empty() {
            continue;
        }
        if let Some(response) = parse_response(&record) {
            on_response(response);
        }
    };

    // A cancelled run leaves the pump blocked on a child that stopped reading;
    // the caller kills the child, which frees it. Joining here would hang.
    if outcome == StreamOutcome::Completed {
        let _ = pump.join();
    }
    outcome
}

/// Runs one batch through a fresh child. `Err` is a transport failure — the
/// child never started, or died before EOF — never a per-file problem, which
/// comes back as a [`Response::Err`].
pub(crate) fn run_requests(
    transport: &HashTransport,
    requests: Vec<Request>,
    cancel: &dyn Fn() -> bool,
) -> Result<Vec<Response>, String> {
    let (program, args) = resolve_command(transport, cancel)?;
    let mut child = Command::new(&program)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to run {program} ({error})"))?;

    let stdin = child.stdin.take().expect("stdin is piped");
    let stdout = child.stdout.take().expect("stdout is piped");
    let mut stderr = child.stderr.take().expect("stderr is piped");
    // Drained on a thread so a chatty child cannot stall on a full stderr pipe.
    let drain = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text);
        text
    });

    let mut responses = Vec::with_capacity(requests.len());
    let outcome = drive_stream(stdout, stdin, requests, cancel, |response| {
        responses.push(response)
    });
    if outcome == StreamOutcome::Cancelled {
        let _ = child.kill();
    }
    let status = child.wait();
    let diagnostics = drain.join().unwrap_or_default();

    if outcome == StreamOutcome::Cancelled {
        return Ok(responses);
    }
    if matches!(&status, Ok(status) if status.success()) {
        return Ok(responses);
    }
    let tail = tail_chars(&diagnostics, MAX_ISSUE_CHARS);
    Err(if tail.is_empty() {
        match status {
            Ok(status) => format!("{program} exited with {status}"),
            Err(error) => format!("{program} could not be waited on ({error})"),
        }
    } else {
        tail
    })
}

fn resolve_command(
    transport: &HashTransport,
    cancel: &dyn Fn() -> bool,
) -> Result<(String, Vec<String>), String> {
    match transport {
        HashTransport::Local { program, args } => Ok((program.clone(), args.clone())),
        HashTransport::Ssh(source) => {
            let executor = probe(source, cancel)?.ok_or_else(|| NO_INTERPRETER.to_owned())?;
            Ok(("ssh".to_owned(), ssh_hash_args(source, executor)))
        }
    }
}

/// Probes on first use and remembers the answer: a finalization with nothing to
/// hash never opens a connection at all, and the two stages share one probe.
fn resolved_transport<'a>(
    transport: &HashTransport,
    slot: &'a mut Option<HashTransport>,
    cancel: &dyn Fn() -> bool,
) -> Result<&'a HashTransport, String> {
    if slot.is_none() {
        let (program, args) = resolve_command(transport, cancel)?;
        *slot = Some(HashTransport::Local { program, args });
    }
    Ok(slot.as_ref().expect("just resolved"))
}

fn ssh_hash_args(source: &SshSource, executor: RemoteExecutor) -> Vec<String> {
    let mut args = ssh_prefix_args(source);
    args.push(helper_command(executor));
    args
}

fn tail_chars(message: &str, max: usize) -> String {
    let trimmed = message.trim();
    let count = trimmed.chars().count();
    if count <= max {
        return trimmed.to_owned();
    }
    trimmed.chars().skip(count - max).collect()
}

struct Candidate {
    id: i64,
    path: String,
    size: u64,
}

/// Both stages against one transport. Mirrors the local hasher's contract:
/// cancellation and transport failures leave every hash already written in
/// place and return `Ok`, so group building still runs on whatever exists.
pub(crate) fn update_hashes_with_transport<F, C>(
    connection: &mut Connection,
    scan_id: i64,
    transport: &HashTransport,
    cancel: &C,
    progress: &mut F,
) -> Result<(), IndexError>
where
    F: FnMut(FinalizationProgress),
    C: Fn() -> bool + Sync,
{
    if cancel() {
        return Ok(());
    }

    // What a transport failure is reported against; the files themselves are
    // fine, the connection to them is not.
    let scope = match transport {
        HashTransport::Ssh(source) => source.root.clone(),
        HashTransport::Local { program, .. } => program.clone(),
    };
    // Filled by whichever stage first has work to do; see `resolved_transport`.
    let mut resolved = None;

    if stage_a(
        connection,
        scan_id,
        transport,
        &mut resolved,
        &scope,
        cancel,
        progress,
    )? {
        return Ok(());
    }
    if cancel() {
        return Ok(());
    }
    stage_b(
        connection,
        scan_id,
        transport,
        &mut resolved,
        &scope,
        cancel,
        progress,
    )
}

/// Sample every duplicate candidate. Returns `true` when the transport stopped
/// the stage — the caller keeps what was written and skips stage B rather than
/// stacking a second issue for the same broken connection.
fn stage_a<F, C>(
    connection: &mut Connection,
    scan_id: i64,
    transport: &HashTransport,
    resolved: &mut Option<HashTransport>,
    scope: &str,
    cancel: &C,
    progress: &mut F,
) -> Result<bool, IndexError>
where
    F: FnMut(FinalizationProgress),
    C: Fn() -> bool + Sync,
{
    let candidates = {
        let mut statement = connection.prepare(
            "SELECT id, path, size
             FROM files
             WHERE deleted_at IS NULL
               AND (sample_hash IS NULL OR hash_state < 2 OR hash_algorithm IS NULL OR hash_algorithm NOT LIKE 'remote-sha256-%')
               AND size IN (
                 SELECT size FROM files
                 WHERE deleted_at IS NULL AND size > 0
                 GROUP BY size
                 HAVING COUNT(*) > 1
               )",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(Candidate {
                id: row.get(0)?,
                path: row.get(1)?,
                size: row.get::<_, i64>(2)? as u64,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    let total = candidates.len() as u64;
    progress_stage(progress, SAMPLING_STAGE, 0, total);
    if candidates.is_empty() {
        return Ok(false);
    }
    if cancel() {
        return Ok(false);
    }
    let transport = match resolved_transport(transport, resolved, cancel) {
        Ok(ready) => ready,
        Err(message) => {
            // A probe the user cancelled is not something to report.
            if cancel() {
                return Ok(false);
            }
            insert_scan_issue(connection, scan_id, "hash", scope, &message)?;
            return Ok(true);
        }
    };

    let mut done = 0_u64;
    let mut unanswered = 0_u64;
    let mut start = 0_usize;
    while start < candidates.len() {
        if cancel() {
            return Ok(false);
        }
        let mut end = start;
        let mut requests = Vec::new();
        while end < candidates.len() && requests.len() < REQUEST_BATCH {
            let candidate = &candidates[end];
            requests.extend(stage_a_requests(candidate.id, candidate.size, &candidate.path));
            end += 1;
        }

        let responses = match run_requests(transport, requests, cancel) {
            Ok(responses) => responses,
            Err(message) => {
                record_transport_failure(connection, scan_id, scope, &message)?;
                return Ok(true);
            }
        };
        let mut by_key = index_by_key(responses);

        let tx = connection.transaction()?;
        for candidate in &candidates[start..end] {
            if cancel() {
                break;
            }
            if !apply_stage_a(&tx, scan_id, candidate, &mut by_key)? {
                unanswered += 1;
            }
            done += 1;
            emit_counted_progress(progress, SAMPLING_STAGE, done, total);
        }
        tx.commit()?;
        start = end;
    }
    record_unanswered(connection, scan_id, scope, unanswered, cancel)?;
    // No closing progress_stage: emit_counted_progress already fires on the last
    // applied file, and a cancelled stage must not report a total it never reached.
    Ok(false)
}

/// A helper that answers nothing, or answers with records this side cannot
/// parse, would otherwise leave zero hashes, zero issues and zero signal. One
/// summary row per stage says so without one row per file.
fn record_unanswered<C>(
    connection: &Connection,
    scan_id: i64,
    scope: &str,
    unanswered: u64,
    cancel: &C,
) -> Result<(), IndexError>
where
    C: Fn() -> bool + Sync,
{
    if unanswered == 0 || cancel() {
        return Ok(());
    }
    insert_scan_issue(
        connection,
        scan_id,
        "hash",
        scope,
        &format!("remote hashing returned no result for {unanswered} files"),
    )
}

/// `false` means the helper told this side nothing usable about the file — no
/// hash written and no per-file issue recorded — which the stage counts and
/// summarises rather than swallowing.
fn apply_stage_a(
    tx: &Connection,
    scan_id: i64,
    candidate: &Candidate,
    by_key: &mut HashMap<(i64, Kind), Response>,
) -> Result<bool, IndexError> {
    if xxh3::sample_chunk_plan(candidate.size).is_empty() {
        match by_key.remove(&(candidate.id, Kind::Full)) {
            Some(Response::Ok { hex, .. }) => {
                tx.execute(
                    "UPDATE files
                     SET partial_hash = ?1, sample_hash = ?1, full_hash = ?1,
                         hash_algorithm = ?2, hash_state = 4
                     WHERE id = ?3",
                    params![hex, FULL_TAG, candidate.id],
                )?;
            }
            Some(Response::Err { message, .. }) => {
                insert_scan_issue(tx, scan_id, "hash", &candidate.path, &message)?;
            }
            None => return Ok(false),
        }
        return Ok(true);
    }

    let partial = by_key.remove(&(candidate.id, Kind::Partial));
    let sample = by_key.remove(&(candidate.id, Kind::Sample));
    match (partial, sample) {
        // Both halves have to land: a row with one of them is a hash the
        // grouping query cannot trust.
        (Some(Response::Ok { hex: partial, .. }), Some(Response::Ok { hex: sample, .. })) => {
            tx.execute(
                "UPDATE files
                 SET partial_hash = ?1, sample_hash = ?2, full_hash = NULL,
                     hash_algorithm = ?3, hash_state = 2
                 WHERE id = ?4",
                params![partial, sample, SAMPLE_TAG, candidate.id],
            )?;
        }
        (partial, sample) => {
            match [partial, sample]
                .into_iter()
                .flatten()
                .find_map(|response| match response {
                    Response::Err { message, .. } => Some(message),
                    Response::Ok { .. } => None,
                }) {
                Some(message) => {
                    insert_scan_issue(tx, scan_id, "hash", &candidate.path, &message)?;
                }
                // One half arrived and it was fine, or neither did: nothing was
                // written and nothing explains why.
                None => return Ok(false),
            }
        }
    }
    Ok(true)
}

/// Promote sampled matches to verified. A per-file failure here is not an issue:
/// the file keeps its sample hash and stays in duplicate detection at sampled
/// confidence, exactly as the local hasher treats it.
fn stage_b<F, C>(
    connection: &mut Connection,
    scan_id: i64,
    transport: &HashTransport,
    resolved: &mut Option<HashTransport>,
    scope: &str,
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
            Ok(Candidate {
                id: row.get(0)?,
                path: row.get(1)?,
                size: row.get::<_, i64>(2)? as u64,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    let total = candidates.len() as u64;
    progress_stage(progress, FULL_STAGE, 0, total);
    if candidates.is_empty() {
        return Ok(());
    }
    if cancel() {
        return Ok(());
    }
    let transport = match resolved_transport(transport, resolved, cancel) {
        Ok(ready) => ready,
        Err(message) => {
            if cancel() {
                return Ok(());
            }
            insert_scan_issue(connection, scan_id, "hash", scope, &message)?;
            return Ok(());
        }
    };

    let mut done = 0_u64;
    let mut unanswered = 0_u64;
    for batch in candidates.chunks(REQUEST_BATCH) {
        if cancel() {
            return Ok(());
        }
        let requests = batch
            .iter()
            .map(|candidate| Request {
                key: format!("{}:f", candidate.id),
                size: candidate.size,
                spec: Spec::Full,
                path: candidate.path.clone(),
            })
            .collect();

        let responses = match run_requests(transport, requests, cancel) {
            Ok(responses) => responses,
            Err(message) => {
                record_transport_failure(connection, scan_id, scope, &message)?;
                return Ok(());
            }
        };
        let mut by_key = index_by_key(responses);

        let tx = connection.transaction()?;
        for candidate in batch {
            if cancel() {
                break;
            }
            match by_key.remove(&(candidate.id, Kind::Full)) {
                Some(Response::Ok { hex, .. }) => {
                    tx.execute(
                        "UPDATE files SET full_hash = ?1, hash_algorithm = ?2, hash_state = 4 WHERE id = ?3",
                        params![hex, FULL_TAG, candidate.id],
                    )?;
                }
                // A per-file failure is expected and harmless here — the file
                // keeps its sample hash. Silence is not.
                Some(Response::Err { .. }) => {}
                None => unanswered += 1,
            }
            done += 1;
            emit_counted_progress(progress, FULL_STAGE, done, total);
        }
        tx.commit()?;
    }
    record_unanswered(connection, scan_id, scope, unanswered, cancel)?;
    Ok(())
}

/// Responses arrive in whatever order the helper finished them, and a key it
/// echoed back garbled is not a key: those records are dropped, which leaves the
/// file unhashed and eligible again on the next scan.
fn index_by_key(responses: Vec<Response>) -> HashMap<(i64, Kind), Response> {
    responses
        .into_iter()
        .filter_map(|response| parse_key(response.key()).map(|key| (key, response)))
        .collect()
}

fn record_transport_failure(
    connection: &Connection,
    scan_id: i64,
    scope: &str,
    message: &str,
) -> Result<(), IndexError> {
    insert_scan_issue(
        connection,
        scan_id,
        "hash",
        scope,
        &format!("remote hashing stopped: {message}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::writer::IndexWriter;
    use crate::scanner::SshSource;
    use rusqlite::params;

    // ---- pure protocol ----

    #[test]
    fn request_line_puts_path_last_and_encodes_spec() {
        let r = Request {
            key: "42:s".into(),
            size: 3_000_000,
            spec: Spec::Chunks(vec![(0, 65536), (2_934_464, 65536)]),
            path: "/srv/we\tird".into(),
        };
        assert_eq!(
            r.encode(),
            "42:s\t3000000\t0:65536,2934464:65536\t/srv/we\tird\0".as_bytes()
        );
        let f = Request {
            key: "7:f".into(),
            size: 12,
            spec: Spec::Full,
            path: "/a".into(),
        };
        assert_eq!(f.encode(), b"7:f\t12\tfull\t/a\0");
    }

    #[test]
    fn parses_success_and_error_responses() {
        let hex = "ab".repeat(32);
        let mut ok_record = b"42:s\t".to_vec();
        ok_record.extend_from_slice(hex.as_bytes());
        assert_eq!(
            parse_response(&ok_record).unwrap(),
            Response::Ok {
                key: "42:s".into(),
                hex: hex.clone()
            }
        );
        assert_eq!(
            parse_response(b"42:s\tERR\tPermission denied").unwrap(),
            Response::Err {
                key: "42:s".into(),
                message: "Permission denied".into()
            }
        );
        assert!(parse_response(b"garbage").is_none());
        assert!(parse_response(b"42:s\tnot-hex-64").is_none());
        // uppercase hex is not the contract either — 64 lowercase hex chars only
        let mut upper = b"42:s\t".to_vec();
        upper.extend_from_slice("AB".repeat(32).as_bytes());
        assert!(parse_response(&upper).is_none());
    }

    #[test]
    fn key_roundtrip() {
        assert_eq!(parse_key("42:s"), Some((42, Kind::Sample)));
        assert_eq!(parse_key("7:f"), Some((7, Kind::Full)));
        assert_eq!(parse_key("7:p"), Some((7, Kind::Partial)));
        assert_eq!(parse_key("x:p"), None);
    }

    #[test]
    fn stage_a_requests_follow_local_plan() {
        let small = stage_a_requests(1, 1024, "/s");
        assert_eq!(small.len(), 1);
        assert_eq!(small[0].key, "1:f");
        assert_eq!(small[0].spec, Spec::Full);

        let big = stage_a_requests(2, 3 * 1024 * 1024, "/b");
        assert_eq!(big.len(), 2);
        assert_eq!(big[0].key, "2:p");
        assert_eq!(
            big[0].spec,
            Spec::Chunks(vec![(0, 65536), (3 * 1024 * 1024 - 65536, 65536)])
        );
        assert_eq!(big[1].key, "2:s");
        assert_eq!(
            big[1].spec,
            Spec::Chunks(crate::index::algorithms::xxh3::sample_chunk_plan(
                3 * 1024 * 1024
            ))
        );
    }

    #[test]
    fn probe_command_and_helper_commands_are_stable() {
        assert_eq!(
            PROBE_COMMAND,
            "command -v python3 >/dev/null 2>&1 && echo python3 || { command -v perl >/dev/null 2>&1 && echo perl || echo none; }"
        );
        let py = helper_command(RemoteExecutor::Python3);
        assert!(py.starts_with("python3 -c \"import base64,sys;exec(base64.b64decode('"));
        assert!(!py.contains('\n'));
        assert!(py.ends_with("'))\""));
        let pl = helper_command(RemoteExecutor::Perl);
        assert!(pl.starts_with("perl -MMIME::Base64 -e 'eval decode_base64(shift); die $@ if $@' "));
        assert!(!pl.contains('\n'));

        // the base64 the two commands carry has to be real base64, not a lookalike
        assert_eq!(base64_std(""), "");
        assert_eq!(base64_std("f"), "Zg==");
        assert_eq!(base64_std("fo"), "Zm8=");
        assert_eq!(base64_std("foo"), "Zm9v");
        assert_eq!(base64_std("foobar"), "Zm9vYmFy");

        // helper sources travel base64'd inside a command line: ASCII only, no CR
        assert!(PYTHON_HELPER.is_ascii(), "python helper must be ASCII-only");
        assert!(PERL_HELPER.is_ascii(), "perl helper must be ASCII-only");
        assert!(!PYTHON_HELPER.contains('\r'), "python helper must use LF");
        assert!(!PERL_HELPER.contains('\r'), "perl helper must use LF");
    }

    #[test]
    fn from_source_json_roundtrips_and_rejects_other_types() {
        let s = SshSource {
            destination: "a@h".into(),
            port: Some(2222),
            root: "/d".into(),
        };
        assert_eq!(SshSource::from_source_json(&s.to_source_json()), Some(s));
        let no_port = SshSource {
            destination: "a@h".into(),
            port: None,
            root: "/d".into(),
        };
        assert_eq!(
            SshSource::from_source_json(&no_port.to_source_json()),
            Some(no_port)
        );
        assert_eq!(
            SshSource::from_source_json(r#"{"type":"s3","bucket":"x"}"#),
            None
        );
        assert_eq!(SshSource::from_source_json("local"), None);
    }

    // ---- stream driver ----

    #[test]
    fn stream_driver_surfaces_ok_and_err_records_in_order() {
        let mut responses = b"1:f\t".to_vec();
        responses.extend_from_slice("cd".repeat(32).as_bytes());
        responses.push(0);
        responses.extend_from_slice(b"2:f\tERR\tgone\0");

        let mut seen = Vec::new();
        let outcome = drive_stream(
            &responses[..],
            std::io::sink(),
            vec![
                Request {
                    key: "1:f".into(),
                    size: 1,
                    spec: Spec::Full,
                    path: "/a".into(),
                },
                Request {
                    key: "2:f".into(),
                    size: 1,
                    spec: Spec::Full,
                    path: "/b".into(),
                },
            ],
            &|| false,
            |r| seen.push(r),
        );
        assert_eq!(outcome, StreamOutcome::Completed);
        assert_eq!(seen.len(), 2);
        assert!(matches!(seen[0], Response::Ok { .. }));
        assert!(matches!(seen[1], Response::Err { .. }));
    }

    #[test]
    fn stream_driver_stops_on_cancel() {
        let mut responses = b"1:f\t".to_vec();
        responses.extend_from_slice("cd".repeat(32).as_bytes());
        responses.push(0);
        let outcome = drive_stream(&responses[..], std::io::sink(), vec![], &|| true, |_| {});
        assert_eq!(outcome, StreamOutcome::Cancelled);
    }

    #[test]
    fn stream_driver_writes_every_request_to_the_child() {
        // the requests the child sees are the wire bytes, in order, NUL-framed
        let sink = SharedSink::default();
        let outcome = drive_stream(
            &b""[..],
            sink.clone(),
            vec![
                Request {
                    key: "1:f".into(),
                    size: 3,
                    spec: Spec::Full,
                    path: "/a".into(),
                },
                Request {
                    key: "2:s".into(),
                    size: 9,
                    spec: Spec::Chunks(vec![(0, 4)]),
                    path: "/b".into(),
                },
            ],
            &|| false,
            |_| {},
        );
        assert_eq!(outcome, StreamOutcome::Completed);
        assert_eq!(sink.take(), b"1:f\t3\tfull\t/a\x002:s\t9\t0:4\t/b\x00".to_vec());
    }

    // ---- conformance: the real helper, run locally ----

    fn local_python() -> Option<String> {
        for p in ["python3", "python"] {
            if std::process::Command::new(p)
                .arg("--version")
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
            {
                return Some(p.into());
            }
        }
        None
    }

    fn python_transport(program: String) -> HashTransport {
        HashTransport::Local {
            program,
            args: vec![
                "-c".into(),
                format!(
                    "import base64,sys;exec(base64.b64decode('{}'))",
                    base64_std(PYTHON_HELPER)
                ),
            ],
        }
    }

    #[test]
    fn python_helper_full_digest_matches_known_vector() {
        let Some(py) = local_python() else {
            eprintln!("SKIP: no python");
            return;
        };
        let dir = tempdir("helper-vector");
        let p = dir.join("abc.txt");
        std::fs::write(&p, b"abc").unwrap();
        let transport = HashTransport::Local {
            program: py,
            args: vec![
                "-c".into(),
                format!(
                    "import base64,sys;exec(base64.b64decode('{}'))",
                    base64_std(PYTHON_HELPER)
                ),
            ],
        };
        let out = run_requests(
            &transport,
            vec![Request {
                key: "1:f".into(),
                size: 3,
                spec: Spec::Full,
                path: p.to_string_lossy().into(),
            }],
            &|| false,
        )
        .unwrap();
        assert_eq!(
            out[0],
            Response::Ok {
                key: "1:f".into(),
                hex: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".into()
            }
        );
    }

    #[test]
    fn python_helper_chunked_digest_is_framed_and_deterministic() {
        let Some(py) = local_python() else {
            eprintln!("SKIP: no python");
            return;
        };
        let transport = python_transport(py);
        let dir = tempdir("helper-chunked");
        let size = 3 * 1024 * 1024usize;
        let mut a = vec![7_u8; size];
        let mut b = vec![7_u8; size];
        // diverge only inside the middle chunk of the 3-point plan, so head+tail
        // ('p') must agree while the sample ('s') must not
        let plan = crate::index::algorithms::xxh3::sample_chunk_plan(size as u64);
        assert_eq!(plan.len(), 3, "3 MiB uses head+middle+tail");
        let middle = plan[1].0 as usize;
        a[middle] = 1;
        b[middle] = 2;
        let pa = dir.join("a.bin");
        let pb = dir.join("b.bin");
        std::fs::write(&pa, &a).unwrap();
        std::fs::write(&pb, &b).unwrap();

        let mut requests = stage_a_requests(1, size as u64, &pa.to_string_lossy());
        requests.extend(stage_a_requests(2, size as u64, &pb.to_string_lossy()));
        let first = run_requests(&transport, requests.clone(), &|| false).unwrap();
        let hexes = |out: &[Response]| -> std::collections::HashMap<String, String> {
            out.iter()
                .map(|r| match r {
                    Response::Ok { key, hex } => (key.clone(), hex.clone()),
                    Response::Err { key, message } => {
                        panic!("unexpected error for {key}: {message}")
                    }
                })
                .collect()
        };
        let h = hexes(&first);
        assert_eq!(h.len(), 4);
        assert_eq!(h["1:p"], h["2:p"], "head+tail are identical in both files");
        assert_ne!(h["1:s"], h["2:s"], "the middle chunk diverges");
        assert_eq!(h["1:p"].len(), 64);

        let second = hexes(&run_requests(&transport, requests, &|| false).unwrap());
        assert_eq!(h, second, "the same request must produce the same digest");
    }

    #[test]
    fn python_helper_answers_a_batch_larger_than_the_pipe_buffer() {
        // The batch a real scan sends is megabytes of requests — far past any OS
        // pipe buffer. Writing them from the caller's thread would deadlock
        // against a child that is answering as it reads, so this is the one
        // failure this module has to keep proving it cannot have.
        let Some(py) = local_python() else {
            eprintln!("SKIP: no python");
            return;
        };
        let transport = python_transport(py);
        let dir = tempdir("helper-backpressure");
        let path = dir.join("abc.txt");
        std::fs::write(&path, b"abc").unwrap();
        let path = path.to_string_lossy().into_owned();

        let requests: Vec<Request> = (1..=2000)
            .map(|id| Request {
                key: format!("{id}:f"),
                size: 3,
                spec: Spec::Full,
                path: path.clone(),
            })
            .collect();
        assert!(
            requests.iter().map(|r| r.encode().len()).sum::<usize>() > 128 * 1024,
            "the batch has to outgrow a pipe buffer to be worth running"
        );

        let out = run_requests(&transport, requests, &|| false).unwrap();
        assert_eq!(out.len(), 2000, "every request comes back exactly once");
        let vector = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assert!(out
            .iter()
            .all(|r| matches!(r, Response::Ok { hex, .. } if hex == vector)));
        let keys: std::collections::HashSet<&str> = out.iter().map(|r| r.key()).collect();
        assert_eq!(keys.len(), 2000, "no response is dropped or duplicated");
    }

    #[test]
    fn python_helper_reports_missing_file_as_err() {
        let Some(py) = local_python() else {
            eprintln!("SKIP: no python");
            return;
        };
        let transport = python_transport(py);
        let dir = tempdir("helper-missing");
        let missing = dir.join("not-here.bin");
        let out = run_requests(
            &transport,
            vec![
                Request {
                    key: "9:f".into(),
                    size: 10,
                    spec: Spec::Full,
                    path: missing.to_string_lossy().into(),
                },
                Request {
                    key: "9:s".into(),
                    size: 10,
                    spec: Spec::Chunks(vec![(0, 4)]),
                    path: missing.to_string_lossy().into(),
                },
            ],
            &|| false,
        )
        .unwrap();
        assert_eq!(out.len(), 2, "a per-file failure never kills the stream");
        for (index, key) in ["9:f", "9:s"].iter().enumerate() {
            match &out[index] {
                Response::Err { key: got, message } => {
                    assert_eq!(got, key, "the key must survive a failure");
                    assert!(!message.is_empty());
                    assert!(!message.contains('\n'), "messages stay single-line");
                }
                other => panic!("expected an error response, got {other:?}"),
            }
        }
    }

    // ---- stages against a real index ----

    #[test]
    fn stage_a_and_b_write_expected_columns() {
        let Some(py) = local_python() else {
            eprintln!("SKIP: no python");
            return;
        };
        let dir = tempdir("stages");
        let small = vec![3_u8; 1024];
        let big = vec![9_u8; 2 * 1024 * 1024];
        let unique = vec![5_u8; 777];
        let files = [
            ("a1.bin", &small),
            ("a2.bin", &small),
            ("b1.bin", &big),
            ("b2.bin", &big),
            ("u.bin", &unique),
        ];
        let paths: Vec<String> = files
            .iter()
            .map(|(name, bytes)| {
                let path = dir.join(name);
                std::fs::write(&path, bytes.as_slice()).unwrap();
                path.to_string_lossy().into_owned()
            })
            .collect();

        let db = dir.join("index.sqlite");
        let scan_id = seed_index(&db, &dir.to_string_lossy(), &paths, &files);

        let mut connection = crate::index::open_index_connection(&db).unwrap();
        let mut progress_messages: Vec<String> = Vec::new();
        update_hashes_with_transport(
            &mut connection,
            scan_id,
            &python_transport(py),
            &|| false,
            &mut |p: crate::index::writer::FinalizationProgress| progress_messages.push(p.message),
        )
        .expect("remote hashing");

        let row = |path: &str| -> (Option<String>, Option<String>, Option<String>, Option<String>, i64) {
            connection
                .query_row(
                    "SELECT partial_hash, sample_hash, full_hash, hash_algorithm, hash_state
                     FROM files WHERE path = ?1",
                    params![path],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
                )
                .expect("read file row")
        };

        for path in &paths[0..2] {
            let (partial, sample, full, algorithm, state) = row(path);
            assert_eq!(state, 4, "small files are fully hashed in stage A");
            assert_eq!(algorithm.as_deref(), Some(FULL_TAG));
            assert!(partial.is_some());
            assert_eq!(partial, sample);
            assert_eq!(partial, full);
            assert_eq!(partial.as_deref().map(str::len), Some(64));
        }
        assert_eq!(row(&paths[0]).0, row(&paths[1]).0, "identical files match");

        for path in &paths[2..4] {
            let (partial, sample, full, algorithm, state) = row(path);
            assert_eq!(state, 4, "stage B promotes the sampled pair");
            assert_eq!(algorithm.as_deref(), Some(FULL_TAG));
            assert!(partial.is_some() && sample.is_some() && full.is_some());
            assert_ne!(partial, sample, "head+tail is not the 3-point sample");
        }
        assert_eq!(row(&paths[2]), row(&paths[3]), "identical files match");

        let (partial, sample, full, algorithm, state) = row(&paths[4]);
        assert_eq!(
            (partial, sample, full, algorithm, state),
            (None, None, None, None, 0),
            "a size-unique file is never a duplicate candidate"
        );

        let issues: i64 = connection
            .query_row("SELECT COUNT(*) FROM scan_issues", [], |r| r.get(0))
            .unwrap();
        assert_eq!(issues, 0, "a clean run records no issues");

        assert!(progress_messages
            .iter()
            .any(|m| m == "Sampling duplicate candidates"));
        assert!(progress_messages
            .iter()
            .any(|m| m == "Full hashing strong matches"));

        drop(connection);
        let mut writer = IndexWriter::open(&db).expect("reopen index");
        writer
            .rebuild_duplicate_size_groups()
            .expect("rebuild duplicate groups");
        let groups: i64 = writer
            .connection()
            .query_row("SELECT COUNT(*) FROM duplicate_groups", [], |r| r.get(0))
            .unwrap();
        assert_eq!(groups, 2, "one group per identical pair");
    }

    #[test]
    fn child_failure_records_one_issue_and_keeps_written_hashes() {
        let Some(py) = local_python() else {
            eprintln!("SKIP: no python");
            return;
        };
        let dir = tempdir("child-failure");
        let small = vec![3_u8; 1024];
        let files = [("a1.bin", &small), ("a2.bin", &small)];
        let paths: Vec<String> = files
            .iter()
            .map(|(name, bytes)| {
                let path = dir.join(name);
                std::fs::write(&path, bytes.as_slice()).unwrap();
                path.to_string_lossy().into_owned()
            })
            .collect();
        let db = dir.join("index.sqlite");
        let scan_id = seed_index(&db, &dir.to_string_lossy(), &paths, &files);

        let mut connection = crate::index::open_index_connection(&db).unwrap();
        let broken = HashTransport::Local {
            program: py,
            args: vec!["-c".into(), "import sys; sys.exit(1)".into()],
        };
        update_hashes_with_transport(
            &mut connection,
            scan_id,
            &broken,
            &|| false,
            &mut |_: crate::index::writer::FinalizationProgress| {},
        )
        .expect("a transport failure never errors out of refinement");

        let issues: Vec<(String, String)> = {
            let mut statement = connection
                .prepare("SELECT phase, message FROM scan_issues")
                .unwrap();
            let rows = statement
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap();
            rows.collect::<Result<Vec<_>, _>>().unwrap()
        };
        assert_eq!(issues.len(), 1, "one issue for the whole stopped stage");
        assert_eq!(issues[0].0, "hash");
        assert!(
            issues[0].1.contains("remote hashing stopped"),
            "unexpected message: {}",
            issues[0].1
        );

        let hashed: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM files WHERE partial_hash IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hashed, 0, "nothing was hashed, and nothing was destroyed");
    }

    #[test]
    fn transport_failure_keeps_the_hashes_stage_a_already_wrote() {
        // The headline guarantee: a connection that dies partway through leaves
        // every hash already committed exactly where it was. Stage A is allowed
        // to finish, stage B's spawn is not — a marker file in the temp dir
        // makes the same program succeed once and then fail.
        let Some(py) = local_python() else {
            eprintln!("SKIP: no python");
            return;
        };
        let dir = tempdir("stage-b-failure");
        let sampled = vec![4_u8; 512 * 1024]; // > SMALL_MAX, so stage A samples it
        let files = [("s1.bin", &sampled), ("s2.bin", &sampled)];
        let paths: Vec<String> = files
            .iter()
            .map(|(name, bytes)| {
                let path = dir.join(name);
                std::fs::write(&path, bytes.as_slice()).unwrap();
                path.to_string_lossy().into_owned()
            })
            .collect();
        let db = dir.join("index.sqlite");
        let scan_id = seed_index(&db, &dir.to_string_lossy(), &paths, &files);

        let marker = dir.join("spawned").to_string_lossy().into_owned();
        let once = HashTransport::Local {
            program: py,
            args: vec![
                "-c".into(),
                format!(
                    "import base64,os,sys\n\
                     if os.path.exists(r'{marker}'): sys.exit(1)\n\
                     open(r'{marker}','w').close()\n\
                     exec(base64.b64decode('{helper}'))",
                    marker = marker,
                    helper = base64_std(PYTHON_HELPER)
                ),
            ],
        };

        let mut connection = crate::index::open_index_connection(&db).unwrap();
        update_hashes_with_transport(
            &mut connection,
            scan_id,
            &once,
            &|| false,
            &mut |_: crate::index::writer::FinalizationProgress| {},
        )
        .expect("a transport failure never errors out of refinement");

        let issues: Vec<String> = {
            let mut statement = connection
                .prepare("SELECT message FROM scan_issues WHERE phase = 'hash'")
                .unwrap();
            let rows = statement.query_map([], |r| r.get(0)).unwrap();
            rows.collect::<Result<Vec<_>, _>>().unwrap()
        };
        assert_eq!(issues.len(), 1, "one issue for the one stage that stopped");
        assert!(
            issues[0].contains("remote hashing stopped"),
            "unexpected message: {}",
            issues[0]
        );

        for path in &paths {
            let (partial, sample, full, algorithm, state): (
                Option<String>,
                Option<String>,
                Option<String>,
                Option<String>,
                i64,
            ) = connection
                .query_row(
                    "SELECT partial_hash, sample_hash, full_hash, hash_algorithm, hash_state
                     FROM files WHERE path = ?1",
                    params![path],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
                )
                .unwrap();
            assert!(partial.is_some(), "stage A's hash survived the failure");
            assert!(sample.is_some(), "stage A's hash survived the failure");
            assert_eq!(full, None, "stage B never got to run");
            assert_eq!(algorithm.as_deref(), Some(SAMPLE_TAG));
            assert_eq!(state, 2, "the pair stays at sampled confidence");
        }
    }

    #[test]
    fn unanswered_requests_are_summarised_in_one_issue() {
        // A helper that answers with records this side cannot use is the quiet
        // failure: no hashes, and without this, no issues either. The canned
        // stream below covers both drop paths — a key that does not parse, and
        // a digest that is not 64 lowercase hex — plus a request never answered.
        let Some(py) = local_python() else {
            eprintln!("SKIP: no python");
            return;
        };
        let dir = tempdir("unanswered");
        let small = vec![6_u8; 1024];
        let files = [("a1.bin", &small), ("a2.bin", &small)];
        let paths: Vec<String> = files
            .iter()
            .map(|(name, bytes)| {
                let path = dir.join(name);
                std::fs::write(&path, bytes.as_slice()).unwrap();
                path.to_string_lossy().into_owned()
            })
            .collect();
        let db = dir.join("index.sqlite");
        let scan_id = seed_index(&db, &dir.to_string_lossy(), &paths, &files);

        let babbling = HashTransport::Local {
            program: py,
            args: vec![
                "-c".into(),
                // exits 0, so this is not a transport failure — just nonsense
                r"import sys; sys.stdin.buffer.read(); sys.stdout.buffer.write(b'x:p\t' + b'a'*64 + b'\0' + b'1:f\tnot-hex\0')".into(),
            ],
        };

        let mut connection = crate::index::open_index_connection(&db).unwrap();
        update_hashes_with_transport(
            &mut connection,
            scan_id,
            &babbling,
            &|| false,
            &mut |_: crate::index::writer::FinalizationProgress| {},
        )
        .expect("nonsense from the helper is not an error");

        let issues: Vec<String> = {
            let mut statement = connection
                .prepare("SELECT message FROM scan_issues WHERE phase = 'hash'")
                .unwrap();
            let rows = statement.query_map([], |r| r.get(0)).unwrap();
            rows.collect::<Result<Vec<_>, _>>().unwrap()
        };
        assert_eq!(issues.len(), 1, "one summary row, not one row per file");
        assert_eq!(
            issues[0], "remote hashing returned no result for 2 files",
            "the count has to be the real number of unanswered candidates"
        );

        let hashed: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM files WHERE partial_hash IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hashed, 0, "nothing unusable was ever written");
    }

    // ---- helpers ----

    fn tempdir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir()
            .join("birdseye-remote-sha256-tests")
            .join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    /// A migrated index holding one scan session, one folder and the given files.
    fn seed_index(
        db: &std::path::Path,
        root: &str,
        paths: &[String],
        files: &[(&str, &Vec<u8>)],
    ) -> i64 {
        let writer = IndexWriter::open(db).expect("open index");
        let connection = writer.connection();
        connection
            .execute(
                "INSERT INTO scan_sessions (id, root_path, started_at, status)
                 VALUES (1, ?1, 0, 'running')",
                params![root],
            )
            .expect("seed session");
        connection
            .execute(
                "INSERT INTO folders (id, path, name, depth, indexed_at) VALUES (1, ?1, 'r', 0, 0)",
                params![root],
            )
            .expect("seed folder");
        for (path, (name, bytes)) in paths.iter().zip(files.iter()) {
            connection
                .execute(
                    "INSERT INTO files (folder_id, path, name, size, indexed_at)
                     VALUES (1, ?1, ?2, ?3, 0)",
                    params![path, name, bytes.len() as i64],
                )
                .expect("seed file");
        }
        drop(writer);
        1
    }

    /// A `Write` the test can read back after the driver's thread has dropped it.
    #[derive(Clone, Default)]
    struct SharedSink(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    impl SharedSink {
        fn take(&self) -> Vec<u8> {
            self.0.lock().unwrap().clone()
        }
    }

    impl std::io::Write for SharedSink {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
}
