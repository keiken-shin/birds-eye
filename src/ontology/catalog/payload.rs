//! The JSON payload carried by a `relocation` discovery row.

use serde::{Deserialize, Serialize};

pub const RELOCATION_KIND: &str = "relocation";

/// Members embedded in the payload. The full list is served lazily instead —
/// `list_pending_by_kind` SELECTs `payload` for every row and it crosses IPC as
/// an escaped string, so a 500-file cluster would be ~60 KB per card.
pub const MEMBER_CAP: usize = 50;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RelocationMember {
    pub file_id: i64,
    pub path: String,
    pub name: String,
    pub size: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RelocationPayload {
    pub fingerprint: String,
    pub member_hash: String,
    pub destination: String,
    pub destination_exists: bool,
    /// "rule" | "learned" | "template"
    pub source: String,
    pub reason: String,
    pub zone: String,
    pub kind: String,
    pub member_count: u64,
    pub total_bytes: u64,
    pub members: Vec<RelocationMember>,
}

/// Identity of a cluster across runs: same zone, same kind, same destination.
pub fn fingerprint(zone: &str, kind: &str, destination: &str) -> String {
    format!("{:016x}", fnv1a(&format!("{zone}\u{1f}{kind}\u{1f}{destination}")))
}

/// Identity of a cluster's membership. Sorted so row order never changes it.
pub fn member_hash(file_ids: &[i64]) -> String {
    let mut ids = file_ids.to_vec();
    ids.sort_unstable();
    let joined = ids.iter().map(|id| id.to_string()).collect::<Vec<_>>().join(",");
    format!("{:016x}", fnv1a(&joined))
}

/// FNV-1a 64. Not cryptographic — this only needs to be stable across runs and
/// cheap, and it avoids taking a hashing dependency for two identity strings.
fn fnv1a(input: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in input.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_is_stable_and_discriminating() {
        let a = fingerprint("C:\\Users\\a\\Downloads", "installer", "D:\\Software");
        assert_eq!(a, fingerprint("C:\\Users\\a\\Downloads", "installer", "D:\\Software"));
        assert_ne!(a, fingerprint("C:\\Users\\a\\Desktop", "installer", "D:\\Software"));
        assert_ne!(a, fingerprint("C:\\Users\\a\\Downloads", "document", "D:\\Software"));
        assert_ne!(a, fingerprint("C:\\Users\\a\\Downloads", "installer", "D:\\Apps"));
    }

    #[test]
    fn member_hash_ignores_order_but_not_membership() {
        assert_eq!(member_hash(&[3, 1, 2]), member_hash(&[1, 2, 3]));
        assert_ne!(member_hash(&[1, 2, 3]), member_hash(&[1, 2]));
        assert_ne!(member_hash(&[1, 2, 3]), member_hash(&[1, 2, 4]));
    }

    #[test]
    fn payload_round_trips_through_json() {
        let payload = RelocationPayload {
            fingerprint: "fp".to_string(),
            member_hash: "mh".to_string(),
            destination: "D:\\Docs".to_string(),
            destination_exists: false,
            source: "learned".to_string(),
            reason: "87% of your documents already live here".to_string(),
            zone: "C:\\Users\\a\\Downloads".to_string(),
            kind: "document".to_string(),
            member_count: 1,
            total_bytes: 10,
            members: vec![RelocationMember {
                file_id: 1,
                path: "C:\\Users\\a\\Downloads\\a.pdf".to_string(),
                name: "a.pdf".to_string(),
                size: 10,
            }],
        };
        let json = serde_json::to_string(&payload).unwrap();
        let back: RelocationPayload = serde_json::from_str(&json).unwrap();
        assert_eq!(back, payload);
    }
}
