use rusqlite;

#[derive(Debug)]
pub enum OntologyError {
    Sqlite(rusqlite::Error),
    InvalidVocabulary(String),
    EntityNotFound(i64),
    OntologyDisabled,
    Populator(String),
    Json(String),
}

impl From<rusqlite::Error> for OntologyError {
    fn from(err: rusqlite::Error) -> Self {
        OntologyError::Sqlite(err)
    }
}

impl From<serde_json::Error> for OntologyError {
    fn from(err: serde_json::Error) -> Self {
        OntologyError::Json(err.to_string())
    }
}

impl std::fmt::Display for OntologyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Sqlite(e) => write!(f, "sqlite error: {e}"),
            Self::InvalidVocabulary(v) => write!(f, "invalid vocabulary value: {v}"),
            Self::EntityNotFound(id) => write!(f, "entity not found: {id}"),
            Self::OntologyDisabled => write!(f, "ontology layer is disabled for this index"),
            Self::Populator(msg) => write!(f, "populator error: {msg}"),
            Self::Json(msg) => write!(f, "json error: {msg}"),
        }
    }
}

impl std::error::Error for OntologyError {}
