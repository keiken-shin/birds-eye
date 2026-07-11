//! Cleanup engine: candidate predicate, plan model, recycle-bin-first executor,
//! restore path. See spec §7 and the constitutional defenses in §3.
//!
//! All platform-specific recycle-bin calls live in `executor.rs` / `restore.rs`.
//! No code path in this module (or anywhere in `src/ontology/`) hard-deletes or
//! renames files via `std::fs` — invariant #1.

pub mod executor;
pub mod plans;
pub mod predicate;
pub mod restore;

use serde::{Deserialize, Serialize};

/// The four cleanup reason buckets the predicate emits (spec §7).
pub mod reasons {
    pub const SAFE_DERIVATIVE: &str = "safe-derivative";
    pub const REDUNDANT_BACKUP: &str = "redundant-backup";
    pub const SCRATCH: &str = "scratch";
    pub const FINISHED_PROJECT_CRUFT: &str = "finished-project-cruft";

    pub const ALL: &[&str] = &[
        SAFE_DERIVATIVE,
        REDUNDANT_BACKUP,
        SCRATCH,
        FINISHED_PROJECT_CRUFT,
    ];
}

/// A file eligible for cleanup, with the reason it qualified.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CleanupCandidate {
    pub file_id: i64,
    pub entity_id: i64,
    pub path: String,
    pub size: i64,
    pub reason: String,
}

/// The provenance snapshot stored in `ontology_cleanup_log.gating_facts` and
/// surfaced for "why was this eligible?" (Constitutional Defense #7).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GatingFacts {
    pub reason: String,
    pub role: Option<String>,
    pub replaceability: Option<String>,
    pub sensitivity: Option<String>,
}

#[allow(dead_code)] // used by executor and restore
pub(crate) fn unix_now() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
