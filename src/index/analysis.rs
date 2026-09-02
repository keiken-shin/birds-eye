//! How much of a file was read, and whether the read can be trusted.
//!
//! These were two facts wearing one integer. `files.hash_state` held 0, 2 or 4,
//! the meanings lived in whichever query happened to be in front of you, and
//! `4` was written as "read completely" and read as "read completely and
//! stably" -- which are different claims, and the second is the one the
//! deletion guard leans on.
//!
//! So they are two things now. [`AnalysisLevel`] answers "how much of it did we
//! read", and it is what `hash_state` stores -- same numbers, same column, no
//! migration, but nowhere left to write a bare `4`. `files.verification_status`
//! answers "and could we trust what came back", and it holds either `stable` or
//! the name of what went wrong, taken from the same vocabulary the scan issue
//! list already uses.
//!
//! # Why this is not a second copy of `scan_issues`
//!
//! `scan_issues` is the log of one scan: what happened, at which path, on that
//! run. It is what the coverage panel counts. This is the current state of a
//! row, reachable by id, and it survives the file being renamed. A join from a
//! file to "was my last read any good" would have to go through a path, and the
//! path is the one thing about a file that does not hold still.

/// How much of a file the index has actually read.
///
/// The numbers are the ones already in the column, so this names what was there
/// rather than migrating it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnalysisLevel {
    /// Not read. Either nothing else is its size, or the read has not happened
    /// yet, or it was attempted and failed -- `verification_status` says which.
    None = 0,
    /// Parts of it were read. Enough to spot a likely copy, never enough to
    /// delete one.
    Sampled = 2,
    /// Every byte was read.
    Complete = 4,
}

impl AnalysisLevel {
    pub fn as_i64(self) -> i64 {
        self as i64
    }

    /// Anything unrecognised reads as `None`, which is the safe direction: an
    /// unknown value must never be mistaken for "we read all of it".
    pub fn from_i64(value: i64) -> Self {
        match value {
            2 => Self::Sampled,
            4 => Self::Complete,
            _ => Self::None,
        }
    }
}

/// The read held still from first byte to last.
///
/// Everything else `verification_status` can hold is a [`SkipKind`] name --
/// `offline`, `locked`, `denied`, `changed`, `failed` -- so the row and the
/// scan issue beside it use one vocabulary rather than two.
///
/// [`SkipKind`]: crate::index::algorithms::xxh3::SkipKind
pub const VERIFIED_STABLE: &str = "stable";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_numbers_are_the_ones_already_in_the_column() {
        assert_eq!(AnalysisLevel::None.as_i64(), 0);
        assert_eq!(AnalysisLevel::Sampled.as_i64(), 2);
        assert_eq!(AnalysisLevel::Complete.as_i64(), 4);
    }

    #[test]
    fn a_value_nobody_wrote_is_read_as_unread_not_as_complete() {
        for stray in [-1, 1, 3, 5, 99] {
            assert_eq!(
                AnalysisLevel::from_i64(stray),
                AnalysisLevel::None,
                "{stray} must not be mistaken for a finished read"
            );
        }
    }

    #[test]
    fn every_level_survives_a_round_trip() {
        for level in [
            AnalysisLevel::None,
            AnalysisLevel::Sampled,
            AnalysisLevel::Complete,
        ] {
            assert_eq!(AnalysisLevel::from_i64(level.as_i64()), level);
        }
    }
}
