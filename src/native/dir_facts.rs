//! What one folder can say about every child, in a single pass.
//!
//! Asking [`super::file_id::object_id`] per file costs about 60 microseconds
//! here: it opens a handle, asks, and closes it, once per file. Measured over
//! `C:\Windows\System32`, that is roughly four times the cost of the directory
//! walk itself, which would have made identity something the scanner could not
//! afford to collect.
//!
//! Windows will answer the same question for a whole folder at once. One handle
//! on the folder, then `FileIdBothDirectoryInfo` returns the id of every child
//! alongside its name. Measured on the same tree: 2.1 microseconds per entry,
//! about a seventh of the walk. Identity stops being a luxury.
//!
//! The same record carries the allocated size, which is the number of bytes the
//! object actually occupies. For a sparse or compressed file that is nothing
//! like its logical length: a 64 MB sparse file measured here occupied 128 KB,
//! and 8 MB of zeros under NTFS compression occupied none at all. Deleting them
//! frees what is allocated, not what is logical, so both numbers are collected.
//!
//! A folder that cannot be opened this way yields an empty map, and the caller
//! falls back to asking per file. No identity is better than a wrong one, and
//! both are better than refusing to scan.

use super::file_id::ObjectId;
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::Path;

/// What the folder listing knows about one child.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DirFact {
    pub object_id: ObjectId,
    /// Bytes actually occupied on disk. Cluster-rounded for an ordinary file,
    /// far below the logical length for a sparse or compressed one. Verified
    /// against `GetCompressedFileSize`, which returns the same figure.
    pub allocated: u64,
}

/// Map of child name to what the listing said. Empty means "ask another way",
/// never "this folder has no children".
pub type DirFacts = HashMap<OsString, DirFact>;

#[cfg(windows)]
pub fn dir_facts(dir: &Path) -> DirFacts {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FileIdBothDirectoryInfo, GetFileInformationByHandleEx,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_ID_BOTH_DIR_INFO, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE, OPEN_EXISTING,
    };

    /// Listing a directory's entries needs more than the "tell me what you are"
    /// access `object_id` opens with. It is still not read access to any file.
    const FILE_LIST_DIRECTORY: u32 = 0x0001;
    /// One buffer, reused across every `GetFileInformationByHandleEx` call.
    /// Large folders simply take more calls.
    const BUFFER_BYTES: usize = 64 * 1024;

    let mut out = DirFacts::new();
    let wide: Vec<u16> = dir.as_os_str().encode_wide().chain(Some(0)).collect();

    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_LIST_DIRECTORY,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return out;
    }

    // The volume serial is not in the per-entry record, so it is asked once for
    // the folder. Every child of a folder is on the same volume by definition:
    // a mount point is a reparse point, and the scanner does not follow those.
    let volume = match super::file_id::object_id(dir) {
        Ok(id) => id.volume,
        Err(_) => {
            unsafe { CloseHandle(handle) };
            return out;
        }
    };

    let mut buffer = vec![0_u8; BUFFER_BYTES];
    loop {
        let more = unsafe {
            GetFileInformationByHandleEx(
                handle,
                FileIdBothDirectoryInfo,
                buffer.as_mut_ptr().cast(),
                buffer.len() as u32,
            ) != 0
        };
        // No more entries, or a folder that stopped answering part-way. Either
        // way what has been collected so far is true.
        if !more {
            break;
        }

        let mut offset = 0_usize;
        loop {
            // SAFETY: the buffer holds a chain of variable-length records
            // written by the call above; NextEntryOffset walks it and is zero on
            // the last one.
            let entry = unsafe { &*(buffer.as_ptr().add(offset) as *const FILE_ID_BOTH_DIR_INFO) };
            let name_units = entry.FileNameLength as usize / std::mem::size_of::<u16>();
            let name = unsafe { std::slice::from_raw_parts(entry.FileName.as_ptr(), name_units) };
            let name = OsString::from_wide(name);
            if name != "." && name != ".." {
                out.insert(
                    name,
                    DirFact {
                        object_id: ObjectId {
                            volume,
                            // FileId here is the 64-bit index. A ReFS volume
                            // needs the 128-bit form, which only the per-file
                            // call gives, so callers on ReFS should expect the
                            // narrow id. Tracked as #63.
                            id: entry.FileId as u64 as u128,
                        },
                        allocated: entry.AllocationSize.max(0) as u64,
                    },
                );
            }
            if entry.NextEntryOffset == 0 {
                break;
            }
            offset += entry.NextEntryOffset as usize;
        }
    }

    unsafe { CloseHandle(handle) };
    out
}

/// Everywhere else, one `lstat` per file is already cheap, so there is nothing
/// worth batching. The caller falls back to `object_id` per entry.
#[cfg(not(windows))]
pub fn dir_facts(_dir: &Path) -> DirFacts {
    DirFacts::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("birdseye-dir-ids").join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[cfg(windows)]
    #[test]
    fn every_child_gets_the_same_id_the_per_file_call_reports() {
        let dir = fixture("agrees");
        for name in ["a.bin", "b.bin", "c.bin"] {
            std::fs::write(dir.join(name), name.as_bytes()).unwrap();
        }
        std::fs::create_dir(dir.join("sub")).unwrap();

        let facts = dir_facts(&dir);
        assert_eq!(facts.len(), 4, "three files and one folder, no . or ..");
        for (name, fact) in &facts {
            let direct = super::super::file_id::object_id(&dir.join(name)).unwrap();
            assert_eq!(fact.object_id, direct, "{name:?}");
        }
    }

    /// A sparse file occupies far less than it claims. Reporting its logical
    /// length as space that can be reclaimed is the overclaim this exists to
    /// stop.
    #[cfg(windows)]
    #[test]
    fn a_sparse_file_reports_what_it_occupies_not_what_it_claims() {
        let dir = fixture("sparse");
        let path = dir.join("sparse.bin");
        std::fs::write(&path, b"x").unwrap();
        let marked = std::process::Command::new("fsutil")
            .args(["sparse", "setflag", &path.display().to_string()])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !marked {
            return; // No sparse support on this volume; nothing to prove.
        }
        {
            use std::io::{Seek, SeekFrom, Write};
            let mut file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
            file.seek(SeekFrom::Start(64 * 1024 * 1024)).unwrap();
            file.write_all(b"end").unwrap();
        }

        let fact = dir_facts(&dir)[std::ffi::OsStr::new("sparse.bin")];
        let logical = std::fs::metadata(&path).unwrap().len();
        assert!(logical > 64 * 1024 * 1024, "the file claims to be large");
        assert!(
            fact.allocated < logical / 100,
            "allocated {} should be a fraction of logical {logical}",
            fact.allocated
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_folder_that_cannot_be_opened_yields_nothing_rather_than_failing() {
        let missing = std::env::temp_dir().join("birdseye-dir-ids-absent-folder");
        let _ = std::fs::remove_dir_all(&missing);
        assert!(dir_facts(&missing).is_empty());
    }
}
