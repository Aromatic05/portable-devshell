use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, JsonSchema, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ArtifactStream {
    Stdout,
    Stderr,
}

#[derive(Clone, Debug, JsonSchema, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactReference {
    pub handle: String,
    pub stream: ArtifactStream,
    pub source_bytes: usize,
    pub stored_bytes: usize,
    pub artifact_truncated: bool,
    pub blake3: String,
    pub expires_at_ms: u128,
}
