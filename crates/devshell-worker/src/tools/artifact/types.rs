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

#[derive(Clone, Copy, Debug, Default, Deserialize, JsonSchema, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ArtifactEncoding {
    #[default]
    Utf8,
    Base64,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactReadInput {
    pub handle: String,
    pub offset_bytes: Option<u64>,
    pub max_bytes: Option<usize>,
    pub encoding: Option<ArtifactEncoding>,
}

#[derive(Debug, JsonSchema, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactReadOutput {
    pub handle: String,
    pub stream: ArtifactStream,
    pub offset_bytes: u64,
    pub returned_bytes: usize,
    pub total_bytes: usize,
    pub source_bytes: usize,
    pub content: String,
    pub encoding: ArtifactEncoding,
    pub lossy: bool,
    pub eof: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_offset_bytes: Option<u64>,
    pub artifact_truncated: bool,
    pub blake3: String,
    pub expires_at_ms: u128,
}
