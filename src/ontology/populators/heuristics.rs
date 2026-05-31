//! Structural heuristic populator emitting DiscoveryPattern rows for
//! sibling-derivedFrom, cross-folder backupOf, and replaceability inferences.

use crate::ontology::discoveries::{insert_discovery, NewDiscovery};
use crate::ontology::populators::{
    emit_property, CostTier, Populator, PopulatorContext, PopulatorError, PopulatorOutcome,
};
use crate::ontology::vocabulary::keys;
use regex::Regex;
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;

const FOLDER_BATCH_SIZE: i64 = 50;

pub struct StructuralHeuristicPopulator;

impl StructuralHeuristicPopulator {
    pub fn new() -> Self {
        Self
    }
}

#[derive(Serialize)]
struct DerivedFromPatternPayload {
    derivative_file_id: i64,
    source_file_id: i64,
    derivative_path: String,
    source_path: String,
    size_ratio: f64,
}

#[derive(Serialize)]
struct BackupOfPairPayload {
    backup_file_id: i64,
    origin_file_id: i64,
    backup_path: String,
    origin_path: String,
    size_ratio: f64,
}

#[derive(Debug, Clone)]
struct SiblingFile {
    id: i64,
    path: String,
    name: String,
    extension: Option<String>,
    size: i64,
    modified_at: Option<i64>,
}

impl Populator for StructuralHeuristicPopulator {
    fn name(&self) -> &'static str {
        "StructuralHeuristicPopulator"
    }

    fn cost_tier(&self) -> CostTier {
        CostTier::Cheap
    }

    fn run(
        &self,
        conn: &mut Connection,
        ctx: &mut PopulatorContext,
        resume_cursor: Option<&str>,
    ) -> Result<PopulatorOutcome, PopulatorError> {
        let mut last_folder_id = resume_cursor
            .and_then(|cursor| cursor.parse::<i64>().ok())
            .unwrap_or(0);

        loop {
            if ctx.is_paused() {
                return Ok(PopulatorOutcome::Paused {
                    cursor: last_folder_id.to_string(),
                    partial: ctx.snapshot(),
                });
            }

            let folder_ids = load_folder_batch(conn, last_folder_id)?;
            if folder_ids.is_empty() {
                break;
            }

            for folder_id in folder_ids {
                let siblings = load_siblings(conn, folder_id)?;
                for f1 in &siblings {
                    ctx.note_file();
                    for f2 in &siblings {
                        if let Some((size_ratio, _stem)) = sibling_derivedfrom_match(f1, f2) {
                            if pair_already_rejected(conn, f2.id, "derivedFrom", f1.id, ctx)? {
                                continue;
                            }

                            let payload = DerivedFromPatternPayload {
                                derivative_file_id: f2.id,
                                source_file_id: f1.id,
                                derivative_path: f2.path.clone(),
                                source_path: f1.path.clone(),
                                size_ratio,
                            };
                            let payload_json = serde_json::to_string(&payload)?;
                            let inserted = insert_discovery_if_absent(
                                conn,
                                &NewDiscovery {
                                    kind: "derivedFrom-pattern",
                                    payload_json: &payload_json,
                                    confidence: score_derivedfrom_pair(f1, f2, size_ratio),
                                    potential_bytes_unlocked: f2.size.max(0) as u64,
                                },
                            )?;
                            if inserted {
                                ctx.note_discovery();
                            }
                        }
                    }
                }
                last_folder_id = folder_id;
            }
        }

        if ctx.is_paused() {
            return Ok(PopulatorOutcome::Paused {
                cursor: last_folder_id.to_string(),
                partial: ctx.snapshot(),
            });
        }

        if emit_cross_folder_backups(conn, ctx)? {
            return Ok(PopulatorOutcome::Paused {
                cursor: last_folder_id.to_string(),
                partial: ctx.snapshot(),
            });
        }

        if ctx.is_paused() {
            return Ok(PopulatorOutcome::Paused {
                cursor: last_folder_id.to_string(),
                partial: ctx.snapshot(),
            });
        }

        if emit_replaceability_inferences(conn, ctx)? {
            return Ok(PopulatorOutcome::Paused {
                cursor: last_folder_id.to_string(),
                partial: ctx.snapshot(),
            });
        }

        Ok(PopulatorOutcome::Completed(ctx.snapshot()))
    }
}

fn load_folder_batch(conn: &Connection, after_id: i64) -> Result<Vec<i64>, PopulatorError> {
    let mut stmt = conn.prepare(
        "SELECT id
         FROM folders
         WHERE id > ?1
         ORDER BY id ASC
         LIMIT ?2",
    )?;
    let rows = stmt.query_map((after_id, FOLDER_BATCH_SIZE), |row| row.get(0))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn load_siblings(conn: &Connection, folder_id: i64) -> Result<Vec<SiblingFile>, PopulatorError> {
    let mut stmt = conn.prepare(
        "SELECT id, path, name, extension, size, modified_at
         FROM files
         WHERE folder_id = ?1 AND deleted_at IS NULL
         ORDER BY id ASC",
    )?;
    let rows = stmt.query_map([folder_id], |row| {
        Ok(SiblingFile {
            id: row.get(0)?,
            path: row.get(1)?,
            name: row.get(2)?,
            extension: row.get(3)?,
            size: row.get(4)?,
            modified_at: row.get(5)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn sibling_derivedfrom_match(f1: &SiblingFile, f2: &SiblingFile) -> Option<(f64, String)> {
    let stem1 = normalize_stem(&f1.name);
    let stem2 = normalize_stem(&f2.name);
    if stem1.is_empty() || !derived_stem_matches(&stem1, &stem2) {
        return None;
    }
    if f1.name.eq_ignore_ascii_case(&f2.name) {
        return None;
    }
    if extensions_equal(f1.extension.as_deref(), f2.extension.as_deref()) {
        return None;
    }
    if f2.modified_at? <= f1.modified_at? {
        return None;
    }
    if f1.size <= 0 || f2.size <= 0 {
        return None;
    }

    let ratio = f2.size as f64 / f1.size as f64;
    if !(0.05..=50.0).contains(&ratio) {
        return None;
    }

    Some((ratio, stem1))
}

fn derived_stem_matches(source_stem: &str, derivative_stem: &str) -> bool {
    if derivative_stem == source_stem {
        return true;
    }
    derivative_stem
        .strip_prefix(source_stem)
        .and_then(|rest| rest.chars().next())
        .map(|next| matches!(next, ' ' | '_' | '-' | '.' | '(' | '['))
        .unwrap_or(false)
}

fn normalize_stem(name: &str) -> String {
    let trimmed = name.trim();
    let without_extension = trimmed.rsplit_once('.').map_or(trimmed, |(stem, _)| stem);
    without_extension.trim().to_lowercase()
}

fn extensions_equal(left: Option<&str>, right: Option<&str>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => left.eq_ignore_ascii_case(right),
        (None, None) => true,
        _ => false,
    }
}

fn score_derivedfrom_pair(f1: &SiblingFile, f2: &SiblingFile, size_ratio: f64) -> f32 {
    let mut score: f32 = 0.5;
    if (0.1..=1.0).contains(&size_ratio) {
        score += 0.2;
    }
    if extension_in(f1.extension.as_deref(), &["psd", "ai"]) {
        score += 0.15;
    }
    if extension_in(f2.extension.as_deref(), &["png", "jpg", "jpeg"]) {
        score += 0.1;
    }
    score.min(0.95)
}

fn extension_in(extension: Option<&str>, candidates: &[&str]) -> bool {
    extension
        .map(|extension| {
            candidates
                .iter()
                .any(|candidate| extension.eq_ignore_ascii_case(candidate))
        })
        .unwrap_or(false)
}

fn pair_already_rejected(
    conn: &Connection,
    subject_file_id: i64,
    predicate: &str,
    object_file_id: i64,
    ctx: &mut PopulatorContext,
) -> Result<bool, PopulatorError> {
    let Some(subject_id) = entity_id_for_file(conn, subject_file_id)? else {
        return Ok(false);
    };
    let Some(object_id) = entity_id_for_file(conn, object_file_id)? else {
        return Ok(false);
    };

    let rejected =
        crate::ontology::negative::is_rejected_pair(conn, subject_id, predicate, object_id)?;
    if rejected {
        ctx.note_skipped();
    }
    Ok(rejected)
}

fn entity_id_for_file(conn: &Connection, file_id: i64) -> Result<Option<i64>, PopulatorError> {
    Ok(conn
        .query_row(
            "SELECT id
             FROM ontology_entities
             WHERE kind = 'File' AND linked_file_id = ?1
             LIMIT 1",
            [file_id],
            |row| row.get(0),
        )
        .optional()?)
}

fn insert_discovery_if_absent(
    conn: &Connection,
    discovery: &NewDiscovery<'_>,
) -> Result<bool, PopulatorError> {
    let exists = conn
        .query_row(
            "SELECT 1
             FROM ontology_discoveries
             WHERE kind = ?1 AND payload = ?2
             LIMIT 1",
            (discovery.kind, discovery.payload_json),
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if exists {
        return Ok(false);
    }

    insert_discovery(conn, discovery)?;
    Ok(true)
}

fn emit_cross_folder_backups(
    conn: &mut Connection,
    ctx: &mut PopulatorContext,
) -> Result<bool, PopulatorError> {
    let backups = {
        let mut stmt = conn.prepare(
            "SELECT DISTINCT f.id, f.path, f.name, f.extension, f.size, f.modified_at
             FROM files f
             JOIN ontology_entities e ON e.kind = 'File' AND e.linked_file_id = f.id
             JOIN ontology_attrs a ON a.entity_id = e.id
             WHERE f.deleted_at IS NULL AND a.key = ?1 AND a.value = 'backup'
             ORDER BY f.id ASC",
        )?;
        let rows = stmt.query_map([keys::ROLE], |row| {
            Ok(SiblingFile {
                id: row.get(0)?,
                path: row.get(1)?,
                name: row.get(2)?,
                extension: row.get(3)?,
                size: row.get(4)?,
                modified_at: row.get(5)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    for backup in backups {
        if ctx.is_paused() {
            return Ok(true);
        }

        let lookup_stem = backup_origin_lookup_stem(&backup.name);
        if lookup_stem.is_empty() || backup.size <= 0 {
            continue;
        }
        let like_pattern = format!("{lookup_stem}%");
        let origins = load_backup_origin_candidates(conn, &backup, &lookup_stem, &like_pattern)?;

        for origin in origins {
            if ctx.is_paused() {
                return Ok(true);
            }

            if pair_already_rejected(conn, backup.id, "backupOf", origin.id, ctx)? {
                continue;
            }
            let size_ratio = backup.size as f64 / origin.size as f64;
            let payload = BackupOfPairPayload {
                backup_file_id: backup.id,
                origin_file_id: origin.id,
                backup_path: backup.path.clone(),
                origin_path: origin.path,
                size_ratio,
            };
            let payload_json = serde_json::to_string(&payload)?;
            let inserted = insert_discovery_if_absent(
                conn,
                &NewDiscovery {
                    kind: "backupOf-pair",
                    payload_json: &payload_json,
                    confidence: 0.7,
                    potential_bytes_unlocked: backup.size.max(0) as u64,
                },
            )?;
            if inserted {
                ctx.note_discovery();
            }
        }
    }

    Ok(false)
}

fn load_backup_origin_candidates(
    conn: &Connection,
    backup: &SiblingFile,
    lookup_stem: &str,
    like_pattern: &str,
) -> Result<Vec<SiblingFile>, PopulatorError> {
    let mut stmt = conn.prepare(
        "SELECT f.id, f.path, f.name, f.extension, f.size, f.modified_at
         FROM files f
         JOIN files b ON b.id = ?1
         WHERE f.deleted_at IS NULL
           AND f.id != ?1
           AND f.folder_id != b.folder_id
           AND lower(f.name) LIKE ?2
           AND f.size > 0
         ORDER BY f.id ASC",
    )?;
    let rows = stmt.query_map((backup.id, like_pattern), |row| {
        Ok(SiblingFile {
            id: row.get(0)?,
            path: row.get(1)?,
            name: row.get(2)?,
            extension: row.get(3)?,
            size: row.get(4)?,
            modified_at: row.get(5)?,
        })
    })?;
    let candidates = rows.collect::<Result<Vec<_>, _>>()?;
    let mut filtered = Vec::new();
    for origin in candidates {
        let origin_stem = normalize_stem(&origin.name);
        let ratio = backup.size as f64 / origin.size as f64;
        if (0.5..=2.0).contains(&ratio)
            && backup_origin_stem_matches(lookup_stem, &origin_stem)
            && !backup_like_stem(&origin_stem)
            && !file_has_role(conn, origin.id, "backup")?
        {
            filtered.push(origin);
        }
    }
    Ok(filtered)
}

fn backup_origin_lookup_stem(name: &str) -> String {
    let mut stem = normalize_stem(name);
    for suffix in BACKUP_SUFFIXES {
        if let Some(stripped) = stem.strip_suffix(suffix) {
            stem = stripped.trim().to_string();
            break;
        }
    }
    stem
}

const BACKUP_SUFFIXES: &[&str] = &[" backup", "_backup", "-backup", " copy", "_copy", "-copy"];

fn backup_like_stem(stem: &str) -> bool {
    BACKUP_SUFFIXES.iter().any(|suffix| stem.ends_with(suffix))
}

fn backup_origin_stem_matches(lookup_stem: &str, origin_stem: &str) -> bool {
    lookup_stem.len() >= 3
        && (origin_stem == lookup_stem
            || origin_stem.starts_with(&format!("{lookup_stem} "))
            || origin_stem.starts_with(&format!("{lookup_stem}_"))
            || origin_stem.starts_with(&format!("{lookup_stem}-")))
}

fn file_has_role(conn: &Connection, file_id: i64, role: &str) -> Result<bool, PopulatorError> {
    Ok(conn
        .query_row(
            "SELECT 1
             FROM ontology_entities e
             JOIN ontology_attrs a ON a.entity_id = e.id
             WHERE e.kind = 'File'
               AND e.linked_file_id = ?1
               AND a.key = ?2
               AND a.value = ?3
             LIMIT 1",
            (file_id, keys::ROLE, role),
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

fn emit_replaceability_inferences(
    conn: &mut Connection,
    ctx: &mut PopulatorContext,
) -> Result<bool, PopulatorError> {
    let regenerable_entities = {
        let mut stmt = conn.prepare(
            "SELECT DISTINCT e.id
             FROM ontology_entities e
             JOIN files f ON f.id = e.linked_file_id
             JOIN ontology_attrs a ON a.entity_id = e.id
             JOIN ontology_relations r ON r.subject_id = e.id
             WHERE e.kind = 'File'
               AND f.deleted_at IS NULL
               AND a.key = ?1
               AND a.value = 'derivative'
               AND r.predicate = 'derivedFrom'",
        )?;
        let rows = stmt.query_map([keys::ROLE], |row| row.get(0))?;
        rows.collect::<Result<Vec<i64>, _>>()?
    };

    for entity_id in regenerable_entities {
        if ctx.is_paused() {
            return Ok(true);
        }

        emit_property(
            conn,
            ctx,
            entity_id,
            keys::REPLACEABILITY,
            "regenerable",
            "heuristic:replaceability-from-derivedfrom",
            0.95,
            true,
        )?;
    }

    let redownloadable_entities = {
        let mut stmt = conn.prepare(
            "SELECT DISTINCT e.id, f.name
             FROM ontology_entities e
             JOIN files f ON f.id = e.linked_file_id
             JOIN ontology_attrs a ON a.entity_id = e.id
             WHERE e.kind = 'File'
               AND f.deleted_at IS NULL
               AND a.key = ?1
               AND a.value = 'tool'",
        )?;
        let rows = stmt.query_map([keys::ROLE], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    let installer_name = Regex::new(r"(?i)(setup|installer|install[_ .-]?)")
        .map_err(|err| PopulatorError::Aborted(format!("bad installer regex: {err}")))?;
    for (entity_id, name) in redownloadable_entities {
        if ctx.is_paused() {
            return Ok(true);
        }

        if installer_name.is_match(&name) {
            emit_property(
                conn,
                ctx,
                entity_id,
                keys::REPLACEABILITY,
                "redownloadable",
                "heuristic:replaceability-from-installer-name",
                0.6,
                true,
            )?;
        }
    }

    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::schema::ALL_MIGRATIONS;
    use crate::ontology::attrs::{assert_attr, get_attrs, NewAssertion};
    use crate::ontology::discoveries::list_pending_by_kind;
    use crate::ontology::populators::{
        ensure_file_entity, BudgetTier, PopulatorContext, PopulatorOutcome,
    };
    use crate::ontology::relations::{assert_relation, NewRelation};
    use crate::ontology::vocabulary::{keys, predicates};
    use rusqlite::Connection;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    fn migrated_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        for (_, sql) in ALL_MIGRATIONS {
            conn.execute_batch(sql).unwrap();
        }
        conn
    }

    fn ctx_no_pause() -> PopulatorContext {
        PopulatorContext::new(BudgetTier::Standard, Arc::new(AtomicBool::new(false)))
    }

    fn insert_folder(conn: &Connection, id: i64, path: &str, name: &str) {
        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
             VALUES (?1, NULL, ?2, ?3, 0, 0)",
            (id, path, name),
        )
        .unwrap();
    }

    fn insert_file(
        conn: &Connection,
        id: i64,
        folder_id: i64,
        path: &str,
        name: &str,
        extension: Option<&str>,
        size: i64,
        modified_at: Option<i64>,
    ) {
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, extension, size, modified_at, indexed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)",
            (id, folder_id, path, name, extension, size, modified_at),
        )
        .unwrap();
    }

    #[test]
    fn normalize_stem_strips_extension_lowercases_trims() {
        assert_eq!(normalize_stem("  Design Final.PSD  "), "design final");
    }

    #[test]
    fn sibling_derivedfrom_pair_emits_discovery() {
        let mut conn = migrated_conn();
        insert_folder(&conn, 1, "/root", "root");
        insert_file(
            &conn,
            1,
            1,
            "/root/logo.psd",
            "logo.psd",
            Some("psd"),
            1_000,
            Some(100),
        );
        insert_file(
            &conn,
            2,
            1,
            "/root/logo export.png",
            "logo export.png",
            Some("png"),
            200,
            Some(200),
        );

        let mut ctx = ctx_no_pause();
        let outcome = StructuralHeuristicPopulator::new()
            .run(&mut conn, &mut ctx, None)
            .unwrap();

        assert!(matches!(outcome, PopulatorOutcome::Completed(_)));
        let discoveries = list_pending_by_kind(&conn, "derivedFrom-pattern", 10).unwrap();
        assert_eq!(discoveries.len(), 1);
        assert_eq!(discoveries[0].potential_bytes_unlocked, 200);
        assert_eq!(ctx.snapshot().discoveries_emitted, 1);
    }

    #[test]
    fn rerun_does_not_duplicate_derivedfrom_discovery() {
        let mut conn = migrated_conn();
        insert_folder(&conn, 1, "/root", "root");
        insert_file(
            &conn,
            1,
            1,
            "/root/logo.psd",
            "logo.psd",
            Some("psd"),
            1_000,
            Some(100),
        );
        insert_file(
            &conn,
            2,
            1,
            "/root/logo export.png",
            "logo export.png",
            Some("png"),
            200,
            Some(200),
        );

        let mut first_ctx = ctx_no_pause();
        StructuralHeuristicPopulator::new()
            .run(&mut conn, &mut first_ctx, None)
            .unwrap();
        let mut second_ctx = ctx_no_pause();
        StructuralHeuristicPopulator::new()
            .run(&mut conn, &mut second_ctx, None)
            .unwrap();

        let discoveries = list_pending_by_kind(&conn, "derivedFrom-pattern", 10).unwrap();
        assert_eq!(discoveries.len(), 1);
        assert_eq!(second_ctx.snapshot().discoveries_emitted, 0);
    }

    #[test]
    fn sibling_derivedfrom_requires_later_mtime() {
        let source = sibling(1, "work.psd", Some("psd"), 100, Some(200));
        let derivative = sibling(2, "work.png", Some("png"), 10, Some(100));

        assert!(sibling_derivedfrom_match(&source, &derivative).is_none());
    }

    #[test]
    fn sibling_derivedfrom_size_ratio_must_be_in_bounds() {
        let source = sibling(1, "work.psd", Some("psd"), 100, Some(100));
        let too_small = sibling(2, "work.png", Some("png"), 4, Some(200));
        let too_large = sibling(3, "work.jpg", Some("jpg"), 5_001, Some(200));

        assert!(sibling_derivedfrom_match(&source, &too_small).is_none());
        assert!(sibling_derivedfrom_match(&source, &too_large).is_none());
    }

    #[test]
    fn sibling_derivedfrom_requires_delimiter_after_source_stem() {
        let source = sibling(1, "art.psd", Some("psd"), 100, Some(100));
        let derivative = sibling(2, "artifact.png", Some("png"), 90, Some(200));

        assert!(sibling_derivedfrom_match(&source, &derivative).is_none());
    }

    #[test]
    fn paused_before_run_returns_cursor_zero() {
        let mut conn = migrated_conn();
        insert_folder(&conn, 1, "/root", "root");
        let pause = Arc::new(AtomicBool::new(true));
        let mut ctx = PopulatorContext::new(BudgetTier::Standard, pause);

        let outcome = StructuralHeuristicPopulator::new()
            .run(&mut conn, &mut ctx, None)
            .unwrap();

        assert!(matches!(
            outcome,
            PopulatorOutcome::Paused { ref cursor, .. } if cursor == "0"
        ));
    }

    #[test]
    fn cross_folder_backup_emits_pair_discovery() {
        let mut conn = migrated_conn();
        insert_folder(&conn, 1, "/root/originals", "originals");
        insert_folder(&conn, 2, "/root/backup", "backup");
        insert_file(
            &conn,
            1,
            1,
            "/root/originals/budget.xlsx",
            "budget.xlsx",
            Some("xlsx"),
            1_000,
            Some(100),
        );
        insert_file(
            &conn,
            2,
            2,
            "/root/backup/budget.xlsx",
            "budget.xlsx",
            Some("xlsx"),
            1_100,
            Some(200),
        );
        let backup_entity = ensure_file_entity(&conn, 2, "/root/backup/budget.xlsx").unwrap();
        assert_attr(
            &conn,
            backup_entity.id,
            &NewAssertion {
                key: keys::ROLE,
                value: "backup",
                source: "test",
                confidence: 1.0,
                display_in_global_views: true,
            },
        )
        .unwrap();

        let mut ctx = ctx_no_pause();
        StructuralHeuristicPopulator::new()
            .run(&mut conn, &mut ctx, None)
            .unwrap();

        let discoveries = list_pending_by_kind(&conn, "backupOf-pair", 10).unwrap();
        assert_eq!(discoveries.len(), 1);
        assert_eq!(discoveries[0].potential_bytes_unlocked, 1_100);
    }

    #[test]
    fn cross_folder_backup_matches_backup_suffix_to_origin_stem() {
        let mut conn = migrated_conn();
        insert_folder(&conn, 1, "/Active", "Active");
        insert_folder(&conn, 2, "/Backup", "Backup");
        insert_file(
            &conn,
            1,
            1,
            "/Active/budget.xlsx",
            "budget.xlsx",
            Some("xlsx"),
            1_000,
            Some(100),
        );
        insert_file(
            &conn,
            2,
            2,
            "/Backup/budget backup.xlsx",
            "budget backup.xlsx",
            Some("xlsx"),
            1_050,
            Some(200),
        );
        let backup_entity = ensure_file_entity(&conn, 2, "/Backup/budget backup.xlsx").unwrap();
        assert_attr(
            &conn,
            backup_entity.id,
            &NewAssertion {
                key: keys::ROLE,
                value: "backup",
                source: "test",
                confidence: 1.0,
                display_in_global_views: true,
            },
        )
        .unwrap();

        let mut ctx = ctx_no_pause();
        StructuralHeuristicPopulator::new()
            .run(&mut conn, &mut ctx, None)
            .unwrap();

        let discoveries = list_pending_by_kind(&conn, "backupOf-pair", 10).unwrap();
        assert_eq!(discoveries.len(), 1);
        assert!(discoveries[0].payload.contains("\"origin_file_id\":1"));
        assert!(discoveries[0].payload.contains("\"backup_file_id\":2"));
    }

    #[test]
    fn backup_discovery_never_points_to_backup_like_origin() {
        let mut conn = migrated_conn();
        insert_folder(&conn, 1, "/Active", "Active");
        insert_folder(&conn, 2, "/BackupOne", "BackupOne");
        insert_folder(&conn, 3, "/BackupTwo", "BackupTwo");
        insert_file(
            &conn,
            1,
            1,
            "/Active/budget.xlsx",
            "budget.xlsx",
            Some("xlsx"),
            1_000,
            Some(100),
        );
        insert_file(
            &conn,
            2,
            2,
            "/BackupOne/budget backup.xlsx",
            "budget backup.xlsx",
            Some("xlsx"),
            1_050,
            Some(200),
        );
        insert_file(
            &conn,
            3,
            3,
            "/BackupTwo/budget copy.xlsx",
            "budget copy.xlsx",
            Some("xlsx"),
            950,
            Some(300),
        );
        for (id, path) in [
            (2, "/BackupOne/budget backup.xlsx"),
            (3, "/BackupTwo/budget copy.xlsx"),
        ] {
            let backup_entity = ensure_file_entity(&conn, id, path).unwrap();
            assert_attr(
                &conn,
                backup_entity.id,
                &NewAssertion {
                    key: keys::ROLE,
                    value: "backup",
                    source: "test",
                    confidence: 1.0,
                    display_in_global_views: true,
                },
            )
            .unwrap();
        }

        let mut ctx = ctx_no_pause();
        StructuralHeuristicPopulator::new()
            .run(&mut conn, &mut ctx, None)
            .unwrap();

        let discoveries = list_pending_by_kind(&conn, "backupOf-pair", 10).unwrap();
        assert!(!discoveries.is_empty());
        for discovery in discoveries {
            assert!(!discovery.payload.contains("\"origin_file_id\":2"));
            assert!(!discovery.payload.contains("\"origin_file_id\":3"));
        }
    }

    #[test]
    fn replaceability_inference_for_derivative_with_derivedfrom() {
        let mut conn = migrated_conn();
        insert_folder(&conn, 1, "/root", "root");
        insert_file(
            &conn,
            1,
            1,
            "/root/work.psd",
            "work.psd",
            Some("psd"),
            1_000,
            Some(100),
        );
        insert_file(
            &conn,
            2,
            1,
            "/root/work.png",
            "work.png",
            Some("png"),
            100,
            Some(200),
        );
        let source = ensure_file_entity(&conn, 1, "/root/work.psd").unwrap();
        let derivative = ensure_file_entity(&conn, 2, "/root/work.png").unwrap();
        assert_attr(
            &conn,
            derivative.id,
            &NewAssertion {
                key: keys::ROLE,
                value: "derivative",
                source: "test",
                confidence: 1.0,
                display_in_global_views: true,
            },
        )
        .unwrap();
        assert_relation(
            &conn,
            &NewRelation {
                subject_id: derivative.id,
                predicate: predicates::DERIVED_FROM,
                object_id: source.id,
                source: "test",
                confidence: 1.0,
            },
        )
        .unwrap();

        let mut ctx = ctx_no_pause();
        StructuralHeuristicPopulator::new()
            .run(&mut conn, &mut ctx, None)
            .unwrap();

        let attrs = get_attrs(&conn, derivative.id, keys::REPLACEABILITY).unwrap();
        assert_eq!(attrs.len(), 1);
        assert_eq!(attrs[0].value, "regenerable");
        assert_eq!(attrs[0].source, "heuristic:replaceability-from-derivedfrom");
    }

    #[test]
    fn replaceability_inference_for_tool_named_install_exe() {
        let mut conn = migrated_conn();
        insert_folder(&conn, 1, "/root", "root");
        insert_file(
            &conn,
            1,
            1,
            "/root/install.exe",
            "install.exe",
            Some("exe"),
            1_000,
            Some(100),
        );
        let tool = ensure_file_entity(&conn, 1, "/root/install.exe").unwrap();
        assert_attr(
            &conn,
            tool.id,
            &NewAssertion {
                key: keys::ROLE,
                value: "tool",
                source: "test",
                confidence: 1.0,
                display_in_global_views: true,
            },
        )
        .unwrap();

        let mut ctx = ctx_no_pause();
        StructuralHeuristicPopulator::new()
            .run(&mut conn, &mut ctx, None)
            .unwrap();

        let attrs = get_attrs(&conn, tool.id, keys::REPLACEABILITY).unwrap();
        assert_eq!(attrs.len(), 1);
        assert_eq!(attrs[0].value, "redownloadable");
        assert_eq!(
            attrs[0].source,
            "heuristic:replaceability-from-installer-name"
        );
    }

    fn sibling(
        id: i64,
        name: &str,
        extension: Option<&str>,
        size: i64,
        modified_at: Option<i64>,
    ) -> SiblingFile {
        SiblingFile {
            id,
            path: format!("/root/{name}"),
            name: name.to_string(),
            extension: extension.map(str::to_string),
            size,
            modified_at,
        }
    }
}
