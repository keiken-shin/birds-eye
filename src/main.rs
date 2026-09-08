use birds_eye::index::IndexWriter;
use birds_eye::scanner::{ScanEvent, ScanOptions, Scanner};
use std::env;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

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

    let scanner = Scanner::new(ScanOptions::new(args.root));
    let events = scanner.scan();

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
                // The walk only records what each file claims about itself.
                // Without this the index it just wrote answers "nothing here is
                // a copy of anything" to every question -- the same gap #67
                // closed in scan_to_index, and this binary is how the index
                // gets built by hand.
                if let Some(writer) = index_writer.as_mut() {
                    println!("refining duplicates...");
                    writer
                        .refine_duplicates()
                        .expect("failed to refine duplicates");
                }
                // Rates, not just totals. Issue #60: every scale claim on the
                // board was reasoned from reading the code, and a number nobody
                // prints is a number nobody can check.
                println!(
                    "finished files={} folders={} bytes={} unreadable={} elapsed_ms={} files_per_sec={:.0} bytes_per_sec={:.0}",
                    report.stats.files_scanned,
                    report.stats.folders_scanned,
                    report.stats.bytes_scanned,
                    report.stats.inaccessible_entries,
                    report.stats.elapsed.as_millis(),
                    report.stats.files_per_sec,
                    report.stats.bytes_per_sec
                );
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

    // The analysis phase lives in the app's job path, so its cost was never
    // measurable from a command line. Without that, "how long does Bird's Eye
    // take" could only ever be answered for the walk.
    if args.analyze {
        let Some(index_path) = args.index_path.as_ref() else {
            eprintln!("--analyze needs --index");
            std::process::exit(2);
        };
        drop(index_writer);
        let started = std::time::Instant::now();
        let ran = birds_eye::ontology::orchestrator::run_phase2(
            index_path,
            birds_eye::ontology::populators::BudgetTier::AllOptIn,
            Arc::new(AtomicBool::new(false)),
        )
        .expect("analysis failed");
        println!(
            "analyzed ran={ran} elapsed_ms={}",
            started.elapsed().as_millis()
        );
    }
}

#[derive(Debug)]
struct Args {
    command: Command,
    root: PathBuf,
    index_path: Option<PathBuf>,
    analyze: bool,
}

#[derive(Debug)]
enum Command {
    Scan,
    Query { index_path: PathBuf, limit: usize },
}

impl Args {
    fn parse() -> Self {
        let mut raw_args = env::args().skip(1);
        if matches!(raw_args.next().as_deref(), Some("query")) {
            let index_path = raw_args
                .next()
                .map(PathBuf::from)
                .expect("usage: birds-eye-scan query <index.sqlite> [limit]");
            let limit = raw_args
                .next()
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(10);

            return Self {
                command: Command::Query { index_path, limit },
                root: env::current_dir().expect("failed to resolve current directory"),
                index_path: None,
                analyze: false,
            };
        }

        let mut root = None;
        let mut index_path = None;
        let mut analyze = false;
        let mut args = env::args().skip(1);

        while let Some(arg) = args.next() {
            if arg == "--index" {
                index_path = args.next().map(PathBuf::from);
                continue;
            }

            if arg == "--analyze" {
                analyze = true;
                continue;
            }

            if root.is_none() {
                root = Some(PathBuf::from(arg));
            }
        }

        Self {
            command: Command::Scan,
            root: root.unwrap_or_else(|| env::current_dir().expect("failed to resolve current directory")),
            index_path,
            analyze,
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
