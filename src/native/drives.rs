//! Enumerates the machine's fixed drives for the first-run drive picker:
//! root path, volume label, and capacity. Mirrors `lockinfo.rs`'s shape —
//! raw Win32 FFI (`GetLogicalDriveStringsW` + `GetDriveTypeW` +
//! `GetDiskFreeSpaceExW` + `GetVolumeInformationW`) behind a
//! `#[cfg(windows)]` / `#[cfg(not(windows))]` split, so the crate keeps
//! compiling on non-Windows dev/CI machines.

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DriveInfoDto {
    pub root_path: String,
    pub volume_label: Option<String>,
    /// `None` when the volume's capacity couldn't be read — an unformatted,
    /// BitLocker-locked, or empty-card-reader volume still enumerates and
    /// still reports `DRIVE_FIXED`, but `GetDiskFreeSpaceExW` fails on it.
    /// The drive stays in the list rather than vanishing.
    pub total_bytes: Option<u64>,
    pub free_bytes: Option<u64>,
    pub drive_type: String,
}

/// `GetDriveTypeW`'s `DRIVE_FIXED` value, duplicated as a plain constant
/// (rather than pulled from `windows_sys`) so the filtering logic below
/// compiles without the `windows-sys` crate, which is a Windows-only
/// dependency (see `[target.'cfg(windows)'.dependencies]` in Cargo.toml).
#[cfg(any(windows, test))]
const DRIVE_TYPE_FIXED: u32 = 3;

#[cfg(any(windows, test))]
struct VolumeDetails {
    total_bytes: u64,
    free_bytes: u64,
    volume_label: Option<String>,
}

/// Seam for testing: the real Win32 calls and a fake both implement this, so
/// the filtering/mapping logic below can be exercised without a real disk.
#[cfg(any(windows, test))]
trait DriveSource {
    fn roots(&self) -> Vec<String>;
    fn drive_type(&self, root: &str) -> u32;
    /// `None` when the volume can't be read — distinct from "readable but
    /// reports zero bytes".
    fn volume_details(&self, root: &str) -> Option<VolumeDetails>;
}

#[cfg(any(windows, test))]
fn drive_type_label(raw: u32) -> &'static str {
    match raw {
        2 => "removable",
        3 => "fixed",
        4 => "remote",
        5 => "cdrom",
        6 => "ramdisk",
        _ => "unknown",
    }
}

/// Splits the double-null-terminated buffer `GetLogicalDriveStringsW` fills
/// into individual root paths (`"C:\\"`, `"D:\\"`, ...).
#[cfg(any(windows, test))]
fn parse_drive_strings(buf: &[u16]) -> Vec<String> {
    buf.split(|&c| c == 0)
        .filter(|s| !s.is_empty())
        .map(String::from_utf16_lossy)
        .collect()
}

/// Fixed drives only (`DRIVE_FIXED`) — a CD-ROM or a mapped network share
/// isn't the first-run scan target. One unreadable drive never drops the
/// rest of the list; it comes back with capacity left `None`.
#[cfg(any(windows, test))]
fn collect_fixed_drives(source: &impl DriveSource) -> Vec<DriveInfoDto> {
    source
        .roots()
        .into_iter()
        .filter(|root| source.drive_type(root) == DRIVE_TYPE_FIXED)
        .map(|root| {
            let details = source.volume_details(&root);
            DriveInfoDto {
                root_path: root,
                volume_label: details.as_ref().and_then(|d| d.volume_label.clone()),
                total_bytes: details.as_ref().map(|d| d.total_bytes),
                free_bytes: details.as_ref().map(|d| d.free_bytes),
                drive_type: drive_type_label(DRIVE_TYPE_FIXED).to_owned(),
            }
        })
        .collect()
}

#[cfg(windows)]
mod windows_source {
    use super::{DriveSource, VolumeDetails};
    use windows_sys::Win32::Storage::FileSystem::{
        GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDriveStringsW, GetVolumeInformationW,
    };

    pub struct WindowsDriveSource;

    fn to_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    impl DriveSource for WindowsDriveSource {
        fn roots(&self) -> Vec<String> {
            // 26 possible drive letters * 4 chars ("X:\\\0") + a final null
            // is 105 u16 at most; 512 leaves generous headroom.
            let mut buf = [0u16; 512];
            let len = unsafe { GetLogicalDriveStringsW(buf.len() as u32, buf.as_mut_ptr()) };
            let len = (len as usize).min(buf.len());
            super::parse_drive_strings(&buf[..len])
        }

        fn drive_type(&self, root: &str) -> u32 {
            let wide = to_wide(root);
            unsafe { GetDriveTypeW(wide.as_ptr()) }
        }

        fn volume_details(&self, root: &str) -> Option<VolumeDetails> {
            let wide = to_wide(root);
            let mut free_available = 0u64;
            let mut total_bytes = 0u64;
            let mut total_free = 0u64;
            let ok = unsafe {
                GetDiskFreeSpaceExW(
                    wide.as_ptr(),
                    &mut free_available,
                    &mut total_bytes,
                    &mut total_free,
                )
            };
            if ok == 0 {
                // Unformatted, BitLocker-locked, or an empty card reader that
                // still reports DRIVE_FIXED — don't take the drive out of the
                // list, just leave its capacity unknown.
                return None;
            }

            let mut label_buf = [0u16; 261]; // MAX_PATH + 1
            let label_ok = unsafe {
                GetVolumeInformationW(
                    wide.as_ptr(),
                    label_buf.as_mut_ptr(),
                    label_buf.len() as u32,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    0,
                )
            };
            let volume_label = (label_ok != 0)
                .then(|| {
                    let end = label_buf.iter().position(|&c| c == 0).unwrap_or(0);
                    String::from_utf16_lossy(&label_buf[..end])
                })
                .filter(|label| !label.is_empty());

            Some(VolumeDetails {
                total_bytes,
                free_bytes: total_free,
                volume_label,
            })
        }
    }
}

#[cfg(windows)]
pub fn enumerate_fixed_drives() -> Result<Vec<DriveInfoDto>, String> {
    Ok(collect_fixed_drives(&windows_source::WindowsDriveSource))
}

#[cfg(not(windows))]
pub fn enumerate_fixed_drives() -> Result<Vec<DriveInfoDto>, String> {
    Ok(Vec::new())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[derive(Default)]
    struct FakeSource {
        roots: Vec<String>,
        types: HashMap<String, u32>,
        details: HashMap<String, VolumeDetails>,
    }

    impl DriveSource for FakeSource {
        fn roots(&self) -> Vec<String> {
            self.roots.clone()
        }

        fn drive_type(&self, root: &str) -> u32 {
            self.types.get(root).copied().unwrap_or(0)
        }

        fn volume_details(&self, root: &str) -> Option<VolumeDetails> {
            self.details.get(root).map(|d| VolumeDetails {
                total_bytes: d.total_bytes,
                free_bytes: d.free_bytes,
                volume_label: d.volume_label.clone(),
            })
        }
    }

    #[test]
    fn parse_drive_strings_splits_on_nulls() {
        let buf: Vec<u16> = "C:\\\0D:\\\0\0".encode_utf16().collect();
        assert_eq!(
            parse_drive_strings(&buf),
            vec!["C:\\".to_owned(), "D:\\".to_owned()]
        );
    }

    #[test]
    fn parse_drive_strings_handles_empty_input() {
        assert!(parse_drive_strings(&[]).is_empty());
        assert!(parse_drive_strings(&[0]).is_empty());
        assert!(parse_drive_strings(&[0, 0, 0]).is_empty());
    }

    #[test]
    fn drive_type_label_covers_known_and_unknown_values() {
        assert_eq!(drive_type_label(3), "fixed");
        assert_eq!(drive_type_label(2), "removable");
        assert_eq!(drive_type_label(4), "remote");
        assert_eq!(drive_type_label(5), "cdrom");
        assert_eq!(drive_type_label(6), "ramdisk");
        assert_eq!(drive_type_label(0), "unknown");
        assert_eq!(drive_type_label(99), "unknown");
    }

    #[test]
    fn filters_out_non_fixed_drives() {
        let mut source = FakeSource {
            roots: vec!["C:\\".into(), "D:\\".into(), "Z:\\".into()],
            ..Default::default()
        };
        source.types.insert("C:\\".into(), 3); // fixed
        source.types.insert("D:\\".into(), 5); // cdrom
        source.types.insert("Z:\\".into(), 4); // mapped network share
        source.details.insert(
            "C:\\".into(),
            VolumeDetails {
                total_bytes: 100,
                free_bytes: 40,
                volume_label: Some("Windows".into()),
            },
        );

        let drives = collect_fixed_drives(&source);
        assert_eq!(drives.len(), 1);
        assert_eq!(drives[0].root_path, "C:\\");
        assert_eq!(drives[0].drive_type, "fixed");
        assert_eq!(drives[0].volume_label, Some("Windows".to_owned()));
    }

    #[test]
    fn one_unreadable_drive_does_not_drop_the_rest_of_the_list() {
        let mut source = FakeSource {
            roots: vec!["C:\\".into(), "G:\\".into()],
            ..Default::default()
        };
        source.types.insert("C:\\".into(), 3);
        source.types.insert("G:\\".into(), 3); // empty card reader: still reports fixed
        source.details.insert(
            "C:\\".into(),
            VolumeDetails {
                total_bytes: 500_000,
                free_bytes: 100_000,
                volume_label: None,
            },
        );
        // No entry for "G:\\" in `details` -- simulates GetDiskFreeSpaceExW
        // failing on it, the way it does for an empty card reader.

        let drives = collect_fixed_drives(&source);
        assert_eq!(drives.len(), 2, "the unreadable drive must stay in the list");

        let g = drives.iter().find(|d| d.root_path == "G:\\").unwrap();
        assert_eq!(g.total_bytes, None);
        assert_eq!(g.free_bytes, None);
        assert_eq!(g.volume_label, None);
        assert_eq!(g.drive_type, "fixed");

        let c = drives.iter().find(|d| d.root_path == "C:\\").unwrap();
        assert_eq!(c.total_bytes, Some(500_000));
        assert_eq!(c.free_bytes, Some(100_000));
    }

    #[test]
    fn byte_values_pass_through_without_swapping_or_truncating() {
        let mut source = FakeSource {
            roots: vec!["C:\\".into()],
            ..Default::default()
        };
        source.types.insert("C:\\".into(), 3);
        // Bigger than u32::MAX to catch an accidental narrowing cast.
        source.details.insert(
            "C:\\".into(),
            VolumeDetails {
                total_bytes: 999_654_321_098,
                free_bytes: 519_000_000_000,
                volume_label: Some("OS".into()),
            },
        );

        let drives = collect_fixed_drives(&source);
        assert_eq!(drives[0].total_bytes, Some(999_654_321_098));
        assert_eq!(drives[0].free_bytes, Some(519_000_000_000));
        assert!(drives[0].total_bytes > drives[0].free_bytes);
    }

    #[test]
    fn no_roots_returns_empty_list_not_an_error() {
        let source = FakeSource::default();
        assert!(collect_fixed_drives(&source).is_empty());
    }

    /// Not run by default -- exercises the real Win32 calls against whatever
    /// disks this machine actually has, which is exactly what CI must not
    /// depend on. `cargo test -- --ignored --nocapture` to see real output.
    #[test]
    #[ignore = "hits the real disks on this machine; run explicitly"]
    fn print_real_drives() {
        let drives = super::enumerate_fixed_drives().expect("enumeration must not fail");
        for drive in &drives {
            println!("{drive:?}");
        }
        assert!(!drives.is_empty(), "expected at least one fixed drive on a real machine");
    }
}
