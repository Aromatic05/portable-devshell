use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use schemars::JsonSchema;
use serde::Serialize;

use crate::capability::artifact::types::ArtifactReference;
use crate::tool::ToolError;

const CURSOR_PREFIX: &str = "tc1_";

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct TaskCursor {
    pub seq: u64,
    pub stdout: usize,
    pub stderr: usize,
}

impl TaskCursor {
    pub(crate) fn encode(&self) -> String {
        let payload = format!("{}:{}:{}", self.seq, self.stdout, self.stderr);
        format!("{CURSOR_PREFIX}{}", URL_SAFE_NO_PAD.encode(payload))
    }

    pub(crate) fn decode(raw: &str) -> Result<Self, ToolError> {
        let invalid = || ToolError::new("tool.invalidArguments", "invalid task cursor");
        let encoded = raw.strip_prefix(CURSOR_PREFIX).ok_or_else(invalid)?;
        let bytes = URL_SAFE_NO_PAD.decode(encoded).map_err(|_| invalid())?;
        let text = std::str::from_utf8(&bytes).map_err(|_| invalid())?;
        let mut parts = text.split(':');
        let seq = parts
            .next()
            .ok_or_else(invalid)?
            .parse::<u64>()
            .map_err(|_| invalid())?;
        let stdout = parts
            .next()
            .ok_or_else(invalid)?
            .parse::<usize>()
            .map_err(|_| invalid())?;
        let stderr = parts
            .next()
            .ok_or_else(invalid)?
            .parse::<usize>()
            .map_err(|_| invalid())?;
        if parts.next().is_some() {
            return Err(invalid());
        }
        Ok(Self {
            seq,
            stdout,
            stderr,
        })
    }
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TaskDescriptor {
    pub id: String,
    pub status: String,
    pub pty: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub human_control: Option<bool>,
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
    pub until_exit: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task: Option<TaskDescriptor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum BashTermination {
    Exited,
    Signaled,
    Timeout,
    Running,
}

#[cfg(test)]
mod tests {
    use super::TaskCursor;

    #[test]
    fn opaque_cursor_round_trips_and_rejects_malformed_values() {
        let cursor = TaskCursor {
            seq: 42,
            stdout: 1024,
            stderr: 256,
        };
        let encoded = cursor.encode();
        assert!(encoded.starts_with("tc1_"));
        assert_eq!(TaskCursor::decode(&encoded).unwrap(), cursor);

        for invalid in ["", "tc1_", "tc2_MToyOjM", "tc1_!!!", "tc1_MTox", "tc1_MToxOjI6Mw"] {
            let err = TaskCursor::decode(invalid).unwrap_err();
            assert_eq!(err.code, "tool.invalidArguments");
            assert_eq!(err.message, "invalid task cursor");
        }
    }
}
