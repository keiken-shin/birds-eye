//! Discovery resolution: graduate confirmations into facts, block rejections.
//!
//! Confirming a pattern-level discovery writes user-sourced facts (conf 1.0) and
//! marks the row `confirmed`. Rejecting writes a negative assertion (invariant
//! #10) and marks the row `rejected`. Pattern-level confirm requires median
//! pending confidence >= 0.7 (invariant #7).

use crate::ontology::attrs::{assert_attr, NewAssertion};
use crate::ontology::discoveries::{get_discovery, list_pending_by_kind, Discovery, DiscoveryStatus};
use crate::ontology::entities::find_entity_for_file;
use crate::ontology::negative::reject_pair;
use crate::ontology::relations::{assert_relation, NewRelation};
use crate::ontology::vocabulary::{keys, predicates};
use crate::ontology::OntologyError;
use rusqlite::{params, Connection};
use serde::Deserialize;

pub const PATTERN_CONFIDENCE_FLOOR: f32 = 0.7;
const USER_SOURCE: &str = "user";

#[derive(Debug, Deserialize)]
struct DerivedFromPayload {
    derivative_file_id: i64,
    source_file_id: i64,
}

#[derive(Debug, Deserialize)]
struct BackupOfPayload {
    backup_file_id: i64,
    origin_file_id: i64,
}

fn unix_now() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn set_status(conn: &Connection, id: i64, status: DiscoveryStatus) -> Result<(), OntologyError> {
    conn.execute(
        "UPDATE ontology_discoveries SET status = ?1, resolved_at = ?2 WHERE id = ?3",
        params![status.as_str(), unix_now(), id],
    )?;
    Ok(())
}

/// Entity id for a file, creating the File entity if Phase 2 never did.
fn entity_id_for_file(conn: &Connection, file_id: i64) -> Result<i64, OntologyError> {
    if let Some(e) = find_entity_for_file(conn, file_id)? {
        return Ok(e.id);
    }
    let path: String = conn.query_row(
        "SELECT path FROM files WHERE id = ?1",
        params![file_id],
        |r| r.get(0),
    )?;
    let e = crate::ontology::entities::upsert_entity(
        conn,
        crate::ontology::vocabulary::EntityKind::File,
        &path,
        Some(file_id),
        None,
        None,
    )?;
    Ok(e.id)
}

fn assert_user_role(conn: &Connection, entity_id: i64, role: &str) -> Result<(), OntologyError> {
    assert_attr(
        conn,
        entity_id,
        &NewAssertion {
            key: keys::ROLE,
            value: role,
            source: USER_SOURCE,
            confidence: 1.0,
            display_in_global_views: true,
        },
    )?;
    Ok(())
}

fn assert_user_relation(
    conn: &Connection,
    subject_id: i64,
    predicate: &str,
    object_id: i64,
) -> Result<(), OntologyError> {
    assert_relation(
        conn,
        &NewRelation {
            subject_id,
            predicate,
            object_id,
            source: USER_SOURCE,
            confidence: 1.0,
        },
    )?;
    Ok(())
}

/// (subject_entity, predicate, object_entity, role_to_assert) for a discovery.
fn graduation_plan(
    conn: &Connection,
    d: &Discovery,
) -> Result<(i64, &'static str, i64, &'static str), OntologyError> {
    match d.kind.as_str() {
        "derivedFrom-pattern" => {
            let p: DerivedFromPayload = serde_json::from_str(&d.payload)
                .map_err(|e| OntologyError::Populator(format!("bad derivedFrom payload: {e}")))?;
            let subject = entity_id_for_file(conn, p.derivative_file_id)?;
            let object = entity_id_for_file(conn, p.source_file_id)?;
            Ok((subject, predicates::DERIVED_FROM, object, "derivative"))
        }
        "backupOf-pair" => {
            let p: BackupOfPayload = serde_json::from_str(&d.payload)
                .map_err(|e| OntologyError::Populator(format!("bad backupOf payload: {e}")))?;
            let subject = entity_id_for_file(conn, p.backup_file_id)?;
            let object = entity_id_for_file(conn, p.origin_file_id)?;
            Ok((subject, predicates::BACKUP_OF, object, "backup"))
        }
        other => Err(OntologyError::Populator(format!(
            "discovery kind {other} is not user-confirmable in Wave 1"
        ))),
    }
}

/// Confirm one discovery: graduate to facts and mark confirmed.
pub fn confirm_discovery(conn: &Connection, id: i64) -> Result<(), OntologyError> {
    let d = get_discovery(conn, id)?
        .ok_or_else(|| OntologyError::Populator(format!("discovery {id} not found")))?;
    if d.status != DiscoveryStatus::Pending {
        return Ok(());
    }
    let (subject, predicate, object, role) = graduation_plan(conn, &d)?;
    assert_user_role(conn, subject, role)?;
    assert_user_relation(conn, subject, predicate, object)?;
    set_status(conn, id, DiscoveryStatus::Confirmed)
}

/// Reject one discovery: write a blocking negative assertion and mark rejected.
pub fn reject_discovery(
    conn: &Connection,
    id: i64,
    reason: Option<&str>,
) -> Result<(), OntologyError> {
    let d = get_discovery(conn, id)?
        .ok_or_else(|| OntologyError::Populator(format!("discovery {id} not found")))?;
    if d.status != DiscoveryStatus::Pending {
        return Ok(());
    }
    let (subject, predicate, object, _role) = graduation_plan(conn, &d)?;
    // Guard: skip the insert if this pair is already negatively asserted (e.g.
    // rejected via a different discovery) to prevent duplicate rows.
    if !crate::ontology::negative::is_rejected_pair(conn, subject, predicate, object)? {
        reject_pair(conn, subject, predicate, object, reason)?;
    }
    set_status(conn, id, DiscoveryStatus::Rejected)
}

fn median_confidence(discoveries: &[Discovery]) -> f32 {
    let mut confs: Vec<f32> = discoveries.iter().map(|d| d.confidence).collect();
    confs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = confs.len();
    if n == 0 {
        return 0.0;
    }
    if n % 2 == 1 {
        confs[n / 2]
    } else {
        (confs[n / 2 - 1] + confs[n / 2]) / 2.0
    }
}

/// Confirm every pending discovery of a kind. Refuses unless median confidence
/// meets the floor (invariant #7). Returns the number confirmed.
pub fn confirm_discoveries_by_kind(conn: &Connection, kind: &str) -> Result<u32, OntologyError> {
    // u32::MAX is an intentional "no limit / fetch all" sentinel — we need the
    // full population to compute the pattern-level median before graduating.
    let pending = list_pending_by_kind(conn, kind, u32::MAX)?;
    if pending.is_empty() {
        return Ok(0);
    }
    if median_confidence(&pending) < PATTERN_CONFIDENCE_FLOOR {
        return Err(OntologyError::Populator(format!(
            "pattern '{kind}' median confidence below floor {PATTERN_CONFIDENCE_FLOOR}; review per-item"
        )));
    }
    let mut n = 0;
    for d in pending {
        confirm_discovery(conn, d.id)?;
        n += 1;
    }
    Ok(n)
}

/// Reject every pending discovery of a kind. Returns the number rejected.
pub fn reject_discoveries_by_kind(
    conn: &Connection,
    kind: &str,
    reason: Option<&str>,
) -> Result<u32, OntologyError> {
    // u32::MAX is an intentional "no limit / fetch all" sentinel — the full
    // population must be rejected atomically for a pattern-level operation.
    let pending = list_pending_by_kind(conn, kind, u32::MAX)?;
    let mut n = 0;
    for d in pending {
        reject_discovery(conn, d.id, reason)?;
        n += 1;
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::schema::ALL_MIGRATIONS;
    use crate::ontology::discoveries::{insert_discovery, NewDiscovery};
    use crate::ontology::entities::upsert_entity;
    use crate::ontology::relations::outbound;
    use crate::ontology::vocabulary::EntityKind;

    fn migrated_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        for (_, sql) in ALL_MIGRATIONS {
            conn.execute_batch(sql).unwrap();
        }
        conn
    }

    fn ensure_folder(conn: &Connection, folder_id: i64) {
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM folders WHERE id = ?1",
                params![folder_id],
                |r| r.get(0),
            )
            .unwrap();
        if exists == 0 {
            conn.execute(
                "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at) VALUES (?1, NULL, '/root', 'root', 0, 0)",
                params![folder_id],
            )
            .unwrap();
        }
    }

    fn seed_file(conn: &Connection, id: i64, path: &str) {
        ensure_folder(conn, 1);
        let name = path.rsplit('/').next().unwrap_or(path);
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, size, indexed_at, hash_state) VALUES (?1, 1, ?2, ?3, 100, 0, 4)",
            params![id, path, name],
        )
        .unwrap();
        upsert_entity(conn, EntityKind::File, path, Some(id), None, None).unwrap();
    }

    #[test]
    fn confirm_derived_from_graduates_role_and_relation() {
        let conn = migrated_conn();
        seed_file(&conn, 1, "/a/List.psd"); // source
        seed_file(&conn, 2, "/a/List_export.png"); // derivative
        let d = insert_discovery(
            &conn,
            &NewDiscovery {
                kind: "derivedFrom-pattern",
                payload_json: r#"{"derivative_file_id":2,"source_file_id":1,"derivative_path":"/a/List_export.png","source_path":"/a/List.psd","size_ratio":0.3}"#,
                confidence: 0.85,
                potential_bytes_unlocked: 100,
            },
        )
        .unwrap();

        confirm_discovery(&conn, d.id).unwrap();

        // Derivative entity now has role=derivative at conf 1.0 source user.
        let deriv = find_entity_for_file(&conn, 2).unwrap().unwrap();
        let role = crate::ontology::attrs::resolve_attr(&conn, deriv.id, keys::ROLE)
            .unwrap()
            .unwrap();
        assert_eq!(role.value, "derivative");
        assert_eq!(role.source, "user");
        assert!((role.confidence - 1.0).abs() < 1e-6);

        // derivedFrom relation derivative -> source exists.
        let rels = outbound(&conn, deriv.id, predicates::DERIVED_FROM).unwrap();
        assert_eq!(rels.len(), 1);
        let src = find_entity_for_file(&conn, 1).unwrap().unwrap();
        assert_eq!(rels[0].object_id, src.id);

        // Discovery is now confirmed.
        assert_eq!(
            get_discovery(&conn, d.id).unwrap().unwrap().status,
            DiscoveryStatus::Confirmed
        );
    }

    #[test]
    fn confirm_backup_of_graduates_role_and_relation() {
        let conn = migrated_conn();
        seed_file(&conn, 1, "/orig/X.txt");
        seed_file(&conn, 2, "/backup/X.txt");
        let d = insert_discovery(
            &conn,
            &NewDiscovery {
                kind: "backupOf-pair",
                payload_json: r#"{"backup_file_id":2,"origin_file_id":1,"backup_path":"/backup/X.txt","origin_path":"/orig/X.txt","size_ratio":1.0}"#,
                confidence: 0.9,
                potential_bytes_unlocked: 100,
            },
        )
        .unwrap();

        confirm_discovery(&conn, d.id).unwrap();

        let backup = find_entity_for_file(&conn, 2).unwrap().unwrap();
        let role = crate::ontology::attrs::resolve_attr(&conn, backup.id, keys::ROLE)
            .unwrap()
            .unwrap();
        assert_eq!(role.value, "backup");
        let rels = outbound(&conn, backup.id, predicates::BACKUP_OF).unwrap();
        assert_eq!(rels.len(), 1);
    }

    #[test]
    fn reject_writes_negative_assertion_and_marks_rejected() {
        let conn = migrated_conn();
        seed_file(&conn, 1, "/a/List.psd");
        seed_file(&conn, 2, "/a/List_export.png");
        let d = insert_discovery(
            &conn,
            &NewDiscovery {
                kind: "derivedFrom-pattern",
                payload_json: r#"{"derivative_file_id":2,"source_file_id":1,"derivative_path":"/a/List_export.png","source_path":"/a/List.psd","size_ratio":0.3}"#,
                confidence: 0.85,
                potential_bytes_unlocked: 100,
            },
        )
        .unwrap();

        reject_discovery(&conn, d.id, Some("not a derivative")).unwrap();

        let deriv = find_entity_for_file(&conn, 2).unwrap().unwrap();
        let src = find_entity_for_file(&conn, 1).unwrap().unwrap();
        assert!(crate::ontology::negative::is_rejected_pair(
            &conn, deriv.id, predicates::DERIVED_FROM, src.id
        )
        .unwrap());
        assert_eq!(
            get_discovery(&conn, d.id).unwrap().unwrap().status,
            DiscoveryStatus::Rejected
        );
    }

    #[test]
    fn confirm_by_kind_confirms_all_when_median_meets_floor() {
        let conn = migrated_conn();
        for i in 0..3 {
            let s = 1 + i * 2;
            let d = 2 + i * 2;
            seed_file(&conn, s, &format!("/p{i}/src.psd"));
            seed_file(&conn, d, &format!("/p{i}/src_export.png"));
            insert_discovery(
                &conn,
                &NewDiscovery {
                    kind: "derivedFrom-pattern",
                    payload_json: &format!(
                        r#"{{"derivative_file_id":{d},"source_file_id":{s},"derivative_path":"/p{i}/src_export.png","source_path":"/p{i}/src.psd","size_ratio":0.3}}"#
                    ),
                    confidence: 0.8,
                    potential_bytes_unlocked: 100,
                },
            )
            .unwrap();
        }

        let n = confirm_discoveries_by_kind(&conn, "derivedFrom-pattern").unwrap();
        assert_eq!(n, 3);
        assert_eq!(
            crate::ontology::discoveries::count_pending(&conn).unwrap(),
            0
        );
    }

    #[test]
    fn confirm_by_kind_refuses_below_confidence_floor() {
        let conn = migrated_conn();
        seed_file(&conn, 1, "/p/src.psd");
        seed_file(&conn, 2, "/p/src_export.png");
        insert_discovery(
            &conn,
            &NewDiscovery {
                kind: "derivedFrom-pattern",
                payload_json: r#"{"derivative_file_id":2,"source_file_id":1,"derivative_path":"/p/src_export.png","source_path":"/p/src.psd","size_ratio":0.3}"#,
                confidence: 0.5,
                potential_bytes_unlocked: 100,
            },
        )
        .unwrap();

        let err = confirm_discoveries_by_kind(&conn, "derivedFrom-pattern")
            .expect_err("below-floor pattern must be refused");
        match err {
            OntologyError::Populator(msg) => assert!(msg.contains("confidence")),
            other => panic!("expected populator error, got {other:?}"),
        }
        assert_eq!(
            crate::ontology::discoveries::count_pending(&conn).unwrap(),
            1
        );
    }

    /// Invariant #7 states the floor is **≥ 0.7** (i.e. `< PATTERN_CONFIDENCE_FLOOR`
    /// is the rejection condition). This test pins the boundary: a pattern whose
    /// median confidence is exactly 0.7 must pass and have all discoveries confirmed.
    #[test]
    fn confirm_by_kind_confirms_at_exactly_floor() {
        let conn = migrated_conn();
        // Two discoveries: confidences 0.6 and 0.8 → median = (0.6 + 0.8) / 2 = 0.7 exactly.
        seed_file(&conn, 1, "/floor/src.psd");
        seed_file(&conn, 2, "/floor/src_export.png");
        seed_file(&conn, 3, "/floor/src2.psd");
        seed_file(&conn, 4, "/floor/src2_export.png");
        insert_discovery(
            &conn,
            &NewDiscovery {
                kind: "derivedFrom-pattern",
                payload_json: r#"{"derivative_file_id":2,"source_file_id":1,"derivative_path":"/floor/src_export.png","source_path":"/floor/src.psd","size_ratio":0.3}"#,
                confidence: 0.6,
                potential_bytes_unlocked: 100,
            },
        )
        .unwrap();
        insert_discovery(
            &conn,
            &NewDiscovery {
                kind: "derivedFrom-pattern",
                payload_json: r#"{"derivative_file_id":4,"source_file_id":3,"derivative_path":"/floor/src2_export.png","source_path":"/floor/src2.psd","size_ratio":0.3}"#,
                confidence: 0.8,
                potential_bytes_unlocked: 100,
            },
        )
        .unwrap();

        let n = confirm_discoveries_by_kind(&conn, "derivedFrom-pattern")
            .expect("median == floor (0.7) must pass the ≥ 0.7 guard");
        assert_eq!(n, 2);
        assert_eq!(
            crate::ontology::discoveries::count_pending(&conn).unwrap(),
            0
        );
    }
}
