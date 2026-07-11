use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct BashRunParams {
    pub command: String,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub stdin: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
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
    pub stdout: String,
    pub stderr: String,
    pub stdout_bytes: usize,
    pub stderr_bytes: usize,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub duration_ms: u128,
    pub termination: BashTermination,
}

#[derive(Debug, PartialEq, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum BashTermination {
    Exited,
    Signaled,
    Timeout,
}
