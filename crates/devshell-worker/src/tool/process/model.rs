use crate::capability::artifact::types::ArtifactReference;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskCursor {
    #[serde(default)]
    pub seq: u64,
    #[serde(default)]
    pub stdout: usize,
    #[serde(default)]
    pub stderr: usize,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TaskDescriptor {
    pub id: String,
    pub status: String,
    pub tty: bool,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BashRunOutput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub term_signal: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timed_out: Option<bool>,
    pub stdout: String,
    pub stderr: String,
    pub stdout_bytes: usize,
    pub stderr_bytes: usize,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    /// Read-only virtual path for retained stdout when recovery storage is available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdout_path: Option<String>,
    /// Read-only virtual path for retained stderr when recovery storage is available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdout_artifact: Option<ArtifactReference>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr_artifact: Option<ArtifactReference>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact_warnings: Option<Vec<String>>,
    pub duration_ms: u128,
    pub termination: BashTermination,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wait_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wait_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task: Option<TaskDescriptor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<TaskCursor>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum BashTermination {
    Exited,
    Signaled,
    Timeout,
    Running,
}
