use rusqlite;

#[derive(Debug)]
pub enum OntologyError {
    Sqlite(rusqlite::Error),
    InvalidVocabulary(String),
    EntityNotFound(i64),
    OntologyDisabled,
    Populator(String),
    Json(String),
    /// A refusal written for the person reading it. api.rs turns this into the
    /// `Result<_, String>` the UI shows verbatim, so it carries no prefix and
    /// no jargon — it is already the sentence.
    Refused(String),
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
            // These two reach the user: api.rs maps OntologyError into Result<_, String>, and the
            // UI shows that string verbatim in a toast. Say it the way you'd say it out loud.
            Self::OntologyDisabled => write!(f, "the analysis is turned off for this index"),
            Self::Populator(msg) => write!(f, "analysis error: {msg}"),
            Self::Json(msg) => write!(f, "json error: {msg}"),
            Self::Refused(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for OntologyError {}
