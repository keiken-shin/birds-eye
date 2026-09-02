//! What a file actually is, as opposed to what it is called.
//!
//! An extension is a claim made by whoever named the file. `holiday.jpg` may be
//! a PNG that someone renamed, a text file, or a renamed executable. A real
//! photo saved as `IMG_0421` with no extension is a photo that every media
//! feature in the app cannot see. Both are ordinary, both happen by accident,
//! and both make the app confidently wrong about a file.
//!
//! The first bytes of a file settle it. Image formats all begin with a
//! signature, and the `image` crate already reads them, so this is a few
//! hundred bytes and one call.
//!
//! # What is sniffed, and what is not
//!
//! Reading the head of every file on a multi-terabyte volume would cost more
//! than the entire directory walk. So this reads only the files where the
//! answer can change something:
//!
//! - files whose extension claims an image format, because that claim is what
//!   drives near-duplicate detection and the media views
//! - files with no extension at all, because they are invisible to every
//!   feature that keys on one
//!
//! Measured on `C:\Program Files`: 4,211 files out of 71,980, under six per
//! cent, and it took the walk from 250 ms to 1.5 s. That cost is real and falls
//! entirely on files whose type actually matters. Everything else keeps its
//! extension as its only description, which is honest -- the index says what it
//! checked and what it did not.
//!
//! # A trap for whoever surfaces the disagreement
//!
//! `extension` and `detected_format` differing is not the same as the file
//! lying. `.jpeg` against `jpg` and `.tif` against `tiff` are the same format
//! spelled two ways, and on the same volume that is 81 of the 97 differences.
//! The real finds were 15 files named `.png` that are JPEGs and one `.ico` that
//! is a PNG. Anything that reports a mismatch to a person has to fold the
//! aliases first or it will cry wolf six times out of seven.
//!
//! # Three answers, not two
//!
//! `Some(format)` means the bytes were read and recognised. `Some("unknown")`
//! means the bytes were read and were not any image format. `None` means the
//! file was never sniffed. The middle case is the one that matters: without it,
//! "we looked and it is not an image" and "we never looked" collapse into the
//! same silence.

use std::io::Read;
use std::path::Path;

/// Recorded when the head of a file was read and matched nothing known. Not the
/// same as "not looked at", which is `None`.
pub const UNKNOWN: &str = "unknown";

/// Enough for every image signature the `image` crate recognises, with room to
/// spare. One read, no seeking.
const SNIFF_BYTES: usize = 512;

/// Extensions that make a claim worth checking. Kept in step with the near
/// duplicate populator, which is the main consumer.
const CLAIMS_IMAGE: &[&str] = &[
    "jpg", "jpeg", "jpe", "jfif", "png", "gif", "webp", "bmp", "tif", "tiff", "heic", "heif",
    "avif", "ico",
];

/// Is this file worth opening to find out what it is?
pub fn worth_sniffing(extension: Option<&str>) -> bool {
    match extension {
        // No extension, or an empty one: the file makes no claim, so it is
        // invisible to everything that keys on one until the bytes are read.
        None | Some("") => true,
        Some(ext) => CLAIMS_IMAGE.contains(&ext.to_ascii_lowercase().as_str()),
    }
}

/// The format the bytes say, or [`UNKNOWN`] if they say nothing recognisable.
///
/// `None` only when the file could not be read at all, which is not a finding
/// about the file and must not be recorded as one.
pub fn detect_format(path: &Path) -> Option<&'static str> {
    let mut head = [0_u8; SNIFF_BYTES];
    let read = {
        let mut file = std::fs::File::open(path).ok()?;
        file.read(&mut head).ok()?
    };
    if read == 0 {
        // An empty file is not an unreadable one, and it is certainly not an
        // image. Saying so is the useful answer.
        return Some(UNKNOWN);
    }
    Some(match image::guess_format(&head[..read]) {
        Ok(format) => format_name(format),
        Err(_) => UNKNOWN,
    })
}

/// Stable names, chosen to match the extension spelling a person would expect,
/// so a disagreement reads plainly: `extension=jpg detected=png`.
fn format_name(format: image::ImageFormat) -> &'static str {
    use image::ImageFormat as F;
    match format {
        F::Png => "png",
        F::Jpeg => "jpg",
        F::Gif => "gif",
        F::WebP => "webp",
        F::Tiff => "tiff",
        F::Bmp => "bmp",
        F::Ico => "ico",
        F::Avif => "avif",
        F::Pnm => "pnm",
        F::Tga => "tga",
        F::Dds => "dds",
        F::Farbfeld => "farbfeld",
        F::Hdr => "hdr",
        F::OpenExr => "exr",
        F::Qoi => "qoi",
        // A format the crate learns about later lands here rather than being
        // silently mislabelled as something else.
        _ => UNKNOWN,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("birdseye-sniff");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    const PNG_HEAD: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

    /// The case the issue names: a file called .jpg that is not a JPEG.
    #[test]
    fn a_png_wearing_a_jpg_name_is_reported_as_a_png() {
        let path = temp("liar.jpg", PNG_HEAD);
        assert_eq!(detect_format(&path), Some("png"));
    }

    /// The other case: a real image with no extension, invisible to everything
    /// that keys on one.
    #[test]
    fn an_image_with_no_extension_is_still_recognised() {
        let path = temp("IMG_0421", PNG_HEAD);
        assert!(worth_sniffing(None));
        assert_eq!(detect_format(&path), Some("png"));
    }

    /// "We looked and it is not an image" must be distinguishable from "we never
    /// looked", or the index cannot say what it checked.
    #[test]
    fn something_that_is_not_an_image_says_so_rather_than_saying_nothing() {
        let path = temp("notes.jpg", b"this is plain text, not a picture at all");
        assert_eq!(detect_format(&path), Some(UNKNOWN));
    }

    #[test]
    fn an_empty_file_is_answered_not_skipped() {
        let path = temp("empty.jpg", b"");
        assert_eq!(detect_format(&path), Some(UNKNOWN));
    }

    #[test]
    fn a_file_that_cannot_be_read_is_not_a_finding() {
        let missing = std::env::temp_dir().join("birdseye-sniff").join("gone.jpg");
        let _ = std::fs::remove_file(&missing);
        assert_eq!(detect_format(&missing), None);
    }

    /// The cost control: most files are never opened.
    #[test]
    fn only_files_whose_answer_could_change_are_opened() {
        assert!(worth_sniffing(Some("jpg")));
        assert!(worth_sniffing(Some("PNG")), "the check is case-insensitive");
        assert!(worth_sniffing(None));
        assert!(worth_sniffing(Some("")));
        assert!(!worth_sniffing(Some("dll")));
        assert!(!worth_sniffing(Some("txt")));
        assert!(!worth_sniffing(Some("exe")));
    }
}
