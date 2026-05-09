use birds_eye::scanner::{ScanEvent, ScanOptions, Scanner};
use std::env;
use std::path::PathBuf;

fn main() {
    let root = env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| env::current_dir().expect("failed to resolve current directory"));

    let scanner = Scanner::new(ScanOptions::new(root));
    let events = scanner.scan();

    for event in events {
        match event {
            ScanEvent::Started { root, workers } => {
                println!("started root={} workers={}", root.display(), workers);
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

