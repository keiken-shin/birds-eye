//! Builds the benchmark corpora, because every scale claim on the board is
//! currently reasoned from reading the code rather than measured.
//!
//! Rust rather than a shell script for one reason: a million files. PowerShell
//! creating them one at a time takes hours; this takes minutes, because the
//! work is embarrassingly parallel and rayon is already a dependency.
//!
//! # Shape
//!
//! Files are spread over a nested tree rather than dropped in one directory. A
//! million files in a single folder measures NTFS large-directory behaviour,
//! which is not what a real disk looks like and would flatter or punish the
//! scanner for the wrong reason.
//!
//! Content is not random noise. A share of the small files are exact copies of
//! each other and the images come in near-identical pairs, so duplicate
//! detection and perceptual hashing have something real to find. A corpus where
//! nothing matches measures only the happy path.
//!
//! # Usage
//!
//! ```text
//! birds-eye-bench-corpus <profile> --root <dir> [--count N] [--size BYTES]
//! birds-eye-bench-corpus hold --root <dir> [--count N] [--seconds N]
//! ```
//!
//! Profiles: `small-files`, `images`, `large-binaries`, `hold`.
//! `hold` opens files exclusively and waits, so a scan can be run against files
//! something else is already using.

use rayon::prelude::*;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Files per leaf directory. Deep enough to be a tree, wide enough that a
/// million files does not need a thousand levels.
const FANOUT: usize = 100;

/// One in this many small files repeats an earlier one, so duplicate detection
/// has real work rather than a corpus where nothing matches.
const DUPLICATE_EVERY: usize = 7;

fn main() {
    let args = Args::parse();
    let started = std::time::Instant::now();

    let made = match args.profile.as_str() {
        "small-files" => small_files(&args),
        "images" => images(&args),
        "large-binaries" => large_binaries(&args),
        "hold" => return hold(&args),
        other => {
            eprintln!("unknown profile {other}");
            eprintln!("profiles: small-files, images, large-binaries, hold");
            std::process::exit(2);
        }
    };

    let elapsed = started.elapsed();
    println!(
        "profile={} root={} files={} bytes={} elapsed_ms={} files_per_sec={:.0}",
        args.profile,
        args.root.display(),
        made.files,
        made.bytes,
        elapsed.as_millis(),
        made.files as f64 / elapsed.as_secs_f64().max(0.001),
    );
}

struct Made {
    files: u64,
    bytes: u64,
}

/// Where file `index` goes, as `<root>/dNNN/dNNN/name`.
fn leaf_dir(root: &Path, index: usize) -> PathBuf {
    let bucket = index / FANOUT;
    root.join(format!("d{:03}", bucket / FANOUT))
        .join(format!("d{:03}", bucket % FANOUT))
}

fn small_files(args: &Args) -> Made {
    let count = args.count.unwrap_or(100_000);
    let size = args.size.unwrap_or(4_096);
    prepare(&args.root, count);

    let bytes: u64 = (0..count)
        .into_par_iter()
        .map(|index| {
            let path = leaf_dir(&args.root, index).join(format!("f{index:07}.bin"));
            let body = filler(content_seed(index), size);
            write_file(&path, &body);
            body.len() as u64
        })
        .sum();

    Made {
        files: count as u64,
        bytes,
    }
}

fn large_binaries(args: &Args) -> Made {
    let count = args.count.unwrap_or(10_000);
    let size = args.size.unwrap_or(1_048_576);
    prepare(&args.root, count);

    let bytes: u64 = (0..count)
        .into_par_iter()
        .map(|index| {
            let path = leaf_dir(&args.root, index).join(format!("blob{index:06}.dat"));
            let body = filler(index, size);
            write_file(&path, &body);
            body.len() as u64
        })
        .sum();

    Made {
        files: count as u64,
        bytes,
    }
}

/// Real decodable JPEGs, in near-identical pairs.
///
/// The perceptual hasher decodes pixels, so random bytes with a `.jpg`
/// extension would measure the rejection path rather than the hashing path,
/// which is the opposite of what this corpus is for.
fn images(args: &Args) -> Made {
    let count = args.count.unwrap_or(100_000);
    prepare(&args.root, count);

    let bytes: u64 = (0..count)
        .into_par_iter()
        .map(|index| {
            let path = leaf_dir(&args.root, index).join(format!("img{index:07}.jpg"));
            // Odd images are a one-shade shift of the even image before them:
            // different bytes, the same picture, which is exactly what a
            // perceptual hash exists to catch.
            let base = index & !1;
            let nudge = if index.is_multiple_of(2) { 0 } else { 3 };
            let body = jpeg(base, nudge);
            write_file(&path, &body);
            body.len() as u64
        })
        .sum();

    Made {
        files: count as u64,
        bytes,
    }
}

/// A 64x64 JPEG whose *structure* is decided by `seed`.
///
/// Structure, not colour. The first version shifted the red and green channels
/// by the seed and left the shape of the picture identical, which made every
/// image in the corpus the same picture to a perceptual hasher -- a phash drops
/// the DC term precisely so that overall brightness does not count. Measured on
/// 100,000 generated images: **882 distinct dhash values, one of them covering
/// 31,213 files**. The analysis pass then tried to relate them all to each
/// other and was still running 28 hours later.
///
/// So the seed now paints an 8x8 block pattern. Each block's brightness comes
/// from the seed, which is exactly what a DCT hash reads.
fn jpeg(seed: usize, nudge: u8) -> Vec<u8> {
    // One brightness per block, drawn from the seed.
    let mut blocks = [0_u8; 64];
    let mut state = (seed as u64)
        .wrapping_mul(6_364_136_223_846_793_005)
        .wrapping_add(1_442_695_040_888_963_407);
    for block in blocks.iter_mut() {
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        *block = (state >> 33) as u8;
    }
    let image = image::RgbImage::from_fn(64, 64, |x, y| {
        let block = blocks[((y / 8) * 8 + (x / 8)) as usize];
        // `nudge` is a small brightness change: enough to alter the compressed
        // bytes, far too small to change the structure the hash reads.
        let shade = block.saturating_add(nudge);
        image::Rgb([shade, shade, shade])
    });
    let mut out = Vec::new();
    image::DynamicImage::ImageRgb8(image)
        .write_to(
            &mut std::io::Cursor::new(&mut out),
            image::ImageFormat::Jpeg,
        )
        .expect("encode jpeg");
    out
}

/// Which content a small file carries.
///
/// Every seventh file copies its immediate neighbour, so roughly one file in
/// seven is a duplicate of another.
///
/// It copies the file *before* it, not the one `DUPLICATE_EVERY` back. That was
/// the first attempt and it was wrong in a way worth recording: file 14 seeded
/// from file 7, which itself seeded from file 0, so the copies formed a chain
/// and 7,000 files ended up containing exactly **one** duplicate pair. The
/// benchmark would have timed duplicate detection finding nothing and reported
/// it as a result. `index - 1` cannot chain, because a multiple of seven minus
/// one is never itself a multiple of seven.
///
/// Named rather than inlined because "does this corpus actually contain
/// duplicates" is the property the whole benchmark rests on, and an inline
/// expression cannot be asserted against.
fn content_seed(index: usize) -> usize {
    if index.is_multiple_of(DUPLICATE_EVERY) && index > 0 {
        index - 1
    } else {
        index
    }
}

/// Bytes that do not compress to nothing, so hashing has something to chew and
/// a sparse-file optimisation cannot quietly make the corpus free.
fn filler(seed: usize, size: usize) -> Vec<u8> {
    let mut state = (seed as u64)
        .wrapping_mul(6_364_136_223_846_793_005)
        .wrapping_add(1);
    (0..size)
        .map(|_| {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            (state >> 33) as u8
        })
        .collect()
}

/// Create every directory up front, single-threaded.
///
/// Doing it inside the parallel loop means every thread racing on the same
/// `create_dir_all`, which is both slower and a source of spurious errors.
fn prepare(root: &Path, count: usize) {
    fs::create_dir_all(root).expect("create root");
    let mut made = std::collections::HashSet::new();
    for index in (0..count).step_by(FANOUT) {
        let dir = leaf_dir(root, index);
        if made.insert(dir.clone()) {
            fs::create_dir_all(&dir).expect("create leaf directory");
        }
    }
}

fn write_file(path: &Path, body: &[u8]) {
    let mut file =
        fs::File::create(path).unwrap_or_else(|error| panic!("create {}: {error}", path.display()));
    file.write_all(body).expect("write body");
}

/// Hold files open so a scan meets files something else is using.
///
/// Windows exclusivity is the point: the scanner has to survive a file it
/// cannot read, and the only honest way to test that is a real handle held by a
/// real process.
fn hold(args: &Args) {
    let count = args.count.unwrap_or(1_000);
    let seconds = args.seconds.unwrap_or(120);
    prepare(&args.root, count);

    let mut held = Vec::new();
    for index in 0..count {
        let path = leaf_dir(&args.root, index).join(format!("locked{index:06}.bin"));
        write_file(&path, &filler(index, 4_096));
        match exclusive_open(&path) {
            Ok(handle) => held.push(handle),
            Err(error) => eprintln!("could not hold {}: {error}", path.display()),
        }
    }
    println!(
        "holding {} of {} files under {} for {seconds}s",
        held.len(),
        count,
        args.root.display()
    );
    std::thread::sleep(std::time::Duration::from_secs(seconds));
    println!("released");
}

#[cfg(windows)]
fn exclusive_open(path: &Path) -> std::io::Result<fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    // share_mode 0: no other process may read, write or delete it.
    fs::OpenOptions::new().read(true).share_mode(0).open(path)
}

#[cfg(not(windows))]
fn exclusive_open(path: &Path) -> std::io::Result<fs::File> {
    // No portable exclusive open. The handle still keeps the file busy enough
    // to be worth holding, and this binary targets Windows.
    fs::OpenOptions::new().read(true).open(path)
}

struct Args {
    profile: String,
    root: PathBuf,
    count: Option<usize>,
    size: Option<usize>,
    seconds: Option<u64>,
}

impl Args {
    fn parse() -> Self {
        let mut raw = std::env::args().skip(1);
        let profile = raw.next().unwrap_or_else(|| {
            eprintln!("usage: birds-eye-bench-corpus <profile> --root <dir> [--count N] [--size BYTES] [--seconds N]");
            std::process::exit(2);
        });
        let (mut root, mut count, mut size, mut seconds) = (None, None, None, None);
        while let Some(flag) = raw.next() {
            let value = raw.next();
            match (flag.as_str(), value) {
                ("--root", Some(v)) => root = Some(PathBuf::from(v)),
                ("--count", Some(v)) => count = v.parse().ok(),
                ("--size", Some(v)) => size = v.parse().ok(),
                ("--seconds", Some(v)) => seconds = v.parse().ok(),
                (other, _) => {
                    eprintln!("unknown flag {other}");
                    std::process::exit(2);
                }
            }
        }
        Self {
            profile,
            root: root.unwrap_or_else(|| {
                eprintln!("--root is required");
                std::process::exit(2);
            }),
            count,
            size,
            seconds,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A corpus that quietly writes fewer files than asked is a benchmark that
    /// reports the wrong denominator, and nobody would notice.
    #[test]
    fn every_file_index_gets_its_own_place() {
        let root = Path::new("/r");
        let mut seen = std::collections::HashSet::new();
        for index in 0..10_000 {
            let path = leaf_dir(root, index).join(format!("f{index:07}.bin"));
            assert!(seen.insert(path), "two files landed on one path at {index}");
        }
    }

    /// Fanout is the point. All of them in one directory would measure NTFS
    /// large-directory behaviour instead of the scanner.
    #[test]
    fn files_are_spread_over_a_tree_not_one_folder() {
        let root = Path::new("/r");
        let dirs: std::collections::HashSet<_> =
            (0..10_000).map(|index| leaf_dir(root, index)).collect();
        assert_eq!(
            dirs.len(),
            10_000 / FANOUT,
            "expected one directory per {FANOUT} files"
        );
    }

    /// The corpus has to contain duplicates, or duplicate detection is timed
    /// doing nothing and the number means nothing.
    #[test]
    fn the_small_file_corpus_really_contains_duplicates() {
        // File 7 must carry file 6's bytes, and the two must be byte-identical.
        assert_eq!(content_seed(DUPLICATE_EVERY), content_seed(DUPLICATE_EVERY - 1));
        assert_eq!(
            filler(content_seed(DUPLICATE_EVERY - 1), 64),
            filler(content_seed(DUPLICATE_EVERY), 64),
            "every seventh file must copy its neighbour"
        );
        // Everything else has to differ, or the corpus is one giant group.
        assert_ne!(
            filler(content_seed(1), 64),
            filler(content_seed(2), 64),
            "non-duplicates must not collide"
        );

        // And the share must really be about one in seven. This is the
        // assertion that caught the chaining bug: the first version passed
        // every other check here while producing exactly ONE duplicate pair in
        // 7,000 files.
        let distinct: std::collections::HashSet<_> = (0..7_000).map(content_seed).collect();
        let copies = 7_000 - distinct.len();
        assert_eq!(copies, 999, "about one file in seven must be a copy");
    }

    /// The test that should have existed first.
    ///
    /// The original generator varied colour only, so 100,000 images collapsed
    /// onto 882 distinct dhash values and the analysis pass ran for 28 hours
    /// trying to relate them. A corpus whose images all look alike does not
    /// measure perceptual hashing, it measures a pathological cluster.
    ///
    /// Structure is what a DCT hash reads, so structure is what this asserts.
    #[test]
    fn different_seeds_make_structurally_different_pictures() {
        let luma = |seed: usize| {
            image::load_from_memory_with_format(&jpeg(seed, 0), image::ImageFormat::Jpeg)
                .expect("decode")
                .to_luma8()
        };
        // Coarse stand-in for a perceptual hash: the 8x8 block pattern itself.
        let signature = |seed: usize| {
            let image = luma(seed);
            let mean = |bx: u32, by: u32| {
                let mut total = 0_u32;
                for y in 0..8 {
                    for x in 0..8 {
                        total += u32::from(image.get_pixel(bx * 8 + x, by * 8 + y).0[0]);
                    }
                }
                total / 64
            };
            let cells: Vec<u32> = (0..8).flat_map(|by| (0..8).map(move |bx| (bx, by))).map(|(bx, by)| mean(bx, by)).collect();
            let average: u32 = cells.iter().sum::<u32>() / 64;
            cells.iter().map(|c| u64::from(*c > average)).fold(0_u64, |acc, bit| (acc << 1) | bit)
        };

        let distinct: std::collections::HashSet<u64> =
            (0..2_000).step_by(2).map(signature).collect();
        assert!(
            distinct.len() > 900,
            "1000 seeds must not collapse onto {} signatures",
            distinct.len()
        );
    }

    /// And near-duplicates, or perceptual hashing is timed doing nothing.
    #[test]
    fn image_pairs_are_the_same_picture_with_different_bytes() {
        let left = jpeg(0, 0);
        let right = jpeg(0, 1);
        assert_ne!(left, right, "a pair must not be byte-identical");
        let decode = |bytes: &[u8]| {
            image::load_from_memory_with_format(bytes, image::ImageFormat::Jpeg)
                .expect("corpus images must decode")
                .to_luma8()
        };
        let (left, right) = (decode(&left), decode(&right));
        let drift: u32 = left
            .pixels()
            .zip(right.pixels())
            .map(|(a, b)| u32::from(a.0[0].abs_diff(b.0[0])))
            .sum::<u32>()
            / (left.pixels().len() as u32);
        assert!(drift <= 8, "a pair must look alike; mean drift was {drift}");
    }
}
