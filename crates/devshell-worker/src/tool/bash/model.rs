use schemars::JsonSchema;
use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct BashRunParams {
    /// Shell command. Run long-lived services in the foreground with a short waitMs instead of '&'.
    #[schemars(length(min = 1))]
    pub command: String,
    #[serde(default)]
    /// Working directory. Bare relative paths and ./ paths are workspace-relative; absolute paths are also accepted.
    #[schemars(length(min = 1))]
    pub cwd: Option<String>,
    /// Environment variable overrides; null removes an inherited variable.
    #[serde(default)]
    pub env: BTreeMap<String, Option<String>>,
    /// Allocate a PTY at process creation (120x36); required to send interactive input via task_input.
    #[serde(default)]
    pub pty: bool,
    /// Milliseconds to wait before returning a running task ID and cursor (default 10000, max 3600000; does not stop the process). Context-bound calls >= 180000ms hand off to a background durable Wait.
    #[serde(default)]
    #[schemars(range(min = 0, max = 3600000))]
    pub wait_ms: Option<u64>,
}

pub use crate::tool::process::model::{BashRunOutput, BashTermination};
