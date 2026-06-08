//! Controlled-vocabulary enums for Wave 1 ontology.

use crate::ontology::OntologyError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EntityKind {
    File,
    Folder,
    Project,
    Work,
    Theme,
}

impl EntityKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::File => "File",
            Self::Folder => "Folder",
            Self::Project => "Project",
            Self::Work => "Work",
            Self::Theme => "Theme",
        }
    }

    pub fn from_str(s: &str) -> Result<Self, OntologyError> {
        match s {
            "File" => Ok(Self::File),
            "Folder" => Ok(Self::Folder),
            "Project" => Ok(Self::Project),
            "Work" => Ok(Self::Work),
            "Theme" => Ok(Self::Theme),
            other => Err(OntologyError::InvalidVocabulary(format!("EntityKind: {other}"))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Source,
    Derivative,
    Reference,
    Asset,
    Tool,
    Backup,
    Scratch,
    System,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Source => "source",
            Self::Derivative => "derivative",
            Self::Reference => "reference",
            Self::Asset => "asset",
            Self::Tool => "tool",
            Self::Backup => "backup",
            Self::Scratch => "scratch",
            Self::System => "system",
        }
    }

    pub fn from_str(s: &str) -> Result<Self, OntologyError> {
        match s {
            "source" => Ok(Self::Source),
            "derivative" => Ok(Self::Derivative),
            "reference" => Ok(Self::Reference),
            "asset" => Ok(Self::Asset),
            "tool" => Ok(Self::Tool),
            "backup" => Ok(Self::Backup),
            "scratch" => Ok(Self::Scratch),
            "system" => Ok(Self::System),
            other => Err(OntologyError::InvalidVocabulary(format!("Role: {other}"))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Replaceability {
    Regenerable,
    Redownloadable,
    RecoverableWithEffort,
    Irreplaceable,
    Unknown,
}

impl Replaceability {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Regenerable => "regenerable",
            Self::Redownloadable => "redownloadable",
            Self::RecoverableWithEffort => "recoverable-with-effort",
            Self::Irreplaceable => "irreplaceable",
            Self::Unknown => "unknown",
        }
    }

    pub fn from_str(s: &str) -> Result<Self, OntologyError> {
        match s {
            "regenerable" => Ok(Self::Regenerable),
            "redownloadable" => Ok(Self::Redownloadable),
            "recoverable-with-effort" => Ok(Self::RecoverableWithEffort),
            "irreplaceable" => Ok(Self::Irreplaceable),
            "unknown" => Ok(Self::Unknown),
            other => Err(OntologyError::InvalidVocabulary(format!(
                "Replaceability: {other}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sensitivity {
    Public,
    Normal,
    Private,
    Restricted,
}

impl Sensitivity {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Public => "public",
            Self::Normal => "normal",
            Self::Private => "private",
            Self::Restricted => "restricted",
        }
    }

    pub fn from_str(s: &str) -> Result<Self, OntologyError> {
        match s {
            "public" => Ok(Self::Public),
            "normal" => Ok(Self::Normal),
            "private" => Ok(Self::Private),
            "restricted" => Ok(Self::Restricted),
            other => Err(OntologyError::InvalidVocabulary(format!(
                "Sensitivity: {other}"
            ))),
        }
    }

    pub fn restricted_or_private(self) -> bool {
        matches!(self, Self::Private | Self::Restricted)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lifecycle {
    Planning,
    Active,
    Finished,
    Archived,
    Abandoned,
}

impl Lifecycle {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Planning => "planning",
            Self::Active => "active",
            Self::Finished => "finished",
            Self::Archived => "archived",
            Self::Abandoned => "abandoned",
        }
    }

    pub fn from_str(s: &str) -> Result<Self, OntologyError> {
        match s {
            "planning" => Ok(Self::Planning),
            "active" => Ok(Self::Active),
            "finished" => Ok(Self::Finished),
            "archived" => Ok(Self::Archived),
            "abandoned" => Ok(Self::Abandoned),
            other => Err(OntologyError::InvalidVocabulary(format!(
                "Lifecycle: {other}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    UserCreated,
    WebDownload,
    PhoneScreenshot,
    PhoneCamera,
    MessengerReceived,
    AppExport,
    ArchiveExtracted,
    Unknown,
}

impl Origin {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UserCreated => "user-created",
            Self::WebDownload => "web-download",
            Self::PhoneScreenshot => "phone-screenshot",
            Self::PhoneCamera => "phone-camera",
            Self::MessengerReceived => "messenger-received",
            Self::AppExport => "app-export",
            Self::ArchiveExtracted => "archive-extracted",
            Self::Unknown => "unknown",
        }
    }

    pub fn from_str(s: &str) -> Result<Self, OntologyError> {
        match s {
            "user-created" => Ok(Self::UserCreated),
            "web-download" => Ok(Self::WebDownload),
            "phone-screenshot" => Ok(Self::PhoneScreenshot),
            "phone-camera" => Ok(Self::PhoneCamera),
            "messenger-received" => Ok(Self::MessengerReceived),
            "app-export" => Ok(Self::AppExport),
            "archive-extracted" => Ok(Self::ArchiveExtracted),
            "unknown" => Ok(Self::Unknown),
            other => Err(OntologyError::InvalidVocabulary(format!("Origin: {other}"))),
        }
    }
}

/// Property keys (the `key` column of `ontology_attrs`).
pub mod keys {
    pub const ROLE: &str = "role";
    pub const REPLACEABILITY: &str = "replaceability";
    pub const SENSITIVITY: &str = "sensitivity";
    pub const LIFECYCLE: &str = "lifecycle";
    pub const ORIGIN: &str = "origin";
    pub const LANGUAGE: &str = "language";
    pub const MEDIA_TYPE: &str = "mediaType";
}

/// Relation predicates (the `predicate` column of `ontology_relations`).
pub mod predicates {
    pub const IN_FOLDER: &str = "inFolder";
    pub const PART_OF: &str = "partOf";
    pub const DERIVED_FROM: &str = "derivedFrom";
    pub const BACKUP_OF: &str = "backupOf";
    pub const NEAR_DUPLICATE_OF: &str = "nearDuplicateOf";
    pub const MANIFESTATION_OF: &str = "manifestationOf";
    pub const DEPICTS: &str = "depicts";
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ontology::OntologyError;

    fn round_trip<T, F, G>(values: &[T], to_str: F, from_str: G)
    where
        T: PartialEq + std::fmt::Debug + Copy,
        F: Fn(T) -> &'static str,
        G: Fn(&str) -> Result<T, OntologyError>,
    {
        for v in values {
            let s = to_str(*v);
            let parsed = from_str(s).expect("round-trip");
            assert_eq!(parsed, *v, "{s} did not round-trip");
        }
    }

    #[test]
    fn entity_kind_round_trip() {
        round_trip(
            &[
                EntityKind::File,
                EntityKind::Folder,
                EntityKind::Project,
                EntityKind::Work,
                EntityKind::Theme,
            ],
            EntityKind::as_str,
            EntityKind::from_str,
        );
        assert!(EntityKind::from_str("Nonsense").is_err());
    }

    #[test]
    fn role_round_trip() {
        round_trip(
            &[
                Role::Source,
                Role::Derivative,
                Role::Reference,
                Role::Asset,
                Role::Tool,
                Role::Backup,
                Role::Scratch,
                Role::System,
            ],
            Role::as_str,
            Role::from_str,
        );
        assert!(Role::from_str("archive").is_err(), "renamed to backup");
    }

    #[test]
    fn replaceability_round_trip() {
        round_trip(
            &[
                Replaceability::Regenerable,
                Replaceability::Redownloadable,
                Replaceability::RecoverableWithEffort,
                Replaceability::Irreplaceable,
                Replaceability::Unknown,
            ],
            Replaceability::as_str,
            Replaceability::from_str,
        );
    }

    #[test]
    fn sensitivity_round_trip_and_restricted_check() {
        round_trip(
            &[
                Sensitivity::Public,
                Sensitivity::Normal,
                Sensitivity::Private,
                Sensitivity::Restricted,
            ],
            Sensitivity::as_str,
            Sensitivity::from_str,
        );

        assert!(Sensitivity::Restricted.restricted_or_private());
        assert!(Sensitivity::Private.restricted_or_private());
        assert!(!Sensitivity::Normal.restricted_or_private());
        assert!(!Sensitivity::Public.restricted_or_private());
    }

    #[test]
    fn lifecycle_round_trip() {
        round_trip(
            &[
                Lifecycle::Planning,
                Lifecycle::Active,
                Lifecycle::Finished,
                Lifecycle::Archived,
                Lifecycle::Abandoned,
            ],
            Lifecycle::as_str,
            Lifecycle::from_str,
        );
    }

    #[test]
    fn origin_round_trip() {
        round_trip(
            &[
                Origin::UserCreated,
                Origin::WebDownload,
                Origin::PhoneScreenshot,
                Origin::PhoneCamera,
                Origin::MessengerReceived,
                Origin::AppExport,
                Origin::ArchiveExtracted,
                Origin::Unknown,
            ],
            Origin::as_str,
            Origin::from_str,
        );
    }
}
