mod remote;
mod types;
mod worker;

pub use remote::{RemoteScanner, SshSource};
// The remote hasher reaches the same host the same way the scanner does.
pub(crate) use remote::ssh_prefix_args;
pub use types::{
    FileRecord, FolderRecord, ScanError, ScanEvent, ScanOptions, ScanReport, ScanStats,
};
pub use worker::{ScanController, Scanner};

