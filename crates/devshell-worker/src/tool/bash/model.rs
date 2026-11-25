use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeMap;

use crate::capability::artifact::types::ArtifactReference;

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct BashRunParams {
    #[schemars(length(min = 1))]
    pub command: String,
    #[serde(default)]
    /// Working directory. Bare relative paths and ./ paths are workspace-relative; absolute paths are also accepted.
    #[schemars(length(min = 1))]
    pub cwd: Option<String>,
    #[serde(default)]
    /// Standard input text. Omit to close stdin immediately and deliver EOF.
    pub stdin: Option<String>,
    /// Optional hard execution deadline in milliseconds.
    #[schemars(range(min = 1, max = 100000))]
    pub timeout_ms: Option<u64>,
    /// Time to wait for the command before returning a running task ID.
    #[schemars(range(min = 0, max = 100000))]
    pub wait_ms: Option<u64>,
    /// Allocate a PTY at process creation.
    #[serde(default)]
    pub tty: bool,
    /// Keep pipe stdin open for later task_input.
    #[serde(default)]
    pub keep_stdin: bool,
    #[serde(default)]
    /// Maximum captured bytes per output stream. Defaults to 4194304.
    #[schemars(range(min = 1, max = 16777216))]
    pub max_capture_bytes: Option<usize>,
    #[serde(default)]
    pub env: BTreeMap<String, Option<String>>,
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
    pub task: Option<super::hosted::TaskDescriptor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<super::hosted::TaskCursor>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum BashTermination {
    Exited,
    Signaled,
    Timeout,
    Running,
}
