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
    /// Standard input text. Omit to close stdin immediately and deliver EOF.
    pub stdin: Option<String>,
    /// Optional hard execution deadline in milliseconds.
    #[schemars(range(min = 1, max = 100000))]
    pub timeout_ms: Option<u64>,
    /// Time to wait for the command before returning a running task ID.
    #[schemars(range(min = 0, max = 3600000))]
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

pub use crate::tool::process::model::{BashRunOutput, BashTermination};
