//! Does the recycle bin give back the same object, or a copy of it?
//!
//! The restore path re-links an index row -- with its recorded size and its
//! hashes -- to whatever is at the original path afterwards. It only does that
//! when it can tell the object is the one that went away, and the check it
//! trusts most is the filesystem's own id.
//!
//! That trust rests on one fact about the platform: that a bin restore puts the
//! original back rather than writing a new copy. This measures it, so the
//! assumption is not something the code merely hopes for. It uses the real
//! recycle bin, on a file it creates and then puts back.

#[cfg(windows)]
#[test]
fn a_recycle_bin_round_trip_returns_the_same_object() {
    use birds_eye::native::file_id::object_id;

    let dir = std::env::temp_dir().join("birdseye-recycle-bin-identity");
    std::fs::create_dir_all(&dir).expect("create the fixture folder");
    let path = dir.join("round-trip.bin");
    std::fs::write(&path, vec![7_u8; 4096]).expect("write the fixture");

    let before = object_id(&path).expect("the id before it was removed");
    trash::delete(&path).expect("send it to the recycle bin");
    assert!(!path.exists(), "it must actually have left the path");

    let items: Vec<_> = trash::os_limited::list()
        .expect("list the bin")
        .into_iter()
        .filter(|item| item.original_parent.join(&item.name) == path)
        .collect();
    assert_eq!(items.len(), 1, "exactly one bin item is ours");
    trash::os_limited::restore_all(items).expect("restore it");

    let after = object_id(&path).expect("the id after it came back");
    assert_eq!(
        before, after,
        "if this ever fails, the restore check must stop treating a differing id as a differing file"
    );

    std::fs::remove_dir_all(&dir).ok();
}
