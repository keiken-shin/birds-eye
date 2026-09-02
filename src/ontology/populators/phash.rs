//! Visual near-duplicate detection over decoded pixels.
//!
//! What this replaced, and why it mattered: the previous implementation read a
//! file's bytes and bucket-averaged them. For JPEG, PNG and WebP those bytes are
//! compressed, so the same photograph saved twice in different formats shared
//! nothing, and unrelated compressed files -- all high-entropy, all averaging
//! near the middle of the byte range -- landed within the near-duplicate
//! threshold on chance alone. It did not merely miss visual duplicates. It
//! invented them, and a confirmed near-duplicate discovery graduates a permanent
//! `nearDuplicateOf` relation into the ontology.
//!
//! The pipeline now is the ordinary one: sniff the header, decode, convert to
//! grayscale, resize to a canonical size, and hash the pixels.
//!
//! - `phash` is a DCT perceptual hash: 32x32 grayscale, 2-D DCT-II, the low
//!   frequency 8x8 block excluding DC, each bit set where the coefficient beats
//!   the median. Robust to rescaling and recompression, which is the whole point.
//! - `dhash` is a difference hash: 9x8 grayscale, each bit set where a pixel is
//!   at least as bright as its right-hand neighbour. Cheap, and it fails
//!   differently from pHash, so agreement between the two means more than either
//!   alone.
//!
//! Format comes from the file header, not the extension, so a `.jpg` that is not
//! a JPEG is skipped rather than decoded as one. The candidate prefilter reads
//! `files.detected_format`, which the scan records for every file whose name
//! either claims an image format or claims nothing. A row with no recorded
//! format -- indexed before that existed -- falls back to its extension, so an
//! old index keeps working rather than going silently empty.
//!
//! Deliberately still absent, tracked separately rather than half-built here:
//! EXIF orientation normalisation (a rotated original and its upright export
//! will not match), colour histograms, and any comparison cheaper than the
//! all-pairs scan below.
//!
//! Output remains a suggestion. Nothing here may delete anything.

use crate::ontology::discoveries::{insert_discovery, NewDiscovery};
use crate::ontology::populators::{
    CostTier, Populator, PopulatorContext, PopulatorError, PopulatorOutcome,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::fs;
use std::io::Read;

const BATCH_SIZE: i64 = 100;

/// Above this, decoding costs more memory than a triage signal is worth. The
/// file is left unhashed rather than half-read: a truncated image is not a
/// smaller image, it is a decode failure or, worse, a different picture.
const MAX_DECODE_BYTES: u64 = 128 * 1024 * 1024;

/// Enough of the head to identify every container `image` can decode.
const SNIFF_BYTES: usize = 512;

/// Combined Hamming distance across both 64-bit hashes, so out of 128 bits.
///
/// Calibrated against the fixtures at the bottom of this file: the same image
/// re-encoded, rescaled or lightly recoloured stays in single digits, and
/// visibly different images sit far above. 12 keeps the honest matches and
/// leaves a wide margin before the noise.
const NEAR_DUPLICATE_DISTANCE: u32 = 12;

/// Side of the square the DCT runs over.
const DCT_SIZE: usize = 32;

pub struct PerceptualHashPopulator;

impl PerceptualHashPopulator {
    pub fn new() -> Self {
        Self
    }
}

impl Default for PerceptualHashPopulator {
    fn default() -> Self {
        Self::new()
    }
}

impl Populator for PerceptualHashPopulator {
    fn name(&self) -> &'static str {
        "PerceptualHashPopulator"
    }

    fn cost_tier(&self) -> CostTier {
        CostTier::Expensive
    }

    fn run(
        &self,
        conn: &mut Connection,
        ctx: &mut PopulatorContext,
        resume_cursor: Option<&str>,
    ) -> Result<PopulatorOutcome, PopulatorError> {
        let mut last_id = resume_cursor
            .and_then(|cursor| cursor.parse::<i64>().ok())
            .unwrap_or(0);

        loop {
            if ctx.is_paused() {
                return Ok(PopulatorOutcome::Paused {
                    cursor: last_id.to_string(),
                    partial: ctx.snapshot(),
                });
            }

            let files = load_image_batch(conn, last_id)?;
            if files.is_empty() {
                break;
            }

            for file in files {
                ctx.note_file();
                if let Some(hashes) = hash_file(&file.path) {
                    upsert_hash(conn, file.id, hashes.phash, hashes.dhash)?;
                    ctx.note_assertion();
                }
                last_id = file.id;
            }
        }

        emit_near_duplicate_discoveries(conn, ctx)?;
        Ok(PopulatorOutcome::Completed(ctx.snapshot()))
    }
}

struct ImageFile {
    id: i64,
    path: String,
}

struct Hashes {
    phash: [u8; 8],
    dhash: [u8; 8],
}

fn load_image_batch(conn: &Connection, after_id: i64) -> Result<Vec<ImageFile>, PopulatorError> {
    let mut stmt = conn.prepare(
        "SELECT id, path
         FROM files
         WHERE id > ?1
           AND deleted_at IS NULL
           -- What the bytes said, when the scan looked; the extension only
           -- where it did not. A .jpg that is not an image is excluded here
           -- rather than opened and rejected, and a real image with no
           -- extension at all becomes visible for the first time.
           AND (
             CASE
               WHEN detected_format IS NOT NULL THEN detected_format <> 'unknown'
               ELSE lower(COALESCE(extension, '')) IN
                 ('jpg', 'jpeg', 'jpe', 'jfif', 'png', 'gif', 'webp', 'bmp', 'tif', 'tiff')
             END
           )
         ORDER BY id ASC
         LIMIT ?2",
    )?;
    let rows = stmt.query_map((after_id, BATCH_SIZE), |row| {
        Ok(ImageFile {
            id: row.get(0)?,
            path: row.get(1)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// `None` for anything that cannot be hashed honestly: too large to decode, not
/// actually an image whatever the extension claims, or a malformed file. A file
/// with no hash simply never matches, which is the safe direction.
///
/// The reasons are dropped rather than recorded. Surfacing them is the scan
/// coverage work; inventing a second, private skip log here would just have to
/// be deleted when that lands.
fn hash_file(path: &str) -> Option<Hashes> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_DECODE_BYTES {
        return None;
    }

    // Sniff the header before committing to the full read: a HEIC, a RAW, or a
    // renamed archive is rejected after 512 bytes instead of after 40 MB.
    let mut head = [0_u8; SNIFF_BYTES];
    let read = {
        let mut file = fs::File::open(path).ok()?;
        read_up_to(&mut file, &mut head)
    };
    let format = image::guess_format(&head[..read]).ok()?;

    let bytes = fs::read(path).ok()?;
    let decoded = image::load_from_memory_with_format(&bytes, format).ok()?;
    Some(hash_image(&decoded))
}

/// `Read::read` may return fewer bytes than asked for without being at EOF.
fn read_up_to(file: &mut impl Read, buffer: &mut [u8]) -> usize {
    let mut filled = 0;
    while filled < buffer.len() {
        match file.read(&mut buffer[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(_) => break,
        }
    }
    filled
}

fn hash_image(image: &image::DynamicImage) -> Hashes {
    use image::imageops::FilterType;

    let gray = image.to_luma8();
    let dct_source =
        image::imageops::resize(&gray, DCT_SIZE as u32, DCT_SIZE as u32, FilterType::Triangle);
    let diff_source = image::imageops::resize(&gray, 9, 8, FilterType::Triangle);

    Hashes {
        phash: perceptual_hash(&dct_source),
        dhash: difference_hash(&diff_source),
    }
}

/// DCT perceptual hash. The low-frequency 8x8 corner carries the structure of
/// the picture; the DC term is dropped because it only encodes overall
/// brightness, and comparing against the median rather than the mean stops one
/// extreme coefficient dragging every bit with it.
fn perceptual_hash(image: &image::GrayImage) -> [u8; 8] {
    let mut pixels = [[0.0_f32; DCT_SIZE]; DCT_SIZE];
    for (y, row) in pixels.iter_mut().enumerate() {
        for (x, value) in row.iter_mut().enumerate() {
            *value = image.get_pixel(x as u32, y as u32).0[0] as f32;
        }
    }

    let coefficients = dct_2d(&pixels);

    // Top-left 8x8, DC excluded: 63 coefficients decide 64 bits, and the DC bit
    // is set from the median so the hash still has a defined value there.
    let mut low: Vec<f32> = Vec::with_capacity(64);
    for row in coefficients.iter().take(8) {
        low.extend_from_slice(&row[..8]);
    }
    let mut without_dc: Vec<f32> = low[1..].to_vec();
    without_dc.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median = without_dc[without_dc.len() / 2];

    bits_to_bytes(low.iter().map(|value| *value > median))
}

/// Separable 2-D DCT-II. 32x32 is small enough that the naive form costs about
/// 65k multiplies per image, well under what decoding the JPEG already cost.
fn dct_2d(input: &[[f32; DCT_SIZE]; DCT_SIZE]) -> [[f32; DCT_SIZE]; DCT_SIZE] {
    let cosines = cosine_table();

    let mut rows = [[0.0_f32; DCT_SIZE]; DCT_SIZE];
    for (y, row) in input.iter().enumerate() {
        for u in 0..DCT_SIZE {
            let mut sum = 0.0;
            for (x, value) in row.iter().enumerate() {
                sum += value * cosines[x][u];
            }
            rows[y][u] = sum;
        }
    }

    let mut out = [[0.0_f32; DCT_SIZE]; DCT_SIZE];
    for u in 0..DCT_SIZE {
        for v in 0..DCT_SIZE {
            let mut sum = 0.0;
            for (y, row) in rows.iter().enumerate() {
                sum += row[u] * cosines[y][v];
            }
            out[v][u] = sum;
        }
    }
    out
}

fn cosine_table() -> [[f32; DCT_SIZE]; DCT_SIZE] {
    let mut table = [[0.0_f32; DCT_SIZE]; DCT_SIZE];
    for (x, row) in table.iter_mut().enumerate() {
        for (u, cell) in row.iter_mut().enumerate() {
            *cell = (((2 * x + 1) as f32) * (u as f32) * std::f32::consts::PI
                / (2.0 * DCT_SIZE as f32))
                .cos();
        }
    }
    table
}

/// Difference hash over a 9x8 image: 8 comparisons per row, 8 rows.
fn difference_hash(image: &image::GrayImage) -> [u8; 8] {
    let mut bits = Vec::with_capacity(64);
    for y in 0..8_u32 {
        for x in 0..8_u32 {
            let left = image.get_pixel(x, y).0[0];
            let right = image.get_pixel(x + 1, y).0[0];
            bits.push(left >= right);
        }
    }
    bits_to_bytes(bits)
}

fn bits_to_bytes(bits: impl IntoIterator<Item = bool>) -> [u8; 8] {
    let mut out = [0_u8; 8];
    for (idx, bit) in bits.into_iter().take(64).enumerate() {
        if bit {
            out[idx / 8] |= 1 << (idx % 8);
        }
    }
    out
}

fn upsert_hash(
    conn: &Connection,
    file_id: i64,
    phash: [u8; 8],
    dhash: [u8; 8],
) -> Result<(), PopulatorError> {
    conn.execute(
        "INSERT INTO ontology_perceptual_hashes (file_id, phash, dhash, computed_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(file_id) DO UPDATE SET
           phash = excluded.phash,
           dhash = excluded.dhash,
           computed_at = excluded.computed_at",
        params![file_id, phash.to_vec(), dhash.to_vec(), unix_now()],
    )?;
    Ok(())
}

fn emit_near_duplicate_discoveries(
    conn: &Connection,
    ctx: &mut PopulatorContext,
) -> Result<(), PopulatorError> {
    let hashes = load_hashes(conn)?;
    for left_idx in 0..hashes.len() {
        for right in hashes.iter().skip(left_idx + 1) {
            if hashes[left_idx].file_id == right.file_id {
                continue;
            }
            let distance = hamming_distance(&hashes[left_idx].phash, &right.phash)
                + hamming_distance(&hashes[left_idx].dhash, &right.dhash);
            if distance > NEAR_DUPLICATE_DISTANCE {
                continue;
            }

            let payload = NearDuplicatePayload {
                files: vec![
                    NearDuplicateFile {
                        file_id: hashes[left_idx].file_id,
                        path: hashes[left_idx].path.clone(),
                        size: hashes[left_idx].size.max(0) as u64,
                    },
                    NearDuplicateFile {
                        file_id: right.file_id,
                        path: right.path.clone(),
                        size: right.size.max(0) as u64,
                    },
                ],
                hamming_distance: distance,
            };
            let payload_json = serde_json::to_string(&payload)?;
            if discovery_exists(conn, "near-duplicate-cluster", &payload_json)? {
                continue;
            }
            insert_discovery(
                conn,
                &NewDiscovery {
                    kind: "near-duplicate-cluster",
                    payload_json: &payload_json,
                    confidence: confidence_for_distance(distance),
                    potential_bytes_unlocked: hashes[left_idx].size.min(right.size).max(0) as u64,
                },
            )?;
            ctx.note_discovery();
        }
    }
    Ok(())
}

fn load_hashes(conn: &Connection) -> Result<Vec<HashRow>, PopulatorError> {
    let mut stmt = conn.prepare(
        "SELECT f.id, f.path, f.size, p.phash, p.dhash
         FROM ontology_perceptual_hashes p
         JOIN files f ON f.id = p.file_id
         WHERE f.deleted_at IS NULL
         ORDER BY f.id ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(HashRow {
            file_id: row.get(0)?,
            path: row.get(1)?,
            size: row.get(2)?,
            phash: blob_to_hash(row.get::<_, Vec<u8>>(3)?),
            dhash: blob_to_hash(row.get::<_, Vec<u8>>(4)?),
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn discovery_exists(conn: &Connection, kind: &str, payload: &str) -> Result<bool, PopulatorError> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM ontology_discoveries WHERE kind = ?1 AND payload = ?2 LIMIT 1",
            (kind, payload),
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

fn hamming_distance(left: &[u8; 8], right: &[u8; 8]) -> u32 {
    left.iter()
        .zip(right.iter())
        .map(|(l, r)| (l ^ r).count_ones())
        .sum()
}

fn blob_to_hash(blob: Vec<u8>) -> [u8; 8] {
    let mut out = [0_u8; 8];
    for (idx, byte) in blob.into_iter().take(8).enumerate() {
        out[idx] = byte;
    }
    out
}

/// Distance is evidence strength, not probability -- the naming and the ceiling
/// are deliberate. Even a zero-distance pair tops out at 0.95, because two
/// pictures that hash identically are still two pictures until someone looks.
fn confidence_for_distance(distance: u32) -> f32 {
    (0.95 - (distance as f32 * 0.03)).max(0.6)
}

fn unix_now() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

struct HashRow {
    file_id: i64,
    path: String,
    size: i64,
    phash: [u8; 8],
    dhash: [u8; 8],
}

#[derive(Serialize)]
struct NearDuplicatePayload {
    files: Vec<NearDuplicateFile>,
    hamming_distance: u32,
}

#[derive(Serialize)]
struct NearDuplicateFile {
    file_id: i64,
    path: String,
    size: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageFormat, Rgb, RgbImage};

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("birdseye-phash").join(format!(
            "{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    /// A picture with real structure -- diagonal bands plus a bright block --
    /// rather than noise or a flat fill. A hash that survives re-encoding has to
    /// have something to hold on to, and a flat image would pass every test by
    /// accident.
    fn subject(width: u32, height: u32) -> RgbImage {
        let mut image = RgbImage::new(width, height);
        for (x, y, pixel) in image.enumerate_pixels_mut() {
            let fx = x as f32 / width as f32;
            let fy = y as f32 / height as f32;
            let band = ((fx + fy) * 6.0).sin() * 0.5 + 0.5;
            let value = (band * 220.0) as u8;
            *pixel = if fx > 0.6 && fy < 0.3 {
                Rgb([250, 250, 250])
            } else {
                Rgb([value, value / 2, 255 - value])
            };
        }
        image
    }

    /// A different picture that shares the palette, which is exactly the case a
    /// colour-average hash gets wrong.
    fn other_subject(width: u32, height: u32) -> RgbImage {
        let mut image = RgbImage::new(width, height);
        for (x, y, pixel) in image.enumerate_pixels_mut() {
            let fx = x as f32 / width as f32;
            let fy = y as f32 / height as f32;
            let rings = ((fx - 0.5).powi(2) + (fy - 0.5).powi(2)).sqrt() * 14.0;
            let value = (rings.cos() * 0.5 + 0.5) * 220.0;
            let value = value as u8;
            *pixel = Rgb([value, value / 2, 255 - value]);
        }
        image
    }

    fn save(dir: &std::path::Path, name: &str, image: &RgbImage, format: ImageFormat) -> String {
        let path = dir.join(name);
        image.save_with_format(&path, format).expect("save fixture");
        path.display().to_string()
    }

    fn distance(left: &Hashes, right: &Hashes) -> u32 {
        hamming_distance(&left.phash, &right.phash) + hamming_distance(&left.dhash, &right.dhash)
    }

    /// The defect this module was rewritten for. The old byte-bucket hash could
    /// not possibly pass this: a PNG and a JPEG of one picture share no bytes.
    #[test]
    fn the_same_picture_as_jpeg_and_png_matches() {
        let dir = temp_dir("formats");
        let image = subject(320, 240);
        let png = save(&dir, "a.png", &image, ImageFormat::Png);
        let jpeg = save(&dir, "a.jpg", &image, ImageFormat::Jpeg);

        let a = hash_file(&png).expect("hash png");
        let b = hash_file(&jpeg).expect("hash jpeg");
        let d = distance(&a, &b);
        assert!(
            d <= NEAR_DUPLICATE_DISTANCE,
            "same picture across formats must match, distance was {d}"
        );
    }

    #[test]
    fn a_rescaled_copy_matches() {
        let dir = temp_dir("rescaled");
        let full = subject(640, 480);
        let small = image::imageops::resize(
            &full,
            160,
            120,
            image::imageops::FilterType::CatmullRom,
        );
        let a = hash_file(&save(&dir, "full.png", &full, ImageFormat::Png)).expect("hash full");
        let b = hash_file(&save(&dir, "small.png", &small, ImageFormat::Png)).expect("hash small");
        let d = distance(&a, &b);
        assert!(d <= NEAR_DUPLICATE_DISTANCE, "a thumbnail must match its original, distance was {d}");
    }

    /// The adversarial case: same palette, different picture. This is what the
    /// old hash reported as a near-duplicate.
    #[test]
    fn a_different_picture_with_the_same_palette_does_not_match() {
        let dir = temp_dir("different");
        let a = hash_file(&save(&dir, "bands.png", &subject(320, 240), ImageFormat::Png))
            .expect("hash bands");
        let b = hash_file(&save(
            &dir,
            "rings.png",
            &other_subject(320, 240),
            ImageFormat::Png,
        ))
        .expect("hash rings");
        let d = distance(&a, &b);
        assert!(
            d > NEAR_DUPLICATE_DISTANCE,
            "different pictures must not match, distance was only {d}"
        );
    }

    /// Format comes from the header. A file named `.jpg` that is not a JPEG is
    /// skipped, not decoded as one and not hashed as bytes.
    #[test]
    fn a_file_lying_about_its_extension_is_skipped() {
        let dir = temp_dir("liar");
        let path = dir.join("not-really.jpg");
        std::fs::write(&path, b"this is plain text, not an image at all").unwrap();
        assert!(hash_file(&path.display().to_string()).is_none());
    }

    #[test]
    fn a_truncated_image_is_skipped_rather_than_half_hashed() {
        let dir = temp_dir("truncated");
        let whole = save(&dir, "whole.png", &subject(320, 240), ImageFormat::Png);
        let bytes = std::fs::read(&whole).unwrap();
        let path = dir.join("cut.png");
        std::fs::write(&path, &bytes[..bytes.len() / 3]).unwrap();
        assert!(hash_file(&path.display().to_string()).is_none());
    }

    #[test]
    fn an_empty_file_is_skipped() {
        let dir = temp_dir("empty");
        let path = dir.join("empty.png");
        std::fs::write(&path, b"").unwrap();
        assert!(hash_file(&path.display().to_string()).is_none());
    }

    /// A hash has to actually depend on the pixels. Without this, every test
    /// above could pass with a constant.
    #[test]
    fn hashes_are_not_constant() {
        let dir = temp_dir("varies");
        let a = hash_file(&save(&dir, "a.png", &subject(320, 240), ImageFormat::Png)).unwrap();
        let b = hash_file(&save(
            &dir,
            "b.png",
            &other_subject(320, 240),
            ImageFormat::Png,
        ))
        .unwrap();
        assert_ne!(a.phash, b.phash);
        assert_ne!(a.dhash, b.dhash);
        assert_ne!(a.phash, [0_u8; 8], "an all-zero hash means the DCT did nothing");
    }

    // ---- end to end, through the populator and the discovery table ----

    use crate::index::schema::ALL_MIGRATIONS;
    use crate::ontology::discoveries::list_pending_by_kind;
    use crate::ontology::populators::BudgetTier;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    fn migrated_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        for (_, sql) in ALL_MIGRATIONS {
            conn.execute_batch(sql).unwrap();
        }
        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
             VALUES (1, NULL, '/root', 'root', 0, 0)",
            [],
        )
        .unwrap();
        conn
    }

    fn context() -> PopulatorContext {
        PopulatorContext::new(BudgetTier::AllOptIn, Arc::new(AtomicBool::new(false)))
    }

    fn seed_file(conn: &Connection, id: i64, path: &str, extension: &str) {
        let size = std::fs::metadata(path).map(|m| m.len() as i64).unwrap_or(0);
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, extension, size, indexed_at)
             VALUES (?1, 1, ?2, ?3, ?4, ?5, 0)",
            (id, path, format!("file-{id}.{extension}"), extension, size),
        )
        .unwrap();
    }

    #[test]
    fn populator_stores_hashes_for_decodable_images_only() {
        let dir = temp_dir("populator-filter");
        let mut conn = migrated_conn();

        let real = save(&dir, "one.png", &subject(240, 180), ImageFormat::Png);
        let text_path = dir.join("notes.txt");
        std::fs::write(&text_path, b"hello").unwrap();
        // Named like an image, is not one. The candidate query still picks it
        // up; the header check is what rejects it.
        let liar = dir.join("liar.jpg");
        std::fs::write(&liar, b"still not an image").unwrap();

        seed_file(&conn, 1, &real, "png");
        seed_file(&conn, 2, &text_path.display().to_string(), "txt");
        seed_file(&conn, 3, &liar.display().to_string(), "jpg");

        PerceptualHashPopulator::new()
            .run(&mut conn, &mut context(), None)
            .unwrap();

        let hashed: Vec<i64> = conn
            .prepare("SELECT file_id FROM ontology_perceptual_hashes ORDER BY file_id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(hashed, vec![1], "only the real image may be hashed");
    }

    #[test]
    fn the_same_picture_in_two_formats_emits_one_discovery() {
        let dir = temp_dir("populator-pair");
        let mut conn = migrated_conn();
        let image = subject(320, 240);
        seed_file(&conn, 1, &save(&dir, "a.png", &image, ImageFormat::Png), "png");
        seed_file(&conn, 2, &save(&dir, "a.jpg", &image, ImageFormat::Jpeg), "jpg");

        let mut ctx = context();
        PerceptualHashPopulator::new()
            .run(&mut conn, &mut ctx, None)
            .unwrap();

        let discoveries = list_pending_by_kind(&conn, "near-duplicate-cluster", 10).unwrap();
        assert_eq!(discoveries.len(), 1);
        assert!(discoveries[0].payload.contains("\"file_id\":1"));
        assert!(discoveries[0].payload.contains("\"file_id\":2"));
        assert_eq!(ctx.snapshot().discoveries_emitted, 1);
    }

    #[test]
    fn two_different_pictures_emit_no_discovery() {
        let dir = temp_dir("populator-distinct");
        let mut conn = migrated_conn();
        seed_file(
            &conn,
            1,
            &save(&dir, "bands.png", &subject(320, 240), ImageFormat::Png),
            "png",
        );
        seed_file(
            &conn,
            2,
            &save(&dir, "rings.png", &other_subject(320, 240), ImageFormat::Png),
            "png",
        );

        PerceptualHashPopulator::new()
            .run(&mut conn, &mut context(), None)
            .unwrap();

        let discoveries = list_pending_by_kind(&conn, "near-duplicate-cluster", 10).unwrap();
        assert!(
            discoveries.is_empty(),
            "different pictures must not be offered as near-duplicates"
        );
    }

    #[test]
    fn rerun_does_not_duplicate_the_discovery() {
        let dir = temp_dir("populator-rerun");
        let mut conn = migrated_conn();
        let image = subject(320, 240);
        seed_file(&conn, 1, &save(&dir, "a.png", &image, ImageFormat::Png), "png");
        seed_file(&conn, 2, &save(&dir, "b.png", &image, ImageFormat::Png), "png");

        for _ in 0..2 {
            PerceptualHashPopulator::new()
                .run(&mut conn, &mut context(), None)
                .unwrap();
        }

        let discoveries = list_pending_by_kind(&conn, "near-duplicate-cluster", 10).unwrap();
        assert_eq!(discoveries.len(), 1);
    }

    #[test]
    fn populator_is_expensive_cost() {
        assert_eq!(
            PerceptualHashPopulator::new().cost_tier(),
            CostTier::Expensive
        );
    }
}
