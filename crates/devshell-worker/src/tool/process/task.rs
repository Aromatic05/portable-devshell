use super::model::{BashRunOutput, BashTermination, TaskCursor};
use super::output::collect;
use super::scope::*;
use crate::capability::artifact::store::ArtifactStore;
use crate::instance::InstanceName;
use crate::tool::contract::{catalog_entry_with_meta, serialize};
use crate::tool::{
    ToolCall, ToolCapability, ToolCatalogEntry, ToolError, ToolHandler, ToolName, ToolRegistry,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Instant;

const DEFAULT_CAPTURE: usize = 4 * 1024 * 1024;
const DEFAULT_WAIT_MS: u64 = 5_000;
const MAX_WAIT_MS: u64 = 3_600_000;
const MAX_INPUT_BYTES: usize = 4 * 1024 * 1024;
const INPUT_SETTLE_MS: u64 = 150;

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskInputParams {
    #[schemars(length(min = 1))]
    task: String,
    /// Raw UTF-8 text to write to a PTY task/terminal. Omit or pass "" to read/poll without writing.
    #[serde(default)]
    input: Option<String>,
    /// Opaque cursor returned by bash_run or a previous task_input call.
    #[serde(default)]
    cursor: Option<String>,
    /// Time in milliseconds to wait for output or exit (default 5000, max 3600000).
    #[serde(default)]
    #[schemars(range(min = 0, max = 3600000))]
    wait_ms: Option<u64>,
    /// Wait for process exit instead of returning on new output.
    #[serde(default)]
    until_exit: bool,
}

struct TaskInputTool {
    name: ToolName,
    instance: InstanceName,
    artifacts: Arc<ArtifactStore>,
    #[cfg_attr(windows, allow(dead_code))]
    files: Arc<crate::tool::file::FileToolState>,
}

impl ToolHandler for TaskInputTool {
    fn name(&self) -> &ToolName {
        &self.name
    }

    fn catalog_entry(&self) -> ToolCatalogEntry {
        catalog_entry_with_meta::<TaskInputParams, BashRunOutput>(
            &self.name,
            "Send raw UTF-8 input to a PTY task or terminal and wait for output, or omit input to read/poll output from an opaque cursor.",
            [ToolCapability::Execute],
            json!({
                "devshell": { "mcp": {
                    "annotations": {
                        "destructiveHint": true,
                        "idempotentHint": false,
                        "openWorldHint": true,
                        "readOnlyHint": false
                    },
                    "inputHints": {
                        "task": "Task or terminal ID returned by bash_run or task_manage.",
                        "input": "Raw UTF-8 text to write to a PTY task/terminal (use \\n for Enter, \\u0003 for Ctrl+C, \\u0004 for Ctrl+D). Omit or pass \"\" to read/poll without writing.",
                        "cursor": "Opaque cursor returned by bash_run or a previous task_input call to continue reading new output.",
                        "waitMs": "Milliseconds to wait for output or exit (default 5000, max 3600000).",
                        "untilExit": "Set true to wait until the task exits rather than returning on the next output."
                    },
                    "title": "Send input or read task output"
                }}
            }),
        )
    }

    fn call(&self, call: ToolCall) -> Result<Value, ToolError> {
        call.check_cancelled()?;
        let params: TaskInputParams = call.parse_params()?;
        if params.task.trim().is_empty() {
            return Err(ToolError::new(
                "tool.invalidArguments",
                "task cannot be empty",
            ));
        }
        let wait_ms = params.wait_ms.unwrap_or(DEFAULT_WAIT_MS);
        if wait_ms > MAX_WAIT_MS {
            return Err(ToolError::new(
                "tool.invalidArguments",
                "waitMs cannot exceed 3600000",
            ));
        }
        let cursor = params
            .cursor
            .as_deref()
            .map(TaskCursor::decode)
            .transpose()?
            .unwrap_or_default();

        let input_to_send = params.input.as_deref().filter(|text| !text.is_empty());
        let wrote_input = input_to_send.is_some();

        let (client, descriptor) = if let Some(input) = input_to_send {
            require_execute(&call)?;
            if input.len() > MAX_INPUT_BYTES {
                return Err(ToolError::new("tool.invalidArguments", "input too large"));
            }
            let client = connect(&self.instance)?;
            let descriptor = require(&client, &call, &params.task)?;
            rpc(
                &client,
                "process.v1.input",
                json!({"id": params.task, "dataBase64": STANDARD.encode(input)}),
            )?;
            (client, descriptor)
        } else {
            require_read(&call)?;
            let client = connect(&self.instance)?;
            let descriptor = require(&client, &call, &params.task)?;
            (client, descriptor)
        };

        let started = Instant::now();
        let pre_wait_seq = descriptor["latestSeq"].as_u64().unwrap_or(0);
        let wait_from_seq = if wrote_input {
            cursor.seq.max(pre_wait_seq)
        } else {
            cursor.seq
        };
        let until_output = !params.until_exit;
        let settle_ms = if until_output && wrote_input {
            INPUT_SETTLE_MS
        } else {
            0
        };
        let descriptor = wait_for(
            &client,
            &call,
            &params.task,
            descriptor,
            wait_from_seq,
            wait_ms,
            until_output,
            false,
            settle_ms,
        )?;
        let reason = if descriptor["state"] != "running" {
            "terminal"
        } else if until_output && descriptor["latestSeq"].as_u64().unwrap_or(0) > wait_from_seq {
            "output"
        } else {
            "timeout"
        };
        let mut result = collect(
            &client,
            &self.artifacts,
            &params.task,
            descriptor,
            cursor,
            DEFAULT_CAPTURE,
            started,
            &call,
        )?;
        result.wait_reason = Some(reason.into());
        result.wait_ms = Some(wait_ms);
        result.until_exit = params.until_exit.then_some(true);

        #[cfg(unix)]
        if !call.stateless
            && result.termination == BashTermination::Exited
            && cursor.stdout == 0
            && !result.stdout_truncated
            && !result.stderr_truncated
            && result.stdout_bytes.saturating_add(result.stderr_bytes)
                <= crate::tool::file::observation::MAX_OUTPUT_BYTES
            && !result.stdout.is_empty()
        {
            let source = rpc(&client, "process.v1.provenance", json!({"id": params.task}))?;
            if let (Some(command), Some(cwd)) =
                (source["command"].as_str(), source["cwd"].as_str())
                && let Some(plan) = crate::tool::file::observation::CommandReadPlan::analyze(
                    command,
                    std::path::Path::new(cwd),
                )
            {
                plan.observe(&call, &self.files, &result.stdout);
            }
        }
        serialize(result)
    }
}

pub(crate) fn register_tools(
    registry: &mut ToolRegistry,
    instance: &InstanceName,
    artifacts: Arc<ArtifactStore>,
    files: Arc<crate::tool::file::FileToolState>,
) -> Result<(), ToolError> {
    registry.register(Arc::new(TaskInputTool {
        name: ToolName::parse("task_input").map_err(error)?,
        instance: instance.clone(),
        artifacts,
        files,
    }))?;
    Ok(())
}
