use birds_eye::index::IndexWriter;
use birds_eye::scanner::{ScanEvent, ScanOptions, Scanner};
use std::env;
use std::path::PathBuf;

fn main() {
    let args = Args::parse();
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
                println!(
                    "finished files={} folders={} bytes={} elapsed_ms={}",
                    report.stats.files_scanned,
                    report.stats.folders_scanned,
                    report.stats.bytes_scanned,
                    report.stats.elapsed.as_millis()
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
            ScanEvent::FileIndexed(_) | ScanEvent::FolderIndexed(_) => {}
        }
    }
}

#[derive(Debug)]
struct Args {
    root: PathBuf,
    index_path: Option<PathBuf>,
}

impl Args {
    fn parse() -> Self {
        let mut root = None;
        let mut index_path = None;
        let mut args = env::args().skip(1);

        while let Some(arg) = args.next() {
            if arg == "--index" {
                index_path = args.next().map(PathBuf::from);
                continue;
            }

            if root.is_none() {
                root = Some(PathBuf::from(arg));
            }
        }

        Self {
            root: root.unwrap_or_else(|| env::current_dir().expect("failed to resolve current directory")),
            index_path,
        }
    }
}
