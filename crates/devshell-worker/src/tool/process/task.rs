use super::capture::BashProgress;
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
    /// Opaque cursor returned for this same task.
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
                        "input": "Raw UTF-8 text to write to a PTY task/terminal (use \\r for Enter in TUIs/ConPTY or \\n in line-oriented shells, \\u0003 for Ctrl+C, \\u0004 for Ctrl+D). Omit or pass \"\" to read/poll without writing. When writing input without cursor, only output after this input is returned.",
                        "cursor": "Use the opaque cursor returned for this same task by bash_run, task_manage(create), or a previous task_input call.",
                        "waitMs": "Milliseconds to wait for output or exit (default 5000, max 3600000).",
                        "untilExit": "Set true to wait until a non-persistent task exits rather than returning on the next output (invalid for persistent terminals)."
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
        let explicit_cursor = params
            .cursor
            .as_deref()
            .map(|cursor| TaskCursor::decode_for(cursor, &params.task))
            .transpose()?;

        let input_to_send = params.input.as_deref().filter(|text| !text.is_empty());
        let wrote_input = input_to_send.is_some();

        let (client, descriptor, cursor) = if let Some(input) = input_to_send {
            require_execute(&call)?;
            if input.len() > MAX_INPUT_BYTES {
                return Err(ToolError::new("tool.invalidArguments", "input too large"));
            }
            let client = connect(&self.instance)?;
            let descriptor = require(&client, &call, &params.task)?;
            if params.until_exit
                && descriptor["persistent"] == true
                && descriptor["state"] == "running"
            {
                return Err(ToolError::new(
                    "tool.invalidArguments",
                    "untilExit cannot be used on running persistent interactive terminals because they automatically respawn on shell exit; omit untilExit to poll for output, or use bash_run for commands that exit",
                ));
            }
            // When writing new input without an explicit cursor, anchor at the
            // current stream tail so the caller sees only output following this
            // input instead of replaying the entire historical transcript.
            let cursor = match explicit_cursor {
                Some(cursor) => cursor,
                None => current_tail_cursor(&client, &params.task, &descriptor)?,
            };
            rpc(
                &client,
                "process.v1.input",
                json!({"id": params.task, "dataBase64": STANDARD.encode(input)}),
            )?;
            (client, descriptor, cursor)
        } else {
            require_read(&call)?;
            let client = connect(&self.instance)?;
            let descriptor = require(&client, &call, &params.task)?;
            if params.until_exit
                && descriptor["persistent"] == true
                && descriptor["state"] == "running"
            {
                return Err(ToolError::new(
                    "tool.invalidArguments",
                    "untilExit cannot be used on running persistent interactive terminals because they automatically respawn on shell exit; omit untilExit to poll for output, or use bash_run for commands that exit",
                ));
            }
            (client, descriptor, explicit_cursor.unwrap_or_default())
        };

        let started = Instant::now();
        let pre_wait_seq = descriptor["latestSeq"].as_u64().unwrap_or(0);
        let wait_from_seq = if wrote_input {
            cursor.seq.max(pre_wait_seq)
        } else {
            cursor.seq
        };
        let until_output = !params.until_exit;
        let settle_ms = if until_output && wait_ms > 0 {
            INPUT_SETTLE_MS
        } else {
            0
        };
        let progress = Arc::new(BashProgress::new(started, call.progress()));
        progress.emit_initial();
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
            Some(&progress),
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
            progress,
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

fn current_tail_cursor(
    client: &crate::capability::process::client::ProcessHostClient,
    id: &str,
    descriptor: &Value,
) -> Result<TaskCursor, ToolError> {
    let stdout_meta = rpc(
        client,
        "process.v1.capture",
        json!({"id": id, "channel": "stdout", "offset": 0, "limit": 0}),
    )?;
    let stderr_meta = rpc(
        client,
        "process.v1.capture",
        json!({"id": id, "channel": "stderr", "offset": 0, "limit": 0}),
    )?;
    let stdout = stdout_meta["storedBytes"].as_u64().unwrap_or(0) as usize;
    let stderr = stderr_meta["storedBytes"].as_u64().unwrap_or(0) as usize;
    let stdout_seq = stdout_meta["latestSeq"].as_u64().unwrap_or(0);
    let stderr_seq = stderr_meta["latestSeq"].as_u64().unwrap_or(0);
    let seq = stdout_seq
        .min(stderr_seq)
        .max(descriptor["latestSeq"].as_u64().unwrap_or(0));
    Ok(TaskCursor {
        seq,
        stdout,
        stderr,
    })
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
