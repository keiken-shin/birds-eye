//! What a log line is allowed to say about a path.
//!
//! A path is often the most revealing thing about a file. `Divorce papers`,
//! `Interview - Acme`, a client's name, a former employer's name: the folder
//! tree is a diary, and a scan log that names every folder is that diary in a
//! file the person may hand to someone else when something goes wrong.
//!
//! Removing paths entirely would make the log useless -- the questions it
//! exists to answer are "which folder was slow" and "where did the walk stall",
//! and both need to tell one folder from another. So a path becomes a short
//! token derived from it: stable, so two lines about the same folder line up,
//! and one-way, so the token says nothing about the name.
//!
//! The depth travels with it, because "seven levels down" is real debugging
//! information and reveals nothing.
//!
//! Two things stay in the clear on purpose. The scan root, logged once, is what
//! the person chose and is on screen the whole time; without it the log is not
//! anchored to anything. And the path in a scan *error* stays real, because the
//! log exists so someone can act on it, and nobody can fix "something went
//! wrong with #a3f19c22". What is redacted is the per-directory chatter, which
//! is thousands of lines naming every folder on the disk and is only ever read
//! for its timings.
//!
//! This is for logs and diagnostics only. The index still stores real paths --
//! it has to, they are what the app acts on.

use std::path::Path;
use xxhash_rust::xxh3::xxh3_64;

/// A path as a log may refer to it: `#3f9a1c22d40b7e15/d7`.
///
/// Same path, same token, for the life of the process and beyond -- the hash is
/// of the path text, with no salt, so a log from yesterday and a log from today
/// can be compared. That is deliberate: correlating two runs is the point, and
/// a token that cannot be reversed into a name does not need a salt to be safe
/// from casual reading. It is not a secret-keeping mechanism against someone
/// who already knows the exact path they are testing for.
pub fn path_token(path: &Path) -> String {
    let text = path.to_string_lossy();
    // Named components only. The drive letter and the root are not depth, and
    // counting them would make the number platform-dependent for no gain.
    let depth = path
        .components()
        .filter(|c| matches!(c, std::path::Component::Normal(_)))
        .count();
    format!("#{:016x}/d{depth}", xxh3_64(text.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn the_token_says_nothing_about_the_name() {
        let secret = PathBuf::from(r"C:\Users\someone\Documents\Divorce papers");
        let token = path_token(&secret);
        for part in ["Divorce", "papers", "someone", "Documents", "Users"] {
            assert!(
                !token.contains(part),
                "the token leaked {part:?}: {token}"
            );
        }
    }

    #[test]
    fn the_same_folder_is_the_same_token_so_two_lines_can_be_matched_up() {
        let path = PathBuf::from(r"C:\a\b\c");
        assert_eq!(path_token(&path), path_token(&path));
    }

    #[test]
    fn two_folders_are_two_tokens() {
        assert_ne!(
            path_token(&PathBuf::from(r"C:\a\b")),
            path_token(&PathBuf::from(r"C:\a\c"))
        );
    }

    /// Depth is the one thing worth keeping in the clear: it explains a slow
    /// walk and describes nobody.
    #[test]
    fn depth_is_carried_because_it_helps_and_reveals_nothing() {
        // Named components only: the drive letter and the root are not depth.
        assert!(path_token(&PathBuf::from(r"C:\a\b\c\d")).ends_with("/d4"));
        assert!(path_token(&PathBuf::from(r"C:\a")).ends_with("/d1"));
    }
}
