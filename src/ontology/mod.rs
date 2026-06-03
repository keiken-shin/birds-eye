//! Birds Eye ontology layer (Wave 1 foundation).
//!
//! See `docs/superpowers/specs/2026-05-26-birds-eye-ontology-wave-1-design.md`
//! for the full design rationale.

pub mod attrs;
pub mod cleanup;
pub mod discoveries;
pub mod discoveries_resolve;
pub mod enabled;
pub mod entities;
pub mod errors;
pub mod negative;
pub mod orchestrator;
pub mod pinning;
pub mod populators;
pub mod relations;
pub mod sensitivity;
pub mod vocabulary;

pub use errors::OntologyError;

/// Current vocabulary version. Bump when the vocabulary changes.
pub const VOCABULARY_VERSION: i64 = 1;

/// Source-priority ordering for fact resolution.
/// Higher values win in ties.
pub fn source_priority(source: &str) -> i32 {
    if source == "user" {
        100
    } else if source.starts_with("extractor:") {
        80
    } else if source.starts_with("rule:") {
        60
    } else if source.starts_with("heuristic:") {
        40
    } else if source == "phash" {
        30
    } else if source.starts_with("ml:") {
        20
    } else if source == "system" {
        10
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_priority_ordering() {
        assert!(source_priority("user") > source_priority("extractor:pdf"));
        assert!(source_priority("extractor:pdf") > source_priority("rule:r1"));
        assert!(source_priority("rule:r1") > source_priority("heuristic:h1"));
        assert!(source_priority("heuristic:h1") > source_priority("phash"));
        assert!(source_priority("phash") > source_priority("ml:m1"));
        assert!(source_priority("ml:m1") > source_priority("system"));
        assert_eq!(source_priority("unknown-source"), 0);
    }
}
