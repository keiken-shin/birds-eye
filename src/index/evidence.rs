//! How good is the evidence behind a duplicate claim?
//!
//! The index stores a float. `1.0` when every member of a group carries a
//! complete-content digest, `0.80` when they agreed on sampled parts of the
//! file. Two values, derived from one fact -- whether a full hash exists --
//! dressed up as a continuous score.
//!
//! That float must not leave the process. `confidence: 0.80` beside a delete
//! button reads as "80% safe to delete", which is a claim nobody made: it is
//! not a probability, it was never calibrated against anything, and a person
//! deciding what to remove will read it as one. The number is fine for ordering
//! rows inside the database, which is all it was ever for.
//!
//! So the API sends a name instead. The mapping lives here, in one place, on
//! the side that owns the number -- the workspace used to re-derive it from the
//! float with its own thresholds, which is two copies of one rule waiting to
//! disagree.

use serde::Serialize;

/// What a duplicate group rests on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Evidence {
    /// Every member was read from first byte to last, and the digests match.
    /// This is the only evidence strong enough to call two files identical.
    Exact,
    /// The members agreed on the parts that were read. Enough to spot a likely
    /// copy, never enough to delete one -- files above the eager hashing cap
    /// can only reach here during a scan, and are read in full at the moment of
    /// deletion instead.
    Sampled,
    /// Nothing but the length matched. Not reachable today: the group builder
    /// requires a sample hash, so a group never rests on size alone. Kept
    /// because the column can still hold an older value, and a name for it is
    /// better than a wrong one.
    SizeOnly,
}

impl Evidence {
    /// The thresholds sit between the two values the builder actually writes,
    /// so a stored `1.0` and a stored `0.80` land where they should even if
    /// floating point moved them a hair.
    pub fn from_confidence(confidence: f64) -> Self {
        if confidence >= 0.99 {
            Self::Exact
        } else if confidence >= 0.8 {
            Self::Sampled
        } else {
            Self::SizeOnly
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The two values the group builder writes, and the one the schema can
    /// still hold from an older index.
    #[test]
    fn the_values_the_index_actually_stores_land_where_they_should() {
        assert_eq!(Evidence::from_confidence(1.0), Evidence::Exact);
        assert_eq!(Evidence::from_confidence(0.80), Evidence::Sampled);
        assert_eq!(Evidence::from_confidence(0.60), Evidence::SizeOnly);
    }

    /// Nothing short of a complete read may be called exact. This is the whole
    /// point: the strong name is the one that gets acted on.
    #[test]
    fn almost_certain_is_not_certain() {
        assert_eq!(Evidence::from_confidence(0.98), Evidence::Sampled);
        assert_eq!(Evidence::from_confidence(0.9899), Evidence::Sampled);
    }

    #[test]
    fn it_serialises_as_a_name_a_person_could_read() {
        assert_eq!(
            serde_json::to_string(&Evidence::SizeOnly).unwrap(),
            "\"size-only\""
        );
        assert_eq!(serde_json::to_string(&Evidence::Exact).unwrap(), "\"exact\"");
    }
}

/// How much weight is behind a single stated fact about a file -- a role, a
/// lifecycle, a "this came from that".
///
/// Same argument as [`Evidence`], different subject. The ontology stores a
/// float per assertion and it is even less of a probability than the duplicate
/// one: it is a number a heuristic author picked so that stronger signals sort
/// above weaker ones. Sending it to a screen invites someone to read "0.77" as
/// three-quarters certain.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Strength {
    /// The person said so. Nothing outranks that, and no heuristic writes it.
    Stated,
    /// The signals agree strongly. Worth acting on, still worth checking.
    Strong,
    /// One signal, on its own. Worth showing, not worth acting on unread.
    Suggested,
}

impl Strength {
    pub fn of(source: &str, confidence: f64) -> Self {
        if source == "user" {
            return Self::Stated;
        }
        if confidence >= 0.9 {
            Self::Strong
        } else {
            Self::Suggested
        }
    }
}

#[cfg(test)]
mod strength_tests {
    use super::*;

    /// A person's own answer is not a heuristic that scored well, and it must
    /// not be shown as one however the score came out.
    #[test]
    fn what_the_person_said_outranks_any_score() {
        assert_eq!(Strength::of("user", 0.1), Strength::Stated);
        assert_eq!(Strength::of("user", 1.0), Strength::Stated);
    }

    #[test]
    fn a_heuristic_is_banded_by_how_much_agreed() {
        assert_eq!(Strength::of("structural", 0.95), Strength::Strong);
        assert_eq!(Strength::of("structural", 0.9), Strength::Strong);
        assert_eq!(Strength::of("structural", 0.89), Strength::Suggested);
        assert_eq!(Strength::of("extractor", 0.5), Strength::Suggested);
    }

    /// A perfect score from a heuristic is still a heuristic.
    #[test]
    fn a_machine_scoring_itself_full_marks_is_not_the_person_saying_so() {
        assert_ne!(Strength::of("structural", 1.0), Strength::Stated);
    }
}
