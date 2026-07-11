//! Lightweight metadata extractors for opt-in Phase 2 enrichment.
//!
//! This module intentionally avoids heavy parsing dependencies. It extracts a
//! conservative Wave-1 subset from common container headers and skips files it
//! cannot read or confidently parse.

use crate::ontology::attrs::resolve_attr;
use crate::ontology::populators::{
    emit_property, ensure_file_entity, CostTier, Populator, PopulatorContext, PopulatorError,
    PopulatorOutcome,
};
use crate::ontology::vocabulary::{keys, Sensitivity};
use rusqlite::Connection;
use std::fs;

const BATCH_SIZE: i64 = 200;
const MAX_EXTRACT_BYTES: usize = 2 * 1024 * 1024;

pub const KEY_TITLE: &str = "title";
pub const KEY_ARTIST: &str = "artist";
pub const KEY_ALBUM: &str = "album";
pub const KEY_CAPTURED_AT: &str = "capturedAt";
pub const KEY_ARCHIVE_ENTRY_COUNT: &str = "archiveEntryCount";

pub struct MetadataExtractorPopulator;

impl MetadataExtractorPopulator {
    pub fn new() -> Self {
        Self
    }
}

impl Populator for MetadataExtractorPopulator {
    fn name(&self) -> &'static str {
        "MetadataExtractorPopulator"
    }

    fn cost_tier(&self) -> CostTier {
        CostTier::Medium
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

            let files = load_batch(conn, last_id)?;
            if files.is_empty() {
                return Ok(PopulatorOutcome::Completed(ctx.snapshot()));
            }

            for file in files {
                ctx.note_file();
                let entity = ensure_file_entity(conn, file.id, &file.path)?;
                let display_in_global_views = extracted_metadata_is_global(conn, entity.id)?;
                let facts = extract_facts(&file)?;

                for fact in facts {
                    emit_property(
                        conn,
                        ctx,
                        entity.id,
                        fact.key,
                        &fact.value,
                        fact.source,
                        fact.confidence,
                        display_in_global_views,
                    )?;
                }

                last_id = file.id;
            }
        }
    }
}

fn load_batch(conn: &Connection, after_id: i64) -> Result<Vec<FileRow>, PopulatorError> {
    let mut stmt = conn.prepare(
        "SELECT id, path, extension
         FROM files
         WHERE id > ?1 AND deleted_at IS NULL
         ORDER BY id ASC
         LIMIT ?2",
    )?;
    let rows = stmt.query_map((after_id, BATCH_SIZE), |row| {
        Ok(FileRow {
            id: row.get(0)?,
            path: row.get(1)?,
            extension: row.get(2)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn extracted_metadata_is_global(conn: &Connection, entity_id: i64) -> Result<bool, PopulatorError> {
    let Some(sensitivity) = resolve_attr(conn, entity_id, keys::SENSITIVITY)? else {
        return Ok(true);
    };
    if sensitivity.confidence < 0.5 {
        return Ok(true);
    }
    Ok(Sensitivity::from_str(&sensitivity.value)
        .map(|s| !s.restricted_or_private())
        .unwrap_or(true))
}

fn extract_facts(file: &FileRow) -> Result<Vec<ExtractedFact>, PopulatorError> {
    let Some(extension) = file.extension.as_deref().map(str::to_ascii_lowercase) else {
        return Ok(Vec::new());
    };
    if !matches!(
        extension.as_str(),
        "pdf" | "jpg" | "jpeg" | "zip" | "mp3" | "id3"
    ) {
        return Ok(Vec::new());
    }

    let Ok(bytes) = fs::read(&file.path) else {
        return Ok(Vec::new());
    };
    let bytes = if bytes.len() > MAX_EXTRACT_BYTES {
        &bytes[..MAX_EXTRACT_BYTES]
    } else {
        &bytes
    };

    Ok(match extension.as_str() {
        "pdf" => extract_pdf(bytes),
        "jpg" | "jpeg" => extract_jpeg_exif(bytes),
        "zip" => extract_zip(bytes),
        "mp3" | "id3" => extract_id3(bytes),
        _ => Vec::new(),
    })
}

fn extract_pdf(bytes: &[u8]) -> Vec<ExtractedFact> {
    let text = String::from_utf8_lossy(bytes);
    find_pdf_literal(&text, "/Title")
        .map(|title| {
            vec![ExtractedFact {
                key: KEY_TITLE,
                value: title,
                source: "extractor:pdf",
                confidence: 0.9,
            }]
        })
        .unwrap_or_default()
}

fn find_pdf_literal(text: &str, name: &str) -> Option<String> {
    let start = text.find(name)?;
    let after = &text[start + name.len()..];
    let open = after.find('(')?;
    let mut value = String::new();
    let mut escaped = false;
    for ch in after[open + 1..].chars() {
        if escaped {
            value.push(match ch {
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                other => other,
            });
            escaped = false;
        } else if ch == '\\' {
            escaped = true;
        } else if ch == ')' {
            break;
        } else {
            value.push(ch);
        }
    }
    normalize_text_value(&value)
}

fn extract_jpeg_exif(bytes: &[u8]) -> Vec<ExtractedFact> {
    if !bytes.starts_with(&[0xff, 0xd8]) {
        return Vec::new();
    }
    find_ascii_datetime(bytes)
        .map(|captured| {
            vec![ExtractedFact {
                key: KEY_CAPTURED_AT,
                value: captured,
                source: "extractor:exif",
                confidence: 0.85,
            }]
        })
        .unwrap_or_default()
}

fn find_ascii_datetime(bytes: &[u8]) -> Option<String> {
    bytes
        .windows(19)
        .find(|window| {
            window[4] == b':'
                && window[7] == b':'
                && window[10] == b' '
                && window[13] == b':'
                && window[16] == b':'
                && window
                    .iter()
                    .enumerate()
                    .all(|(idx, byte)| matches!(idx, 4 | 7 | 10 | 13 | 16) || byte.is_ascii_digit())
        })
        .and_then(|window| String::from_utf8(window.to_vec()).ok())
}

fn extract_zip(bytes: &[u8]) -> Vec<ExtractedFact> {
    find_eocd(bytes)
        .map(|offset| u16::from_le_bytes([bytes[offset + 10], bytes[offset + 11]]))
        .map(|entries| {
            vec![
                ExtractedFact {
                    key: KEY_ARCHIVE_ENTRY_COUNT,
                    value: entries.to_string(),
                    source: "extractor:zip-central-directory",
                    confidence: 1.0,
                },
                ExtractedFact {
                    key: keys::ORIGIN,
                    value: "archive-extracted".to_string(),
                    source: "extractor:zip-central-directory",
                    confidence: 0.5,
                },
            ]
        })
        .unwrap_or_default()
}

fn find_eocd(bytes: &[u8]) -> Option<usize> {
    bytes
        .windows(4)
        .rposition(|window| window == b"PK\x05\x06")
        .filter(|offset| offset + 22 <= bytes.len())
}

fn extract_id3(bytes: &[u8]) -> Vec<ExtractedFact> {
    if bytes.len() < 10 || &bytes[..3] != b"ID3" {
        return Vec::new();
    }
    let tag_size = syncsafe_to_usize(&bytes[6..10]).unwrap_or(0);
    let end = (10 + tag_size).min(bytes.len());
    let mut offset = 10;
    let mut facts = Vec::new();

    while offset + 10 <= end {
        let id = &bytes[offset..offset + 4];
        if id.iter().all(|byte| *byte == 0) {
            break;
        }
        let size = syncsafe_to_usize(&bytes[offset + 4..offset + 8])
            .unwrap_or_else(|| u32::from_be_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize);
        offset += 10;
        if size == 0 || offset + size > end {
            break;
        }

        if let Some((key, source)) = id3_key(id) {
            if let Some(value) = decode_id3_text(&bytes[offset..offset + size]) {
                facts.push(ExtractedFact {
                    key,
                    value,
                    source,
                    confidence: 0.9,
                });
            }
        }
        offset += size;
    }

    facts
}

fn id3_key(frame_id: &[u8]) -> Option<(&'static str, &'static str)> {
    match frame_id {
        b"TIT2" => Some((KEY_TITLE, "extractor:id3")),
        b"TPE1" => Some((KEY_ARTIST, "extractor:id3")),
        b"TALB" => Some((KEY_ALBUM, "extractor:id3")),
        _ => None,
    }
}

fn syncsafe_to_usize(bytes: &[u8]) -> Option<usize> {
    if bytes.len() != 4 || bytes.iter().any(|byte| byte & 0x80 != 0) {
        return None;
    }
    Some(
        ((bytes[0] as usize) << 21)
            | ((bytes[1] as usize) << 14)
            | ((bytes[2] as usize) << 7)
            | bytes[3] as usize,
    )
}

fn decode_id3_text(bytes: &[u8]) -> Option<String> {
    let (&encoding, body) = bytes.split_first()?;
    let text = match encoding {
        0 | 3 => String::from_utf8_lossy(body).into_owned(),
        1 | 2 => decode_utf16_lossy(body),
        _ => return None,
    };
    normalize_text_value(&text)
}

fn decode_utf16_lossy(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(&[0xff, 0xfe]).unwrap_or(bytes);
    let bytes = bytes.strip_prefix(&[0xfe, 0xff]).unwrap_or(bytes);
    let units = bytes
        .chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
        .collect::<Vec<_>>();
    String::from_utf16_lossy(&units)
}

fn normalize_text_value(value: &str) -> Option<String> {
    let trimmed = value.trim_matches(char::from(0)).trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[derive(Debug)]
struct FileRow {
    id: i64,
    path: String,
    extension: Option<String>,
}

struct ExtractedFact {
    key: &'static str,
    value: String,
    source: &'static str,
    confidence: f32,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::schema::ALL_MIGRATIONS;
    use crate::ontology::attrs::{assert_attr, get_attrs, NewAssertion};
    use crate::ontology::populators::{BudgetTier, PopulatorContext};
    use rusqlite::Connection;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn migrated_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        for (_, sql) in ALL_MIGRATIONS {
            conn.execute_batch(sql).unwrap();
        }
        conn
    }

    fn ctx() -> PopulatorContext {
        PopulatorContext::new(BudgetTier::Standard, Arc::new(AtomicBool::new(false)))
    }

    fn temp_file(name: &str, bytes: &[u8]) -> String {
        let dir = std::env::temp_dir().join(format!(
            "be-extractor-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        path.to_string_lossy().into_owned()
    }

    fn seed_file(conn: &Connection, id: i64, path: &str, extension: &str) {
        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
             VALUES (1, NULL, '/root', 'root', 0, 0)",
            [],
        )
        .ok();
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, extension, size, indexed_at)
             VALUES (?1, 1, ?2, ?3, ?4, 10, 0)",
            (id, path, format!("file.{extension}"), extension),
        )
        .unwrap();
    }

    #[test]
    fn pdf_title_is_hidden_when_file_is_sensitive() {
        let mut conn = migrated_conn();
        let path = temp_file("secret.pdf", b"%PDF-1.4\n1 0 obj<</Title (UNIQUE_TOKEN_12345)>>endobj");
        seed_file(&conn, 1, &path, "pdf");
        let entity = ensure_file_entity(&conn, 1, &path).unwrap();
        assert_attr(
            &conn,
            entity.id,
            &NewAssertion {
                key: keys::SENSITIVITY,
                value: "restricted",
                source: "rule:test",
                confidence: 1.0,
                display_in_global_views: false,
            },
        )
        .unwrap();

        MetadataExtractorPopulator::new()
            .run(&mut conn, &mut ctx(), None)
            .unwrap();

        let attrs = get_attrs(&conn, entity.id, KEY_TITLE).unwrap();
        assert_eq!(attrs.len(), 1);
        assert_eq!(attrs[0].value, "UNIQUE_TOKEN_12345");
        assert_eq!(attrs[0].source, "extractor:pdf");
        assert!(!attrs[0].display_in_global_views);
    }

    #[test]
    fn zip_entry_count_is_extracted_from_eocd() {
        let mut bytes = b"PK\x03\x04payload".to_vec();
        bytes.extend_from_slice(b"PK\x05\x06");
        bytes.extend_from_slice(&[0, 0, 0, 0]);
        bytes.extend_from_slice(&3u16.to_le_bytes());
        bytes.extend_from_slice(&3u16.to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes());

        let facts = extract_zip(&bytes);
        assert!(facts
            .iter()
            .any(|fact| fact.key == KEY_ARCHIVE_ENTRY_COUNT && fact.value == "3"));
        assert!(facts
            .iter()
            .any(|fact| fact.key == keys::ORIGIN && fact.value == "archive-extracted"));
    }

    #[test]
    fn id3_title_artist_album_are_extracted() {
        let mut body = Vec::new();
        add_id3_text_frame(&mut body, b"TIT2", "Song Title");
        add_id3_text_frame(&mut body, b"TPE1", "Artist Name");
        add_id3_text_frame(&mut body, b"TALB", "Album Name");
        let mut bytes = b"ID3\x04\x00\x00".to_vec();
        bytes.extend_from_slice(&syncsafe(body.len()));
        bytes.extend_from_slice(&body);

        let facts = extract_id3(&bytes);
        assert!(facts.iter().any(|fact| fact.key == KEY_TITLE && fact.value == "Song Title"));
        assert!(facts.iter().any(|fact| fact.key == KEY_ARTIST && fact.value == "Artist Name"));
        assert!(facts.iter().any(|fact| fact.key == KEY_ALBUM && fact.value == "Album Name"));
    }

    #[test]
    fn jpeg_ascii_datetime_is_extracted_as_captured_at() {
        let bytes = b"\xff\xd8\xff\xe1Exif\0\02026:06:08 12:34:56\0";
        let facts = extract_jpeg_exif(bytes);
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].key, KEY_CAPTURED_AT);
        assert_eq!(facts[0].value, "2026:06:08 12:34:56");
    }

    #[test]
    fn populator_is_medium_cost() {
        assert_eq!(MetadataExtractorPopulator::new().cost_tier(), CostTier::Medium);
    }

    fn add_id3_text_frame(body: &mut Vec<u8>, id: &[u8; 4], value: &str) {
        let mut payload = vec![3];
        payload.extend_from_slice(value.as_bytes());
        body.extend_from_slice(id);
        body.extend_from_slice(&syncsafe(payload.len()));
        body.extend_from_slice(&[0, 0]);
        body.extend_from_slice(&payload);
    }

    fn syncsafe(size: usize) -> [u8; 4] {
        [
            ((size >> 21) & 0x7f) as u8,
            ((size >> 14) & 0x7f) as u8,
            ((size >> 7) & 0x7f) as u8,
            (size & 0x7f) as u8,
        ]
    }
}
