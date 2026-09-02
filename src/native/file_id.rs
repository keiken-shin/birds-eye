//! What the filesystem itself calls this object.
//!
//! A path is a name, not an identity. Two paths can name one object (hard
//! links), one path can name two objects at different moments (rename, replace,
//! delete-and-recreate), and every safety check that compares "is this still
//! the file I looked at?" by path plus size plus last-modified is comparing
//! descriptions rather than the thing itself.
//!
//! The filesystem has a real answer. On Windows it is the volume serial number
//! plus the file id: 64-bit on NTFS, 128-bit on ReFS, both reachable through the
//! same call. On Unix it is the device number plus the inode. This module
//! returns whichever the platform gives, in one shape.
//!
//! Nothing here reads file contents, and nothing here needs read permission:
//! the handle asks for no access at all, which is enough to be told what the
//! object is and works on files another program holds open for writing.

use std::path::Path;

/// The filesystem's own name for one object. Equality means "the same object",
/// with the caveat every filesystem shares: an id can be reused after the object
/// it named is deleted, so this answers "same object" and not "same contents".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ObjectId {
    /// Volume serial (Windows) or device number (Unix). Ids are only unique
    /// within one volume, so comparing ids across volumes is meaningless.
    pub volume: u64,
    /// File id (Windows) or inode (Unix), widened to 128 bits so ReFS fits.
    pub id: u128,
}

impl ObjectId {
    /// The form stored in the index: one text column, both halves, no loss.
    ///
    /// SQLite integers are 64-bit and a ReFS file id is 128, so a numeric column
    /// would have to either truncate the id or split it across two columns that
    /// nothing stops from disagreeing. Fixed-width hex sorts, compares and
    /// indexes exactly like the number it came from.
    pub fn key(&self) -> String {
        format!("{:016x}:{:032x}", self.volume, self.id)
    }

    /// `None` for anything not written by [`ObjectId::key`]. An unreadable
    /// stored id must never be silently treated as a match.
    pub fn from_key(key: &str) -> Option<Self> {
        let (volume, id) = key.split_once(':')?;
        Some(Self {
            volume: u64::from_str_radix(volume, 16).ok()?,
            id: u128::from_str_radix(id, 16).ok()?,
        })
    }
}

#[cfg(windows)]
pub fn object_id(path: &Path) -> std::io::Result<ObjectId> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FileIdInfo, GetFileInformationByHandle, GetFileInformationByHandleEx,
        BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS, FILE_ID_INFO, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();

    // Zero desired access is the point: it asks only "what is this", so a file
    // another program holds open, or one this process may not read, still
    // answers. FILE_FLAG_BACKUP_SEMANTICS lets the same call work on folders.
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error());
    }

    // FILE_ID_INFO first: it is the 128-bit id, so ReFS is not silently
    // truncated into collisions. NTFS answers it too and pads the top bits.
    let mut wide_info: FILE_ID_INFO = unsafe { std::mem::zeroed() };
    let wide_ok = unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileIdInfo,
            std::ptr::addr_of_mut!(wide_info).cast(),
            std::mem::size_of::<FILE_ID_INFO>() as u32,
        ) != 0
    };
    if wide_ok {
        unsafe { CloseHandle(handle) };
        return Ok(ObjectId {
            volume: wide_info.VolumeSerialNumber,
            id: u128::from_le_bytes(wide_info.FileId.Identifier),
        });
    }

    // Older filesystems (and some network redirectors) only offer the 64-bit
    // index. Narrower, still far better than a path.
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    let ok = unsafe { GetFileInformationByHandle(handle, &mut info) != 0 };
    let error = std::io::Error::last_os_error();
    unsafe { CloseHandle(handle) };
    if !ok {
        return Err(error);
    }
    Ok(ObjectId {
        volume: u64::from(info.dwVolumeSerialNumber),
        id: u128::from(u64::from(info.nFileIndexHigh) << 32 | u64::from(info.nFileIndexLow)),
    })
}

#[cfg(not(windows))]
pub fn object_id(path: &Path) -> std::io::Result<ObjectId> {
    use std::os::unix::fs::MetadataExt;
    // symlink_metadata, so a link is its own object rather than its target's.
    let meta = std::fs::symlink_metadata(path)?;
    Ok(ObjectId {
        volume: meta.dev(),
        id: u128::from(meta.ino()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("birdseye-file-id");
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    #[test]
    fn one_file_has_one_id_however_often_it_is_asked() {
        let path = temp("stable.bin");
        std::fs::write(&path, b"hello").unwrap();
        assert_eq!(object_id(&path).unwrap(), object_id(&path).unwrap());
    }

    /// The whole reason this exists: same path, same size, same content, and
    /// the filesystem still knows it is not the same object.
    #[test]
    fn a_replaced_file_is_a_different_object_at_the_same_path() {
        let path = temp("replaced.bin");
        std::fs::write(&path, b"hello").unwrap();
        let before = object_id(&path).unwrap();

        std::fs::remove_file(&path).unwrap();
        std::fs::write(&path, b"hello").unwrap();
        let after = object_id(&path).unwrap();

        assert_ne!(
            before, after,
            "a delete-and-recreate must not look like the original file"
        );
    }

    #[test]
    fn two_different_files_have_different_ids() {
        let a = temp("a.bin");
        let b = temp("b.bin");
        std::fs::write(&a, b"same bytes").unwrap();
        std::fs::write(&b, b"same bytes").unwrap();
        assert_ne!(object_id(&a).unwrap(), object_id(&b).unwrap());
    }

    #[test]
    fn a_key_survives_the_round_trip_through_the_index() {
        let id = ObjectId {
            volume: 0xDEAD_BEEF,
            id: 0x0123_4567_89AB_CDEF_0123_4567_89AB_CDEF,
        };
        assert_eq!(ObjectId::from_key(&id.key()), Some(id));
        assert_eq!(ObjectId::from_key("not an id"), None);
        assert_eq!(ObjectId::from_key(""), None);
    }

    #[test]
    fn a_missing_path_has_no_id() {
        assert!(object_id(&temp("nothing-here.bin")).is_err());
    }
}
