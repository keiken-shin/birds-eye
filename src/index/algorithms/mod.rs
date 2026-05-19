use rusqlite::Connection;

use crate::index::writer::{FinalizationProgress, IndexError};

mod fnv1a;
mod xxh3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DedupStrategy {
    Xxh3Progressive,
    Fnv1aLegacy,
}

impl Default for DedupStrategy {
    fn default() -> Self {
        Self::Xxh3Progressive
    }
}

impl DedupStrategy {
    pub fn from_id(value: &str) -> Self {
        match value {
            "fnv1a-legacy" => Self::Fnv1aLegacy,
            "xxh3-progressive" => Self::Xxh3Progressive,
            _ => Self::default(),
        }
    }

    pub fn as_id(self) -> &'static str {
        match self {
            Self::Xxh3Progressive => "xxh3-progressive",
            Self::Fnv1aLegacy => "fnv1a-legacy",
        }
    }

    pub fn algorithm_prefix(self) -> &'static str {
        match self {
            Self::Xxh3Progressive => "xxh3-",
            Self::Fnv1aLegacy => "fnv1a-",
        }
    }
}

pub fn update_hashes_for_duplicate_candidates<F>(
    connection: &mut Connection,
    strategy: DedupStrategy,
    progress: &mut F,
) -> Result<(), IndexError>
where
    F: FnMut(FinalizationProgress),
{
    match strategy {
        DedupStrategy::Xxh3Progressive => {
            xxh3::update_hashes_for_duplicate_candidates(connection, progress)
        }
        DedupStrategy::Fnv1aLegacy => {
            fnv1a::update_hashes_for_duplicate_candidates(connection, progress)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_known_strategy_ids() {
        assert_eq!(
            DedupStrategy::from_id("xxh3-progressive"),
            DedupStrategy::Xxh3Progressive
        );
        assert_eq!(
            DedupStrategy::from_id("fnv1a-legacy"),
            DedupStrategy::Fnv1aLegacy
        );
    }

    #[test]
    fn defaults_unknown_strategy_to_xxh3() {
        assert_eq!(
            DedupStrategy::from_id("not-a-real-strategy"),
            DedupStrategy::Xxh3Progressive
        );
        assert_eq!(DedupStrategy::default(), DedupStrategy::Xxh3Progressive);
    }

    #[test]
    fn exposes_hash_algorithm_prefixes() {
        assert_eq!(DedupStrategy::Xxh3Progressive.algorithm_prefix(), "xxh3-");
        assert_eq!(DedupStrategy::Fnv1aLegacy.algorithm_prefix(), "fnv1a-");
    }
}
