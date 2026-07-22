//! macOS Trash with a receipt: where did the item actually land?
//!
//! The `trash` crate calls `trashItemAtURL` with `resultingItemURL:nil`, which
//! throws away the one fact restore needs. macOS TCC forbids *enumerating*
//! `~/.Trash` without Full Disk Access, but moving an exact path you already
//! know back out is permitted — so the landed path captured here at delete
//! time is the only reliable, permission-free restore handle.
//!
//! Platform sibling of `lockinfo.rs`: the ontology cleanup layer stays free of
//! raw filesystem calls (invariant #1) and delegates the platform mechanics
//! to this module, the same way Windows/Linux delegate to the `trash` crate.

#![cfg(target_os = "macos")]

use objc::{
    class, msg_send,
    runtime::{Object, BOOL, NO},
    sel, sel_impl,
};
use std::path::{Path, PathBuf};

#[link(name = "Foundation", kind = "framework")]
extern "C" {}

#[allow(non_camel_case_types)]
type id = *mut Object;
#[allow(non_upper_case_globals)]
const nil: id = std::ptr::null_mut();
#[allow(non_upper_case_globals)]
const NSUTF8StringEncoding: usize = 4;

/// Move `path` to the Trash via `NSFileManager trashItemAtURL:resultingItemURL:`
/// and return the path the item landed at.
///
/// `Err` means the item was NOT trashed. `Ok(None)` means it WAS trashed but
/// macOS reported no landed path — the caller must still record the deletion
/// (log-first invariant: a trashed file may never lack a log trace); only the
/// restore receipt is missing.
pub fn trash_with_receipt(path: &Path) -> Result<Option<PathBuf>, String> {
    let path_str = path
        .to_str()
        .ok_or_else(|| format!("path is not valid UTF-8: {}", path.display()))?;

    unsafe {
        let ns_path = to_ns_string(path_str);
        let url: id = msg_send![class!(NSURL), fileURLWithPath: ns_path.ptr];
        if url == nil {
            return Err(format!("failed to build an NSURL for {path_str}"));
        }

        let file_manager: id = msg_send![class!(NSFileManager), defaultManager];
        let mut resulting_url: id = nil;
        let mut error: id = nil;
        let success: BOOL = msg_send![
            file_manager,
            trashItemAtURL: url
            resultingItemURL: (&mut resulting_url as *mut id)
            error: (&mut error as *mut id)
        ];

        if success == NO {
            if error == nil {
                return Err(format!("trashItemAtURL failed for {path_str} with no error"));
            }
            let code: isize = msg_send![error, code];
            let description: id = msg_send![error, localizedDescription];
            return Err(format!(
                "trashItemAtURL failed for {path_str} (code {code}): {}",
                ns_string_to_rust(description)
            ));
        }

        if resulting_url == nil {
            // Trashed, but macOS didn't say where. The delete succeeded, so this
            // is NOT an error — only the restore receipt is missing.
            return Ok(None);
        }
        let resulting_path: id = msg_send![resulting_url, path];
        let landed = ns_string_to_rust(resulting_path);
        if landed.is_empty() {
            return Ok(None);
        }
        Ok(Some(PathBuf::from(landed)))
    }
}

/// Move a trashed item back to its original location. `trashed_path` is the
/// exact receipt recorded at delete time; TCC allows operating on it even
/// without Full Disk Access. Refuses to clobber an existing file.
pub fn restore_by_receipt(trashed_path: &Path, original_path: &Path) -> Result<(), String> {
    if original_path.exists() {
        return Err(format!(
            "a file already exists at the original location {}",
            original_path.display()
        ));
    }
    if let Some(parent) = original_path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| {
                format!("failed to recreate parent directory {}: {e}", parent.display())
            })?;
        }
    }
    // The receipt and the original live on the same volume by construction
    // (macOS trashes to the volume's own Trash), so a rename suffices.
    std::fs::rename(trashed_path, original_path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => format!(
            "item is no longer in the Trash (was it emptied?): {}",
            trashed_path.display()
        ),
        std::io::ErrorKind::PermissionDenied => format!(
            "macOS denied access to the trashed item — grant the app Full Disk Access, \
             or drag it out of the Trash manually: {}",
            trashed_path.display()
        ),
        _ => format!(
            "failed to move {} back to {}: {e}",
            trashed_path.display(),
            original_path.display()
        ),
    })
}

/// Owns an NSString; releases it on drop.
#[repr(transparent)]
struct OwnedObject {
    ptr: id,
}
impl Drop for OwnedObject {
    fn drop(&mut self) {
        #[allow(clippy::let_unit_value)]
        {
            let () = unsafe { msg_send![self.ptr, release] };
        }
    }
}

fn to_ns_string(s: &str) -> OwnedObject {
    let bytes = s.as_bytes();
    unsafe {
        let alloced: id = msg_send![class!(NSString), alloc];
        let mut string: id = msg_send![
            alloced,
            initWithBytes: bytes.as_ptr()
            length: bytes.len()
            encoding: NSUTF8StringEncoding
        ];
        if string == nil {
            string = msg_send![alloced, init];
        }
        OwnedObject { ptr: string }
    }
}

/// Safety: `string` must be nil or a pointer to an NSString.
unsafe fn ns_string_to_rust(string: id) -> String {
    if string == nil {
        return String::new();
    }
    let bytes: *const u8 = msg_send![string, UTF8String];
    let len: usize = msg_send![string, lengthOfBytesUsingEncoding: NSUTF8StringEncoding];
    let slice = std::slice::from_raw_parts(bytes, len);
    String::from_utf8_lossy(slice).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("be-macos-trash-{name}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn restore_by_receipt_moves_the_file_back() {
        let dir = unique_dir("restore");
        let fake_trashed = dir.join("trashed.bin");
        let original = dir.join("nested").join("original.bin");
        fs::write(&fake_trashed, b"payload").unwrap();

        restore_by_receipt(&fake_trashed, &original).unwrap();

        assert!(!fake_trashed.exists());
        assert_eq!(fs::read(&original).unwrap(), b"payload");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn restore_by_receipt_refuses_to_clobber() {
        let dir = unique_dir("clobber");
        let fake_trashed = dir.join("trashed.bin");
        let original = dir.join("original.bin");
        fs::write(&fake_trashed, b"new").unwrap();
        fs::write(&original, b"existing").unwrap();

        let err = restore_by_receipt(&fake_trashed, &original).unwrap_err();
        assert!(err.contains("already exists"), "unexpected error: {err}");
        assert_eq!(fs::read(&original).unwrap(), b"existing");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn restore_by_receipt_reports_missing_trashed_item() {
        let dir = unique_dir("missing");
        let err = restore_by_receipt(&dir.join("gone.bin"), &dir.join("back.bin")).unwrap_err();
        assert!(err.contains("no longer in the Trash"), "unexpected error: {err}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn trash_with_receipt_round_trips_a_real_file() {
        let dir = unique_dir("real-trash");
        let victim = dir.join("victim.bin");
        fs::write(&victim, b"trash me").unwrap();

        let landed = match trash_with_receipt(&victim) {
            Ok(Some(landed)) => landed,
            Ok(None) => {
                eprintln!("skipping: trashed but no receipt reported");
                let _ = fs::remove_dir_all(&dir);
                return;
            }
            // Headless/CI environments may have no usable Trash; the executor
            // records this per-file rather than failing the plan.
            Err(e) => {
                eprintln!("skipping: trash unavailable here ({e})");
                let _ = fs::remove_dir_all(&dir);
                return;
            }
        };
        assert!(!victim.exists(), "victim must leave its original path");

        restore_by_receipt(&landed, &victim).unwrap();
        assert_eq!(fs::read(&victim).unwrap(), b"trash me");
        let _ = fs::remove_dir_all(&dir);
    }
}
