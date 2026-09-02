//! Object ids for every child of one folder, in one pass.
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
//! A folder that cannot be opened this way yields an empty map, and the caller
//! falls back to asking per file. No identity is better than a wrong one, and
//! both are better than refusing to scan.

use super::file_id::ObjectId;
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::Path;

/// Map of child name to object id. Empty means "ask another way", never
/// "this folder has no children".
pub type DirIds = HashMap<OsString, ObjectId>;

#[cfg(windows)]
pub fn dir_ids(dir: &Path) -> DirIds {
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

    let mut out = DirIds::new();
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
                    ObjectId {
                        volume,
                        // FileId here is the 64-bit index. A ReFS volume needs
                        // the 128-bit form, which only the per-file call gives,
                        // so callers on ReFS should expect the narrow id.
                        id: entry.FileId as u64 as u128,
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
pub fn dir_ids(_dir: &Path) -> DirIds {
    DirIds::new()
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

        let ids = dir_ids(&dir);
        assert_eq!(ids.len(), 4, "three files and one folder, no . or ..");
        for (name, id) in &ids {
            let direct = super::super::file_id::object_id(&dir.join(name)).unwrap();
            assert_eq!(*id, direct, "{name:?}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_folder_that_cannot_be_opened_yields_nothing_rather_than_failing() {
        let missing = std::env::temp_dir().join("birdseye-dir-ids-absent-folder");
        let _ = std::fs::remove_dir_all(&missing);
        assert!(dir_ids(&missing).is_empty());
    }
}
