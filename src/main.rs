use birds_eye::index::IndexWriter;
use birds_eye::scanner::{RemoteScanner, ScanEvent, ScanOptions, Scanner, SshSource};
use std::env;
use std::path::PathBuf;
use std::sync::mpsc::Receiver;

fn main() {
    let args = Args::parse();

    if let Command::Query { index_path, limit } = &args.command {
        print_index_overview(index_path, *limit);
        return;
    }

    let mut index_writer = args
        .index_path
        .as_ref()
        .map(|path| IndexWriter::open(path).expect("failed to open sqlite index"));

    let events = if let Some(source) = &args.ssh {
        if let Some(writer) = index_writer.as_mut() {
            writer.set_source(&source.to_source_json());
        }
        RemoteScanner::new(source.clone()).scan()
    } else {
        Scanner::new(ScanOptions::new(args.root.clone())).scan()
    };

    run_scan(events, &mut index_writer, &args);
}

fn run_scan(events: Receiver<ScanEvent>, index_writer: &mut Option<IndexWriter>, args: &Args) {
    for event in events {
        if let Some(writer) = index_writer.as_mut() {
            writer.handle_event(&event).expect("failed to write index event");
        }

        match event {
            ScanEvent::Started { root, workers } => {
                println!("started root={} workers={}", root.display(), workers);
                if let Some(path) = &args.index_path {
                    println!("index path={}", path.display());
                }
            }
            ScanEvent::Progress(stats) => {
                println!(
                    "progress files={} folders={} bytes={} queue={} active={} files_per_sec={:.0}",
                    stats.files_scanned,
                    stats.folders_scanned,
                    stats.bytes_scanned,
                    stats.queue_depth,
                    stats.active_workers,
                    stats.files_per_sec
                );
            }
            ScanEvent::Finished(report) => {
                println!(
                    "finished files={} folders={} bytes={} elapsed_ms={}",
                    report.stats.files_scanned,
                    report.stats.folders_scanned,
                    report.stats.bytes_scanned,
                    report.stats.elapsed.as_millis()
                );
                if args.refine {
                    if let Some(writer) = index_writer.as_mut() {
                        println!("refining duplicates…");
                        writer.refine_duplicates().expect("failed to refine duplicates");
                        let groups = writer
                            .duplicate_groups(usize::MAX)
                            .expect("failed to query duplicate groups");
                        println!("duplicate groups={}", groups.len());
                    }
                }
                break;
            }
            ScanEvent::Cancelled(stats) => {
                println!(
                    "cancelled files={} folders={} bytes={}",
                    stats.files_scanned, stats.folders_scanned, stats.bytes_scanned
                );
                break;
            }
            ScanEvent::Error(error) => {
                eprintln!("error path={} message={}", error.path.display(), error.message);
            }
            ScanEvent::FileIndexed(_) | ScanEvent::FolderIndexed(_) | ScanEvent::Verbose { .. } => {}
        }
    }
}

#[derive(Debug)]
struct Args {
    command: Command,
    root: PathBuf,
    index_path: Option<PathBuf>,
    ssh: Option<SshSource>,
    refine: bool,
}

#[derive(Debug)]
enum Command {
    Scan,
    Query { index_path: PathBuf, limit: usize },
}

impl Args {
    fn parse() -> Self {
        Self::parse_from(env::args().skip(1))
    }

    /// `impl Iterator<Item = String>` (rather than reading `env::args()` directly) so tests
    /// can drive parsing without touching the process's real argv.
    fn parse_from(args: impl Iterator<Item = String>) -> Self {
        let mut args = args.peekable();

        if matches!(args.peek().map(String::as_str), Some("query")) {
            args.next();
            let index_path = args
                .next()
                .map(PathBuf::from)
                .expect("usage: birds-eye-scan query <index.sqlite> [limit]");
            let limit = args
                .next()
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(10);

            return Self {
                command: Command::Query { index_path, limit },
                root: env::current_dir().expect("failed to resolve current directory"),
                index_path: None,
                ssh: None,
                refine: false,
            };
        }

        let mut root: Option<String> = None;
        let mut index_path = None;
        let mut ssh_destination = None;
        let mut ssh_port = None;
        let mut refine = false;

        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--index" => index_path = args.next().map(PathBuf::from),
                "--ssh" => ssh_destination = args.next(),
                "--ssh-port" => {
                    ssh_port = Some(
                        args.next()
                            .expect("--ssh-port requires a value")
                            .parse::<u16>()
                            .expect("--ssh-port requires a number"),
                    );
                }
                "--refine" => refine = true,
                _ => {
                    if root.is_none() {
                        root = Some(arg);
                    }
                }
            }
        }

        if refine && index_path.is_none() {
            panic!("usage: --refine requires --index <path>");
        }

        // The remote root is a POSIX string, kept verbatim for `SshSource` — it never goes
        // through `PathBuf` parsing, only `PathBuf::from` for the *local* scan path below.
        let root = root.unwrap_or_else(|| {
            env::current_dir()
                .expect("failed to resolve current directory")
                .to_string_lossy()
                .into_owned()
        });

        let ssh = ssh_destination.map(|destination| SshSource {
            destination,
            port: ssh_port,
            root: root.clone(),
        });

        Self {
            command: Command::Scan,
            root: PathBuf::from(&root),
            index_path,
            ssh,
            refine,
        }
    }
}

fn print_index_overview(index_path: &PathBuf, limit: usize) {
    let writer = IndexWriter::open(index_path).expect("failed to open sqlite index");

    println!("largest folders");
    for folder in writer.largest_folders(limit).expect("failed to query folders") {
        println!(
            "  bytes={} files={} path={}",
            folder.total_bytes, folder.total_files, folder.path
        );
    }

    println!("largest files");
    for file in writer.largest_files(limit).expect("failed to query files") {
        println!(
            "  bytes={} kind={} path={}",
            file.size, file.media_kind, file.path
        );
    }

    println!("extensions");
    for extension in writer
        .extension_summaries(limit)
        .expect("failed to query extensions")
    {
        println!(
            "  bytes={} files={} extension={}",
            extension.total_bytes, extension.file_count, extension.extension
        );
    }

    println!("duplicate groups");
    for group in writer.duplicate_groups(limit).expect("failed to query duplicates") {
        println!(
            "  reclaimable={} files={} size={} confidence={:.2}",
            group.reclaimable_bytes, group.file_count, group.size, group.confidence
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Args {
        Args::parse_from(values.iter().map(|s| s.to_string()))
    }

    #[test]
    fn parses_ssh_flags_and_refine() {
        let a = args(&[
            "--ssh",
            "u@h",
            "--ssh-port",
            "2222",
            "--index",
            "x.sqlite",
            "--refine",
            "/srv",
        ]);
        assert_eq!(
            a.ssh,
            Some(SshSource {
                destination: "u@h".to_string(),
                port: Some(2222),
                root: "/srv".to_string(),
            })
        );
        assert!(a.refine);
        assert_eq!(a.index_path, Some(PathBuf::from("x.sqlite")));
    }

    #[test]
    fn plain_root_has_no_ssh_source() {
        let a = args(&["D:\\data"]);
        assert_eq!(a.ssh, None);
        assert!(!a.refine);
        assert_eq!(a.root, PathBuf::from("D:\\data"));
    }

    #[test]
    fn refine_without_index_is_an_error() {
        let result = std::panic::catch_unwind(|| args(&["--refine", "/srv"]));
        let err = result.expect_err("--refine without --index should fail");
        let message = err
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_default();
        assert!(message.contains("--index"), "message was: {message}");
    }
}
