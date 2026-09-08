//! Does a conclusion still hold?
//!
//! A relation is a sentence about two files at one moment: "this was made from
//! that". It is written once. Nothing ever revisits it. So it stays on screen
//! after the file it points at is deleted, or rewritten into something else,
//! and someone deciding what to throw away reads it as still true.
//!
//! That is worse than showing nothing. A wrong sentence next to a delete button
//! is the failure this whole layer exists to prevent.
//!
//! The answer is not to hide the relation. It is the only record that the
//! derivative came from somewhere, and deleting it would lose the thing that
//! makes the derivative safe to remove. So it is shown, and labelled.
//!
//! # What "changed" means here
//!
//! `files.modified_at` newer than `ontology_relations.asserted_at`. Both are
//! unix **seconds** -- verified in `system_time_to_unix` and confirmed against
//! a real index before this comparison was written, because a seconds-versus-
//! milliseconds mix-up would mark every relation in the database stale.
//!
//! It is deliberately a coarse test. A file touched without its content
//! changing reads as changed, which overstates staleness. That direction is the
//! safe one: it asks a person to look, rather than telling them a conclusion
//! holds when it may not. A content-level check needs the hash comparison in
//! #28 wired to relation time, which is not this change.

use serde::Serialize;

/// Where a recorded conclusion stands now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RelationStanding {
    /// The thing it points at is still there, and still what it was.
    Holds,
    /// The file it points at is gone from disk.
    SourceGone,
    /// The file it points at was written after this conclusion was drawn.
    SourceChanged,
}

impl RelationStanding {
    /// Judge one relation against the file it points at.
    ///
    /// `object_deleted_at` and `object_modified_at` are `None` when the object
    /// is not a file at all -- a Project, a Theme. Those have no disk state to
    /// go stale against, so they hold.
    pub fn of(
        asserted_at: i64,
        object_is_file: bool,
        object_deleted_at: Option<i64>,
        object_modified_at: Option<i64>,
    ) -> Self {
        if !object_is_file {
            return Self::Holds;
        }
        // An entity that claims a file but has no row for it is a file that
        // went away, not a file that is fine.
        if object_deleted_at.is_some() {
            return Self::SourceGone;
        }
        match object_modified_at {
            Some(modified) if modified > asserted_at => Self::SourceChanged,
            _ => Self::Holds,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_untouched_source_holds() {
        assert_eq!(
            RelationStanding::of(1000, true, None, Some(900)),
            RelationStanding::Holds
        );
        // Written in the same second the conclusion was drawn: not newer, so
        // not evidence of a change.
        assert_eq!(
            RelationStanding::of(1000, true, None, Some(1000)),
            RelationStanding::Holds
        );
    }

    #[test]
    fn a_deleted_source_is_gone_even_if_it_never_changed() {
        assert_eq!(
            RelationStanding::of(1000, true, Some(5), Some(900)),
            RelationStanding::SourceGone
        );
    }

    #[test]
    fn a_source_written_after_the_conclusion_is_changed() {
        assert_eq!(
            RelationStanding::of(1000, true, None, Some(1001)),
            RelationStanding::SourceChanged
        );
    }

    /// A Project or a Theme is not on disk. It cannot go stale this way, and
    /// reporting it as gone would be a lie in the other direction.
    #[test]
    fn a_non_file_object_has_no_disk_state_to_go_stale() {
        // Deliberately handed disk state that would read as gone AND changed if
        // it were judged as a file. A Project is not on disk, so neither
        // applies, and reporting it stale would be a lie in the other
        // direction.
        assert_eq!(
            RelationStanding::of(1000, false, Some(5), Some(9000)),
            RelationStanding::Holds
        );
    }

    /// A file whose row carries no modified time tells us nothing. Silence is
    /// not evidence of a change.
    #[test]
    fn an_unknown_modified_time_is_not_treated_as_a_change() {
        assert_eq!(
            RelationStanding::of(1000, true, None, None),
            RelationStanding::Holds
        );
    }
}
