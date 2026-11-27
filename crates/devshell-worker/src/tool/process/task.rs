use super::capture::BashProgress;
use super::model::{BashRunOutput, BashTermination, TaskCursor};
use super::output::{OutputBoundary, collect};
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
    /// Task or persistent terminal ID returned by bash_run or task_manage.
    #[schemars(length(min = 1))]
    task: String,
    /// Raw UTF-8 text to write to a running PTY task/terminal (\r for Enter in TUIs/ConPTY, \n in line shells, \u0003 for Ctrl+C, \u0004 for Ctrl+D, \u001b for Esc, \u001b[A/B/C/D for arrows). Omit or pass "" to read/poll any pipe or PTY task without writing.
    #[serde(default)]
    input: Option<String>,
    /// Opaque cursor returned for this same task. Always pass cursor when polling; omitting it on a read-only poll replays from byte 0 (omitting it when writing input anchors at the current tail).
    #[serde(default)]
    cursor: Option<String>,
    /// Milliseconds to wait for output or exit (default 5000, max 3600000; context-bound waits cap at 120000ms synchronously, and untilExit waits >= 120000ms detach to durable Wait).
    #[serde(default)]
    #[schemars(range(min = 0, max = 3600000))]
    wait_ms: Option<u64>,
    /// Wait for a non-persistent task to exit instead of returning on new output (invalid for running persistent terminals).
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
            "Read/poll output from any pipe or PTY task (omit or pass empty input), or send raw UTF-8 input to a running PTY task/terminal and wait for output. Always pass the returned cursor when polling to avoid replaying output from byte 0.",
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
                        "task": "Task or persistent terminal ID returned by bash_run or task_manage.",
                        "input": "Raw UTF-8 text to write to a running PTY task/terminal (use \\r for Enter in TUIs/ConPTY, \\n in line-oriented shells, \\u0003 for Ctrl+C, \\u0004 for Ctrl+D, \\u001b for Esc, \\u001b[A/B/C/D for arrows). Omit or pass \"\" to read/poll output from any pipe or PTY task without writing. When writing input without cursor, only output after this input is returned.",
                        "cursor": "Opaque cursor returned for this same task by bash_run, task_manage(create), or a previous task_input call. Always pass cursor when polling; omitting cursor on a read-only poll replays all retained output from byte 0.",
                        "waitMs": "Milliseconds to wait for output or exit (default 5000, max 3600000; context-bound waits cap at 120000ms synchronously, and untilExit waits >= 120000ms detach to durable Wait).",
                        "untilExit": "Set true to wait until a non-persistent task exits rather than returning on new output (invalid for running persistent terminals)."
                    },
                    "title": "Send input or read task output"
                }}
            }),
        )
    }

    fn call(&self, call: ToolCall) -> Result<Value, ToolError> {
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
        check_observation_cancelled(&call, &params.task, explicit_cursor.unwrap_or_default())?;

        let input_to_send = params.input.as_deref().filter(|text| !text.is_empty());
        let wrote_input = input_to_send.is_some();
        let input_generation = explicit_cursor.and_then(|cursor| cursor.generation);

        let (client, mut descriptor, cursor, _lease) = if let Some(input) = input_to_send {
            require_execute(&call)?;
            if input.len() > MAX_INPUT_BYTES {
                return Err(ToolError::new("tool.invalidArguments", "input too large"));
            }
            let client = connect(&self.instance)?;
            let (descriptor, lease) = require(&client, &call, &params.task)?;
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
                None => {
                    let mut cursor = OutputBoundary::from_descriptor(&descriptor)?.cursor();
                    cursor.generation = None;
                    cursor
                }
            };
            let resume = resume_cursor(cursor, &descriptor);
            check_observation_cancelled(&call, &params.task, resume)?;
            let written = rpc(
                &client,
                "process.v1.input",
                json!({
                    "id": params.task,
                    "dataBase64": STANDARD.encode(input),
                    "shellGeneration": input_generation,
                }),
            );
            check_observation_cancelled(&call, &params.task, resume)?;
            written?;
            (client, descriptor, cursor, lease)
        } else {
            require_read(&call)?;
            let client = connect(&self.instance)?;
            let (descriptor, lease) = require(&client, &call, &params.task)?;
            if params.until_exit
                && descriptor["persistent"] == true
                && descriptor["state"] == "running"
            {
                return Err(ToolError::new(
                    "tool.invalidArguments",
                    "untilExit cannot be used on running persistent interactive terminals because they automatically respawn on shell exit; omit untilExit to poll for output, or use bash_run for commands that exit",
                ));
            }
            (client, descriptor, explicit_cursor.unwrap_or_default(), lease)
        };

        if let Some(expected) = cursor.generation
            && descriptor["shellGeneration"].as_u64() != Some(expected)
        {
            return Err(ToolError::new(
                "process.staleCursor",
                "task cursor belongs to a previous shell instance",
            ));
        }
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
        let observation_generation = (!wrote_input)
            .then_some(cursor.generation)
            .flatten();
        let progress = Arc::new(BashProgress::new(started, call.progress()));
        progress.emit_initial();
        let resume = resume_cursor(cursor, &descriptor);
        let waited = wait_for(
            &client,
            &call,
            &params.task,
            &mut descriptor,
            wait_from_seq,
            observation_generation,
            wait_ms,
            until_output,
            settle_ms,
            Some(&progress),
        );
        check_observation_cancelled(&call, &params.task, resume)?;
        waited?;
        let reason = if descriptor["state"] != "running" {
            "terminal"
        } else if until_output && descriptor["latestSeq"].as_u64().unwrap_or(0) > wait_from_seq {
            "output"
        } else {
            "timeout"
        };
        let collected = collect(
            &client,
            &self.artifacts,
            &params.task,
            descriptor,
            TaskCursor {
                generation: observation_generation,
                ..cursor
            },
            DEFAULT_CAPTURE,
            started,
            progress,
        );
        check_observation_cancelled(&call, &params.task, resume)?;
        let mut result = collected?;
        result.wait_reason = Some(reason.into());
        result.wait_ms = Some(wait_ms);
        result.until_exit = params.until_exit.then_some(true);
        if call.wait_handoff && params.until_exit && reason == "timeout" {
            super::scope::pin_wait(&client, &call, &params.task).map_err(|failure| {
                failure.with_details(json!({"taskId": params.task, "cursor": result.cursor}))
            })?;
        }

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
            if let Ok(source) = rpc(&client, "process.v1.provenance", json!({"id": params.task}))
                && let (Some(command), Some(cwd)) =
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

// Resume at the read boundary from before this call consumed any output.
fn resume_cursor(cursor: TaskCursor, descriptor: &Value) -> TaskCursor {
    TaskCursor {
        generation: cursor.generation.or_else(|| descriptor["shellGeneration"].as_u64()),
        ..cursor
    }
}

fn check_observation_cancelled(call: &ToolCall, task: &str, cursor: TaskCursor) -> Result<(), ToolError> {
    call.check_cancelled().map_err(|cancelled| {
        let mut details = json!({"taskId": task});
        if cursor.generation.is_some() {
            details["cursor"] = json!(cursor.encode(task));
        }
        cancelled.with_details(details)
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
