use super::types::{FileRecord, FolderRecord, ScanError, ScanEvent, ScanReport, ScanStats};
use super::worker::ScanController;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Records between progress snapshots — the remote stream has no queue to poll, so
/// progress rides along with the parse loop.
const PROGRESS_EVERY: u64 = 5_000;

/// Longest unparseable record we echo back into a scan issue.
const MAX_ISSUE_CHARS: usize = 200;

/// An ssh destination and the remote directory to catalog under it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SshSource {
    /// "user@host" or an ~/.ssh/config alias.
    pub destination: String,
    #[serde(default)]
    pub port: Option<u16>,
    /// Absolute POSIX path on the remote.
    pub root: String,
}

impl SshSource {
    pub fn display_label(&self) -> String {
        match self.port {
            Some(port) => format!("{}:{port}:{}", self.destination, self.root),
            None => format!("{}:{}", self.destination, self.root),
        }
    }

    pub fn to_source_json(&self) -> String {
        serde_json::json!({
            "type": "ssh",
            "destination": self.destination,
            "port": self.port,
            "root": self.root,
        })
        .to_string()
    }
}

/// Scans a remote directory over the system ssh client. Emits the same event stream as
/// the local [`super::Scanner`], so the rest of the pipeline cannot tell them apart.
#[derive(Debug)]
pub struct RemoteScanner {
    source: SshSource,
    controller: ScanController,
}

impl RemoteScanner {
    pub fn new(source: SshSource) -> Self {
        Self {
            source,
            controller: ScanController::new(),
        }
    }

    pub fn controller(&self) -> ScanController {
        self.controller.clone()
    }

    pub fn scan(self) -> Receiver<ScanEvent> {
        let (events_tx, events_rx) = mpsc::channel();
        let source = self.source;
        let controller = self.controller;

        thread::spawn(move || {
            run_remote_scan(source, controller, events_tx);
        });

        events_rx
    }
}

fn run_remote_scan(source: SshSource, controller: ScanController, events_tx: Sender<ScanEvent>) {
    let root = normalized_root(&source.root).to_owned();
    let started_at = Instant::now();

    let mut child = match Command::new("ssh")
        .args(ssh_args(&source))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            // Started first: consumers open their session on it, and an issue without a
            // session has nowhere to land.
            let _ = events_tx.send(ScanEvent::Started {
                root: PathBuf::from(&root),
                workers: 1,
            });
            let _ = events_tx.send(ScanEvent::Error(ScanError {
                path: PathBuf::from(&root),
                message: format!("failed to run ssh — is the OpenSSH client installed? ({error})"),
            }));
            let _ = events_tx.send(ScanEvent::Finished(ScanReport {
                root: PathBuf::from(&root),
                stats: ScanStats::empty(),
                started_at,
                finished_at: Instant::now(),
                cancelled: false,
            }));
            return;
        }
    };

    // ssh's own diagnostics (auth failures) and find's per-directory complaints both arrive
    // here; drain them on a thread so a full stderr pipe cannot stall stdout.
    let stderr_drain = child.stderr.take().map(|stderr| {
        let events_tx = events_tx.clone();
        let root = root.clone();
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if line.trim().is_empty() {
                    continue;
                }
                let _ = events_tx.send(ScanEvent::Error(ScanError {
                    path: PathBuf::from(&root),
                    message: line,
                }));
            }
        })
    });

    let stdout = child.stdout.take().expect("ssh stdout is piped");
    // ponytail: cancel is checked per-record; a fully idle network read blocks until the
    // child dies with the app — add a watchdog kill if that ever bites.
    let (terminal, files_scanned) = read_stream(stdout, &events_tx, &controller, &root);

    let completed = matches!(terminal, ScanEvent::Finished(_));
    if !completed {
        let _ = child.kill();
    }
    let status = child.wait();
    // Join before the terminal event: consumers stop reading there, so every stderr line
    // has to be in the channel already.
    if let Some(drain) = stderr_drain {
        let _ = drain.join();
    }

    // find exits non-zero for any unreadable subdirectory, so only a run that produced
    // nothing at all is worth reporting as a failure of its own.
    if completed && files_scanned == 0 {
        if let Ok(status) = status {
            if !status.success() {
                let _ = events_tx.send(ScanEvent::Error(ScanError {
                    path: PathBuf::from(&root),
                    message: format!("ssh exited with {status} without listing any files"),
                }));
            }
        }
    }

    let _ = events_tx.send(terminal);
}

pub(crate) enum Entry {
    File {
        path: String,
        size: u64,
        modified: f64,
        accessed: f64,
        created: f64,
    },
    Dir {
        path: String,
    },
}

/// One tab-separated record: y, size, mtime, atime, ctime, path (path may contain tabs).
pub(crate) fn parse_record(line: &str) -> Option<Entry> {
    let mut parts = line.splitn(6, '\t');
    let kind = parts.next()?;
    let size: u64 = parts.next()?.parse().ok()?;
    let modified: f64 = parts.next()?.parse().ok()?;
    let accessed: f64 = parts.next()?.parse().ok()?;
    let created: f64 = parts.next()?.parse().ok()?;
    let path = parts.next()?.to_owned();
    if path.is_empty() {
        return None;
    }
    match kind {
        "f" => Some(Entry::File {
            path,
            size,
            modified,
            accessed,
            created,
        }),
        "d" => Some(Entry::Dir { path }),
        _ => None, // symlinks, sockets, devices — the local walker skips them too
    }
}

/// Remote paths are POSIX strings: a `\` is a legal byte in a Linux filename, so name and
/// parent come from `'/'` splits rather than `std::path::Path`, which would mangle them
/// on Windows.
pub(crate) fn to_file_record(
    path: &str,
    size: u64,
    modified: f64,
    accessed: f64,
    created: f64,
) -> FileRecord {
    let name = file_name_of(path);

    FileRecord {
        path: PathBuf::from(path),
        parent: PathBuf::from(parent_of(path)),
        extension: name
            .rsplit_once('.')
            .filter(|(stem, _)| !stem.is_empty())
            .map(|(_, extension)| extension.to_ascii_lowercase())
            .filter(|extension| !extension.is_empty()),
        name: name.to_owned(),
        size,
        modified: to_system_time(modified),
        accessed: to_system_time(accessed),
        created: to_system_time(created),
    }
}

fn file_name_of(path: &str) -> &str {
    path.rsplit_once('/').map_or(path, |(_, name)| name)
}

fn parent_of(path: &str) -> &str {
    match path.rsplit_once('/') {
        Some(("", _)) | None => "/",
        Some((parent, _)) => parent,
    }
}

/// Epoch seconds from `find -printf %T@`. Anything negative, NaN, or beyond the clock's
/// range has no `SystemTime` — the remote decides these bytes, so they cannot panic us.
fn to_system_time(seconds: f64) -> Option<SystemTime> {
    Duration::try_from_secs_f64(seconds)
        .ok()
        .and_then(|since_epoch| UNIX_EPOCH.checked_add(since_epoch))
}

/// Parse one `find -printf` stream into scan events. Returns the terminal event
/// (`Finished` only when the whole stream was read) and the file count *without sending
/// it*: consumers stop at the terminal event, so the caller has to get its own failure
/// reports into the channel ahead of it.
fn read_stream<R: Read>(
    reader: R,
    events_tx: &Sender<ScanEvent>,
    controller: &ScanController,
    root: &str,
) -> (ScanEvent, u64) {
    let started_at = Instant::now();
    let _ = events_tx.send(ScanEvent::Started {
        root: PathBuf::from(root),
        workers: 1,
    });

    let mut reader = BufReader::new(reader);
    let mut folders: HashMap<String, (u64, u64)> = HashMap::new();
    let mut buffer = Vec::new();
    let mut records: u64 = 0;
    let mut stats = ScanStats {
        active_workers: 1,
        ..ScanStats::empty()
    };

    loop {
        if controller.is_cancelled() {
            return (
                ScanEvent::Cancelled(with_rates(&stats, started_at)),
                stats.files_scanned,
            );
        }

        buffer.clear();
        match reader.read_until(b'\0', &mut buffer) {
            Ok(0) => break,
            Ok(_) => {}
            Err(error) => {
                // A connection that drops mid-tree leaves a partial listing. Report it the
                // way a cancel is reported, never as a complete catalog.
                let _ = events_tx.send(ScanEvent::Error(ScanError {
                    path: PathBuf::from(root),
                    message: error.to_string(),
                }));
                return (
                    ScanEvent::Cancelled(with_rates(&stats, started_at)),
                    stats.files_scanned,
                );
            }
        }

        if buffer.last() == Some(&b'\0') {
            buffer.pop();
        }
        if buffer.is_empty() {
            continue;
        }

        records += 1;
        let line = String::from_utf8_lossy(&buffer);

        match parse_record(&line) {
            Some(Entry::File {
                path,
                size,
                modified,
                accessed,
                created,
            }) => {
                let record = to_file_record(&path, size, modified, accessed, created);
                let folder = folders.entry(parent_of(&path).to_owned()).or_insert((0, 0));
                folder.0 += 1;
                folder.1 += size;
                stats.files_scanned += 1;
                stats.bytes_scanned += size;
                stats.folders_scanned = folders.len() as u64;
                stats.current_path = Some(PathBuf::from(path));
                let _ = events_tx.send(ScanEvent::FileIndexed(record));
            }
            Some(Entry::Dir { path }) => {
                folders.entry(path.clone()).or_insert((0, 0));
                stats.folders_scanned = folders.len() as u64;
                stats.current_path = Some(PathBuf::from(path));
            }
            None => {
                stats.inaccessible_entries += 1;
                let _ = events_tx.send(ScanEvent::Error(ScanError {
                    path: PathBuf::from(root),
                    message: format!(
                        "unparseable find record: {}",
                        line.chars().take(MAX_ISSUE_CHARS).collect::<String>()
                    ),
                }));
            }
        }

        if records.is_multiple_of(PROGRESS_EVERY) {
            let _ = events_tx.send(ScanEvent::Progress(with_rates(&stats, started_at)));
        }
    }

    let _ = events_tx.send(ScanEvent::Progress(with_rates(&stats, started_at)));

    // Folder totals are only whole once the stream ends — find walks a directory's children
    // across the whole listing, not in one block.
    for (path, (direct_files, direct_bytes)) in folders {
        let _ = events_tx.send(ScanEvent::FolderIndexed(FolderRecord {
            path: PathBuf::from(path),
            direct_files,
            direct_bytes,
        }));
    }

    (
        ScanEvent::Finished(ScanReport {
            root: PathBuf::from(root),
            stats: with_rates(&stats, started_at),
            started_at,
            finished_at: Instant::now(),
            cancelled: false,
        }),
        stats.files_scanned,
    )
}

/// Stream in, events out, terminal event included — the shape the parser tests drive.
/// Production holds the terminal event back until the child's exit status is known.
#[cfg(test)]
fn scan_stream<R: Read>(
    reader: R,
    events_tx: &Sender<ScanEvent>,
    controller: &ScanController,
    root: &str,
) -> (bool, u64) {
    let (terminal, files_scanned) = read_stream(reader, events_tx, controller, root);
    let completed = matches!(terminal, ScanEvent::Finished(_));
    let _ = events_tx.send(terminal);
    (completed, files_scanned)
}

fn with_rates(stats: &ScanStats, started_at: Instant) -> ScanStats {
    let elapsed = started_at.elapsed();
    let seconds = elapsed.as_secs_f64().max(0.001);

    ScanStats {
        elapsed,
        files_per_sec: stats.files_scanned as f64 / seconds,
        bytes_per_sec: stats.bytes_scanned as f64 / seconds,
        ..stats.clone()
    }
}

pub(crate) fn sh_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// `find` echoes the root exactly as given, so `/srv/` would list the root folder as
/// "/srv/" while every file under it reports a parent of "/srv" — two rows for one folder.
/// The filesystem root is the one trailing slash that has to stay.
fn normalized_root(root: &str) -> &str {
    let trimmed = root.trim_end_matches('/');
    if trimmed.is_empty() {
        "/"
    } else {
        trimmed
    }
}

pub(crate) fn ssh_args(source: &SshSource) -> Vec<String> {
    // BatchMode: never sit at a password prompt. ConnectTimeout: a black-holed host has to
    // fail rather than park the scan thread in a read that no cancel can reach.
    let mut args = vec![
        "-o".to_owned(),
        "BatchMode=yes".to_owned(),
        "-o".to_owned(),
        "ConnectTimeout=10".to_owned(),
    ];

    if let Some(port) = source.port {
        args.push("-p".to_owned());
        args.push(port.to_string());
    }

    // Everything after "--" is the destination and the remote command, so a hostile
    // destination cannot smuggle in ssh options.
    args.push("--".to_owned());
    args.push(source.destination.clone());
    // No -type filter: the parser drops non-f/d records, which keeps `\(` out of the
    // remote command line.
    args.push(format!(
        r"find {} -printf '%y\t%s\t%T@\t%A@\t%C@\t%p\0'",
        sh_quote(normalized_root(&source.root))
    ));

    args
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(line: &str) -> Option<Entry> {
        parse_record(line)
    }

    #[test]
    fn parses_file_record() {
        let e = record("f\t2048\t1755600000.5\t1755600001.0\t1755600002.0\t/srv/data/report.PDF")
            .unwrap();
        match e {
            Entry::File { path, size, .. } => {
                assert_eq!(path, "/srv/data/report.PDF");
                assert_eq!(size, 2048);
            }
            _ => panic!("expected file"),
        }
    }

    #[test]
    fn parses_directory_record() {
        assert!(matches!(
            record("d\t4096\t1.0\t1.0\t1.0\t/srv/data").unwrap(),
            Entry::Dir { .. }
        ));
    }

    #[test]
    fn skips_symlinks_and_specials() {
        assert!(record("l\t9\t1.0\t1.0\t1.0\t/srv/link").is_none());
        assert!(record("s\t0\t1.0\t1.0\t1.0\t/run/sock").is_none());
    }

    #[test]
    fn path_may_contain_tabs() {
        let e = record("f\t10\t1.0\t1.0\t1.0\t/srv/we\tird name").unwrap();
        match e {
            Entry::File { path, .. } => assert_eq!(path, "/srv/we\tird name"),
            _ => panic!(),
        }
    }

    #[test]
    fn malformed_record_is_none() {
        assert!(record("f\t10\t1.0").is_none());
        assert!(record("").is_none());
        assert!(record("f\tnot-a-number\t1.0\t1.0\t1.0\t/x").is_none());
    }

    #[test]
    fn file_record_derives_name_parent_extension() {
        // to_file_record maps Entry::File -> FileRecord
        let r = to_file_record("/srv/data/Photo.JPG", 5, 1.0, 1.0, 1.0);
        assert_eq!(r.name, "Photo.JPG");
        assert_eq!(r.parent, std::path::PathBuf::from("/srv/data"));
        assert_eq!(r.extension.as_deref(), Some("jpg"));
        // dotfile: no extension, matching the local scanner's Path::extension semantics
        let dot = to_file_record("/home/u/.bashrc", 1, 1.0, 1.0, 1.0);
        assert_eq!(dot.extension, None);
    }

    #[test]
    fn stream_aggregates_folders_and_emits_finished() {
        let input = b"d\t4096\t1.0\t1.0\t1.0\t/srv\0\
d\t4096\t1.0\t1.0\t1.0\t/srv/sub\0\
f\t100\t1.0\t1.0\t1.0\t/srv/a.txt\0\
f\t200\t1.0\t1.0\t1.0\t/srv/sub/b.txt\0";
        let (tx, rx) = std::sync::mpsc::channel();
        scan_stream(&input[..], &tx, &ScanController::new(), "/srv");
        let events: Vec<ScanEvent> = rx.try_iter().collect();
        let files: Vec<_> = events
            .iter()
            .filter(|e| matches!(e, ScanEvent::FileIndexed(_)))
            .collect();
        assert_eq!(files.len(), 2);
        let folders: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                ScanEvent::FolderIndexed(f) => Some(f),
                _ => None,
            })
            .collect();
        assert_eq!(folders.len(), 2);
        let srv = folders
            .iter()
            .find(|f| f.path == std::path::PathBuf::from("/srv"))
            .unwrap();
        assert_eq!((srv.direct_files, srv.direct_bytes), (1, 100));
        assert!(matches!(events.last().unwrap(), ScanEvent::Finished(_)));
    }

    #[test]
    fn stream_stops_when_cancelled() {
        let controller = ScanController::new();
        controller.cancel();
        let (tx, rx) = std::sync::mpsc::channel();
        scan_stream(&b"f\t1\t1.0\t1.0\t1.0\t/x\0"[..], &tx, &controller, "/");
        let events: Vec<ScanEvent> = rx.try_iter().collect();
        assert!(matches!(events.last().unwrap(), ScanEvent::Cancelled(_)));
    }

    #[test]
    fn unparseable_record_reports_an_issue() {
        let (tx, rx) = std::sync::mpsc::channel();
        scan_stream(
            &b"nonsense\0f\t7\t1.0\t1.0\t1.0\t/srv/a.txt\0"[..],
            &tx,
            &ScanController::new(),
            "/srv",
        );
        let events: Vec<ScanEvent> = rx.try_iter().collect();
        let errors: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                ScanEvent::Error(error) => Some(error),
                _ => None,
            })
            .collect();
        assert_eq!(errors.len(), 1);
        assert!(errors[0].message.contains("nonsense"));
        // the good record after it still lands
        assert_eq!(
            events
                .iter()
                .filter(|e| matches!(e, ScanEvent::FileIndexed(_)))
                .count(),
            1
        );
    }

    #[test]
    fn shell_quotes_remote_root() {
        assert_eq!(sh_quote("/srv/data"), "'/srv/data'");
        assert_eq!(sh_quote("/srv/it's"), r"'/srv/it'\''s'");
    }

    #[test]
    fn builds_ssh_args() {
        let s = SshSource {
            destination: "anubhav@localhost".into(),
            port: Some(2222),
            root: "/home/anubhav".into(),
        };
        let args = ssh_args(&s);
        assert_eq!(args[0], "-o");
        assert_eq!(args[1], "BatchMode=yes");
        assert_eq!(args[2], "-o");
        assert_eq!(args[3], "ConnectTimeout=10");
        assert!(args.contains(&"-p".to_string()) && args.contains(&"2222".to_string()));
        // destination comes after "--" so a hostile destination can't inject options
        let dd = args.iter().position(|a| a == "--").unwrap();
        assert_eq!(args[dd + 1], "anubhav@localhost");
        let remote_cmd = args.last().unwrap();
        assert!(remote_cmd.starts_with("find '/home/anubhav'"));
        assert!(remote_cmd.contains(r"-printf '%y\t%s\t%T@\t%A@\t%C@\t%p\0'"));

        // a trailing slash would make find print the root as "/home/anubhav/" while every
        // file under it reports "/home/anubhav" as its parent — two rows for one folder
        let slashed = SshSource {
            root: "/home/anubhav/".into(),
            ..s
        };
        assert!(ssh_args(&slashed)
            .last()
            .unwrap()
            .starts_with("find '/home/anubhav' "));

        let filesystem_root = SshSource {
            root: "/".into(),
            ..slashed
        };
        assert!(ssh_args(&filesystem_root)
            .last()
            .unwrap()
            .starts_with("find '/' "));
    }

    #[test]
    fn hostile_timestamps_have_no_system_time() {
        assert!(to_system_time(-1.0).is_none() && to_system_time(1e300).is_none());
    }

    #[test]
    fn read_stream_holds_back_the_terminal_event() {
        let (tx, rx) = std::sync::mpsc::channel();
        let (terminal, files) = read_stream(
            &b"f\t100\t1.0\t1.0\t1.0\t/srv/a.txt\0"[..],
            &tx,
            &ScanController::new(),
            "/srv",
        );
        assert!(matches!(terminal, ScanEvent::Finished(_)));
        assert_eq!(files, 1);
        // the caller still has failure reports to send, so nothing terminal may be queued yet
        let events: Vec<ScanEvent> = rx.try_iter().collect();
        assert!(!events
            .iter()
            .any(|e| matches!(e, ScanEvent::Finished(_) | ScanEvent::Cancelled(_))));
    }

    #[test]
    fn mid_stream_read_error_is_not_a_complete_scan() {
        /// Hands over one good record, then fails the way a dropped connection does.
        struct DroppedConnection(bool);

        impl std::io::Read for DroppedConnection {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                if self.0 {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::BrokenPipe,
                        "connection reset by peer",
                    ));
                }
                self.0 = true;
                let record = b"f\t100\t1.0\t1.0\t1.0\t/srv/a.txt\0";
                buf[..record.len()].copy_from_slice(record);
                Ok(record.len())
            }
        }

        let (tx, rx) = std::sync::mpsc::channel();
        let (completed, files) = scan_stream(
            DroppedConnection(false),
            &tx,
            &ScanController::new(),
            "/srv",
        );
        assert!(!completed, "a half-read tree is not a completed scan");
        assert_eq!(files, 1);
        let events: Vec<ScanEvent> = rx.try_iter().collect();
        assert!(matches!(events.last().unwrap(), ScanEvent::Cancelled(_)));
        assert!(events.iter().any(|e| matches!(
            e,
            ScanEvent::Error(error) if error.message.contains("connection reset")
        )));
    }

    #[test]
    fn source_json_and_label() {
        let s = SshSource {
            destination: "a@h".into(),
            port: None,
            root: "/d".into(),
        };
        assert_eq!(s.display_label(), "a@h:/d");
        let json: serde_json::Value = serde_json::from_str(&s.to_source_json()).unwrap();
        assert_eq!(json["type"], "ssh");
        // the tagged json is what gets stored, so it has to read back as the same source
        assert_eq!(
            serde_json::from_str::<SshSource>(&s.to_source_json()).unwrap(),
            s
        );

        let ported = SshSource {
            port: Some(2222),
            ..s
        };
        assert_eq!(ported.display_label(), "a@h:2222:/d");
    }
}
