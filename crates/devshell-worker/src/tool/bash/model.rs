use schemars::JsonSchema;
use serde::Deserialize;
use std::collections::BTreeMap;

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
    pub env: BTreeMap<String, Option<String>>,
    /// Allocate a PTY at process creation for interactive input.
    #[serde(default)]
    pub pty: bool,
    /// Time in milliseconds to wait for the command before returning a running task ID (default 10000).
    #[serde(default)]
    #[schemars(range(min = 0, max = 3600000))]
    pub wait_ms: Option<u64>,
}

pub use crate::tool::process::model::{BashRunOutput, BashTermination};
