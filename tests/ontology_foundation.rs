use birds_eye::index::schema::ALL_MIGRATIONS;
use birds_eye::ontology::attrs::{assert_attr, get_attrs, resolve_attr, NewAssertion};
use birds_eye::ontology::enabled::{disable, enable, is_enabled};
use birds_eye::ontology::entities::{find_entity_for_file, upsert_entity};
use birds_eye::ontology::negative::{is_rejected_pair, reject_pair};
use birds_eye::ontology::pinning::{is_pinned, pin_file, unpin_file};
use birds_eye::ontology::relations::{assert_relation, outbound, NewRelation};
use birds_eye::ontology::sensitivity::is_globally_visible_file;
use birds_eye::ontology::vocabulary::{keys, predicates, EntityKind, Role, Sensitivity};
use rusqlite::Connection;

fn migrated() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    for (_, sql) in ALL_MIGRATIONS {
        conn.execute_batch(sql).unwrap();
    }
    conn.execute(
        "INSERT INTO folders (id, parent_id, path, name, depth, indexed_at)
         VALUES (1, NULL, '/dataset', 'dataset', 0, 0),
                (2, 1, '/dataset/Personal Details', 'Personal Details', 1, 0),
                (3, 1, '/dataset/Toonie_world', 'Toonie_world', 1, 0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO files (id, folder_id, path, name, size, indexed_at) VALUES
            (1, 2, '/dataset/Personal Details/id.pdf', 'id.pdf', 1000, 0),
            (2, 3, '/dataset/Toonie_world/List.psd', 'List.psd', 5000000, 0),
            (3, 3, '/dataset/Toonie_world/List_export.png', 'List_export.png', 200000, 0)",
        [],
    )
    .unwrap();
    conn
}

#[test]
fn end_to_end_foundation_behavior() {
    let conn = migrated();

    assert!(!is_enabled(&conn).unwrap());
    enable(&conn).unwrap();
    assert!(is_enabled(&conn).unwrap());

    let id_pdf = upsert_entity(
        &conn,
        EntityKind::File,
        "/dataset/Personal Details/id.pdf",
        Some(1),
        None,
        None,
    )
    .unwrap();
    let psd = upsert_entity(
        &conn,
        EntityKind::File,
        "/dataset/Toonie_world/List.psd",
        Some(2),
        None,
        None,
    )
    .unwrap();
    let png = upsert_entity(
        &conn,
        EntityKind::File,
        "/dataset/Toonie_world/List_export.png",
        Some(3),
        None,
        None,
    )
    .unwrap();

    assert_attr(
        &conn,
        id_pdf.id,
        &NewAssertion {
            key: keys::SENSITIVITY,
            value: Sensitivity::Restricted.as_str(),
            source: "rule:path-personal-details",
            confidence: 1.0,
            display_in_global_views: false,
        },
    )
    .unwrap();

    assert_attr(
        &conn,
        psd.id,
        &NewAssertion {
            key: keys::ROLE,
            value: Role::Source.as_str(),
            source: "rule:psd-extension",
            confidence: 0.85,
            display_in_global_views: true,
        },
    )
    .unwrap();
    assert_attr(
        &conn,
        png.id,
        &NewAssertion {
            key: keys::ROLE,
            value: Role::Derivative.as_str(),
            source: "heuristic:sibling-name",
            confidence: 0.55,
            display_in_global_views: true,
        },
    )
    .unwrap();
    assert_relation(
        &conn,
        &NewRelation {
            subject_id: png.id,
            predicate: predicates::DERIVED_FROM,
            object_id: psd.id,
            source: "heuristic:sibling-name",
            confidence: 0.55,
        },
    )
    .unwrap();

    assert!(!is_globally_visible_file(&conn, 1).unwrap());
    assert!(is_globally_visible_file(&conn, 2).unwrap());
    assert!(is_globally_visible_file(&conn, 3).unwrap());

    let winning_role = resolve_attr(&conn, psd.id, keys::ROLE).unwrap().unwrap();
    assert_eq!(winning_role.value, "source");

    let out = outbound(&conn, png.id, predicates::DERIVED_FROM).unwrap();
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].object_id, psd.id);

    pin_file(&conn, 2, Some("keep all sources")).unwrap();
    assert!(is_pinned(&conn, 2).unwrap());
    unpin_file(&conn, 2).unwrap();
    assert!(!is_pinned(&conn, 2).unwrap());

    reject_pair(
        &conn,
        png.id,
        predicates::DERIVED_FROM,
        psd.id,
        Some("not actually derived"),
    )
    .unwrap();
    assert!(is_rejected_pair(&conn, png.id, predicates::DERIVED_FROM, psd.id).unwrap());

    assert_eq!(
        find_entity_for_file(&conn, 1).unwrap().unwrap().id,
        id_pdf.id
    );

    disable(&conn).unwrap();
    assert!(!is_enabled(&conn).unwrap());
    let attrs_after_disable = get_attrs(&conn, psd.id, keys::ROLE).unwrap();
    assert_eq!(attrs_after_disable.len(), 1, "data survives disable");
}
