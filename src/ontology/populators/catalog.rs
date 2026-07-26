//! Relocation-suggestion populator.
//!
//! Reads the index, plus exactly one `is_dir()` filesystem probe per emitted
//! cluster (see `destination_exists` below) — not index-only. One cluster of
//! stray files in an inbox zone becomes one `relocation` discovery, carrying
//! the destination, the evidence for it, and a capped member list.
//!
//! Known risk: this populator is tagged `CostTier::Cheap`, but if a
//! user-authored rule points its destination at an unreachable network path,
//! that one `is_dir()` stat can block for the OS network timeout — stalling a
//! tier the budget system otherwise treats as free.

use crate::ontology::catalog::cluster::{candidates, cluster};
use crate::ontology::catalog::infer::infer;
use crate::ontology::catalog::payload::{
    fingerprint, member_hash, RelocationMember, RelocationPayload, MEMBER_CAP, RELOCATION_KIND,
};
use crate::ontology::catalog::zones::inbox_zones;
use crate::ontology::discoveries::{
    insert_discovery, list_by_kind_and_status, DiscoveryStatus, NewDiscovery,
};
use crate::ontology::populators::{
    CostTier, Populator, PopulatorContext, PopulatorError, PopulatorOutcome,
};
use rusqlite::Connection;
use std::collections::HashSet;

pub struct CatalogPopulator;

impl CatalogPopulator {
    pub fn new() -> Self {
        Self
    }
}

impl Default for CatalogPopulator {
    fn default() -> Self {
        Self::new()
    }
}

impl Populator for CatalogPopulator {
    fn name(&self) -> &'static str {
        "CatalogPopulator"
    }

    fn cost_tier(&self) -> CostTier {
        CostTier::Cheap
    }

    fn run(
        &self,
        conn: &mut Connection,
        ctx: &mut PopulatorContext,
        _resume_cursor: Option<&str>,
    ) -> Result<PopulatorOutcome, PopulatorError> {
        if ctx.is_paused() {
            return Ok(PopulatorOutcome::Paused {
                cursor: String::new(),
                partial: ctx.snapshot(),
            });
        }

        let zones = inbox_zones(conn)?;
        if zones.is_empty() {
            return Ok(PopulatorOutcome::Completed(ctx.snapshot()));
        }

        let found = candidates(conn, &zones)?;
        for _ in &found {
            ctx.note_file();
        }

        // Suppression keys: a cluster already answered (rejected), already
        // asked (pending), or already confirmed (but not yet moved — confirming
        // only flips the status column, the physical move is a separate later
        // step) with the same membership is not asked again. Once the move
        // actually executes, the source rows get `deleted_at` set and the
        // cluster falls out of `candidates()` entirely, so this is self-limiting.
        let mut seen: HashSet<(String, String)> = HashSet::new();
        for status in [
            DiscoveryStatus::Rejected,
            DiscoveryStatus::Pending,
            DiscoveryStatus::Confirmed,
        ] {
            for existing in list_by_kind_and_status(conn, RELOCATION_KIND, status)? {
                if let Ok(payload) = serde_json::from_str::<RelocationPayload>(&existing.payload) {
                    seen.insert((payload.fingerprint, payload.member_hash));
                }
            }
        }

        for (zone, kind, members) in cluster(found) {
            if ctx.is_paused() {
                return Ok(PopulatorOutcome::Paused {
                    cursor: String::new(),
                    partial: ctx.snapshot(),
                });
            }

            let sample = members[0].name.clone();
            let media_kind = members[0].media_kind.clone();
            let Some(destination) = infer(conn, &zones, &zone, &kind, &sample, &media_kind)? else {
                continue;
            };

            let ids: Vec<i64> = members.iter().map(|m| m.file_id).collect();
            let fp = fingerprint(&zone, &kind, &destination.path);
            let mh = member_hash(&ids);
            if seen.contains(&(fp.clone(), mh.clone())) {
                continue;
            }

            let total_bytes: u64 = members.iter().map(|m| m.size.max(0) as u64).sum();
            let payload = RelocationPayload {
                fingerprint: fp,
                member_hash: mh,
                destination_exists: std::path::Path::new(&destination.path).is_dir(),
                destination: destination.path,
                source: destination.source.to_string(),
                reason: destination.reason,
                zone,
                kind,
                member_count: members.len() as u64,
                total_bytes,
                members: members
                    .iter()
                    .take(MEMBER_CAP)
                    .map(|m| RelocationMember {
                        file_id: m.file_id,
                        path: m.path.clone(),
                        name: m.name.clone(),
                        size: m.size,
                    })
                    .collect(),
            };

            insert_discovery(
                conn,
                &NewDiscovery {
                    kind: RELOCATION_KIND,
                    payload_json: &serde_json::to_string(&payload)?,
                    confidence: destination.confidence,
                    // "bytes moved" for this kind. The column is the primary
                    // ORDER BY key, so all-zero rows would make the LIMIT an
                    // arbitrary cut.
                    potential_bytes_unlocked: total_bytes,
                },
            )?;
            ctx.note_discovery();
        }

        Ok(PopulatorOutcome::Completed(ctx.snapshot()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::schema::ALL_MIGRATIONS;
    use crate::ontology::catalog::payload::{RelocationPayload, RELOCATION_KIND};
    use crate::ontology::discoveries::list_pending_by_kind;
    use crate::ontology::discoveries_resolve::{confirm_discovery, reject_discovery};
    use crate::ontology::populators::{BudgetTier, PopulatorContext};
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

    fn ctx() -> PopulatorContext {
        PopulatorContext::new(BudgetTier::Standard, Arc::new(AtomicBool::new(false)))
    }

    /// An inbox zone with `count` installers, plus a learned home holding 20.
    fn seed(conn: &Connection, count: i64) {
        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
             VALUES (1, NULL, 'C:\\', 'C:', 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
             VALUES (2, NULL, 'D:\\Software', 'Software', 0, 0)",
            [],
        )
        .unwrap();
        for n in 0..count {
            conn.execute(
                "INSERT INTO files (id, folder_id, path, name, size, media_kind, indexed_at)
                 VALUES (?1, 1, ?2, ?3, 100, 'installer', 0)",
                rusqlite::params![n + 1, format!("C:\\setup{n}.exe"), format!("setup{n}.exe")],
            )
            .unwrap();
        }
        for n in 0..20 {
            conn.execute(
                "INSERT INTO files (id, folder_id, path, name, size, media_kind, indexed_at)
                 VALUES (?1, 2, ?2, 'app.exe', 100, 'installer', 0)",
                rusqlite::params![1000 + n, format!("D:\\Software\\app{n}.exe")],
            )
            .unwrap();
        }
    }

    #[test]
    fn emits_one_card_per_cluster_with_a_learned_destination() {
        let mut conn = migrated_conn();
        seed(&conn, 3);

        let outcome = CatalogPopulator::new().run(&mut conn, &mut ctx(), None).unwrap();
        assert!(matches!(outcome, PopulatorOutcome::Completed(_)));

        let cards = list_pending_by_kind(&conn, RELOCATION_KIND, 10).unwrap();
        assert_eq!(cards.len(), 1, "one cluster, one card");

        let payload: RelocationPayload = serde_json::from_str(&cards[0].payload).unwrap();
        assert_eq!(payload.destination, "D:\\Software");
        assert_eq!(payload.source, "learned");
        assert_eq!(payload.member_count, 3);
        assert_eq!(payload.total_bytes, 300);
        assert_eq!(cards[0].potential_bytes_unlocked, 300);
    }

    #[test]
    fn does_not_re_emit_an_unchanged_rejected_cluster() {
        let mut conn = migrated_conn();
        seed(&conn, 3);

        CatalogPopulator::new().run(&mut conn, &mut ctx(), None).unwrap();
        let first = list_pending_by_kind(&conn, RELOCATION_KIND, 10).unwrap();
        reject_discovery(&conn, first[0].id, Some("no thanks")).unwrap();

        CatalogPopulator::new().run(&mut conn, &mut ctx(), None).unwrap();
        assert!(
            list_pending_by_kind(&conn, RELOCATION_KIND, 10).unwrap().is_empty(),
            "a rejected cluster with unchanged membership must stay rejected"
        );
    }

    #[test]
    fn re_emits_once_membership_changes() {
        let mut conn = migrated_conn();
        seed(&conn, 3);

        CatalogPopulator::new().run(&mut conn, &mut ctx(), None).unwrap();
        let first = list_pending_by_kind(&conn, RELOCATION_KIND, 10).unwrap();
        reject_discovery(&conn, first[0].id, None).unwrap();

        // A new download lands in the same zone.
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, size, media_kind, indexed_at)
             VALUES (99, 1, 'C:\\new-setup.exe', 'new-setup.exe', 100, 'installer', 0)",
            [],
        )
        .unwrap();

        CatalogPopulator::new().run(&mut conn, &mut ctx(), None).unwrap();
        let second = list_pending_by_kind(&conn, RELOCATION_KIND, 10).unwrap();
        assert_eq!(second.len(), 1, "changed membership re-opens the question");
    }

    #[test]
    fn does_not_duplicate_a_still_pending_card() {
        let mut conn = migrated_conn();
        seed(&conn, 3);

        CatalogPopulator::new().run(&mut conn, &mut ctx(), None).unwrap();
        CatalogPopulator::new().run(&mut conn, &mut ctx(), None).unwrap();

        assert_eq!(list_pending_by_kind(&conn, RELOCATION_KIND, 10).unwrap().len(), 1);
    }

    #[test]
    fn does_not_re_nag_a_confirmed_cluster_before_the_move_lands() {
        let mut conn = migrated_conn();
        seed(&conn, 3);

        CatalogPopulator::new().run(&mut conn, &mut ctx(), None).unwrap();
        let first = list_pending_by_kind(&conn, RELOCATION_KIND, 10).unwrap();
        confirm_discovery(&conn, first[0].id).unwrap();

        // Confirming a relocation only flips its status column; the physical
        // move is a separate, later step, so the same files are still sitting
        // in the zone when the populator runs again.
        CatalogPopulator::new().run(&mut conn, &mut ctx(), None).unwrap();
        assert!(
            list_pending_by_kind(&conn, RELOCATION_KIND, 10).unwrap().is_empty(),
            "a confirmed cluster awaiting its physical move must not re-nag"
        );
    }

    #[test]
    fn caps_the_embedded_member_list() {
        let mut conn = migrated_conn();
        seed(&conn, 120);

        CatalogPopulator::new().run(&mut conn, &mut ctx(), None).unwrap();
        let cards = list_pending_by_kind(&conn, RELOCATION_KIND, 10).unwrap();
        let payload: RelocationPayload = serde_json::from_str(&cards[0].payload).unwrap();

        assert_eq!(payload.member_count, 120, "the count is the truth");
        assert_eq!(payload.members.len(), 50, "the embedded list is capped");
    }

    #[test]
    fn emits_nothing_when_no_zone_has_candidates() {
        let mut conn = migrated_conn();
        conn.execute(
            "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
             VALUES (1, NULL, 'D:\\Projects', 'Projects', 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, size, media_kind, indexed_at)
             VALUES (1, 1, 'D:\\Projects\\a.exe', 'a.exe', 10, 'installer', 0)",
            [],
        )
        .unwrap();

        CatalogPopulator::new().run(&mut conn, &mut ctx(), None).unwrap();
        assert!(list_pending_by_kind(&conn, RELOCATION_KIND, 10).unwrap().is_empty());
    }

    #[test]
    fn a_cluster_with_no_inferable_destination_is_silently_skipped_alongside_a_good_one() {
        let mut conn = migrated_conn();
        seed(&conn, 3); // "installer" cluster: infers a learned destination.

        // A second cluster in the same zone that `infer` cannot place: media_kind
        // "other" has no template fallback, and no learned home exists for it
        // anywhere in the index, so `infer` returns `None` for it.
        conn.execute(
            "INSERT INTO files (id, folder_id, path, name, size, media_kind, indexed_at)
             VALUES (500, 1, 'C:\\weird.xyz', 'weird.xyz', 10, 'other', 0)",
            [],
        )
        .unwrap();

        let mut context = ctx();
        let outcome = CatalogPopulator::new().run(&mut conn, &mut context, None).unwrap();
        assert!(matches!(outcome, PopulatorOutcome::Completed(_)));

        let cards = list_pending_by_kind(&conn, RELOCATION_KIND, 10).unwrap();
        assert_eq!(cards.len(), 1, "the inferable cluster still emits a card");
        let payload: RelocationPayload = serde_json::from_str(&cards[0].payload).unwrap();
        assert_eq!(payload.kind, "installer");

        let total_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM ontology_discoveries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(total_rows, 1, "the un-inferable cluster leaves no partial row");
        assert_eq!(
            context.snapshot().discoveries_emitted,
            1,
            "only the good cluster is counted as a discovery"
        );
    }

    #[test]
    fn honors_an_already_paused_context_before_emitting_anything() {
        let mut conn = migrated_conn();
        seed(&conn, 3);

        let pause = Arc::new(AtomicBool::new(true));
        let mut paused_ctx = PopulatorContext::new(BudgetTier::Standard, pause);

        let outcome = CatalogPopulator::new().run(&mut conn, &mut paused_ctx, None).unwrap();
        assert!(matches!(outcome, PopulatorOutcome::Paused { .. }));
        assert!(
            list_pending_by_kind(&conn, RELOCATION_KIND, 10).unwrap().is_empty(),
            "a paused run must not emit any card"
        );
        assert_eq!(paused_ctx.snapshot().files_visited, 0);
        assert_eq!(paused_ctx.snapshot().discoveries_emitted, 0);
    }
}
