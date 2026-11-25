use super::model::{BashRunOutput, TaskCursor};
use super::output::collect;
use super::scope::*;
use crate::capability::artifact::store::ArtifactStore;
use crate::instance::InstanceName;
use crate::tool::contract::{catalog_entry, serialize};
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

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadParams {
    task: String,
    #[serde(default)]
    cursor: TaskCursor,
    #[serde(default)]
    #[schemars(range(min = 0, max = 100000))]
    time_ms: u64,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InputParams {
    task: String,
    input: Option<String>,
    #[serde(default)]
    eof: bool,
}

struct TaskTool {
    name: ToolName,
    instance: InstanceName,
    artifacts: Arc<ArtifactStore>,
}

impl ToolHandler for TaskTool {
    fn name(&self) -> &ToolName {
        &self.name
    }
    fn catalog_entry(&self) -> ToolCatalogEntry {
        match self.name.as_str().as_str() {
            "task_read" => catalog_entry::<ReadParams, BashRunOutput>(
                &self.name,
                "Read task output from an independent cursor; optionally wait for new output. Use returned cursor for the next read.",
                [ToolCapability::Read],
            ),
            "task_input" => catalog_entry::<InputParams, Value>(
                &self.name,
                "Send literal input to a task/terminal or close pipe stdin with eof.",
                [ToolCapability::Execute],
            ),
            _ => unreachable!("task tool name"),
        }
    }
    fn call(&self, call: ToolCall) -> Result<Value, ToolError> {
        call.check_cancelled()?;
        match self.name.as_str().as_str() {
            "task_read" => {
                require_read(&call)?;
                let params: ReadParams = call.parse_params()?;
                if params.time_ms > 100000 {
                    return Err(ToolError::new(
                        "tool.invalidArguments",
                        "timeMs cannot exceed 100000",
                    ));
                }
                let client = connect(&self.instance)?;
                let descriptor = require(&client, &call, &params.task)?;
                let started = Instant::now();
                let descriptor = wait_for(
                    &client,
                    &call,
                    &params.task,
                    descriptor,
                    params.cursor.seq,
                    params.time_ms,
                    true,
                    false,
                )?;
                serialize(collect(
                    &client,
                    &self.artifacts,
                    &params.task,
                    descriptor,
                    params.cursor,
                    DEFAULT_CAPTURE,
                    started,
                    &call,
                )?)
            }
            "task_input" => {
                let params: InputParams = call.parse_params()?;
                require_execute(&call)?;
                let client = connect(&self.instance)?;
                require(&client, &call, &params.task)?;
                if let Some(input) = params.input {
                    if input.len() > 4 * 1024 * 1024 {
                        return Err(ToolError::new("tool.invalidArguments", "input too large"));
                    }
                    rpc(
                        &client,
                        "process.v1.input",
                        json!({"id": params.task, "dataBase64": STANDARD.encode(input)}),
                    )?;
                }
                if params.eof {
                    rpc(&client, "process.v1.closeInput", json!({"id": params.task}))?;
                }
                Ok(json!({"task": params.task, "accepted": true}))
            }
            _ => unreachable!("task tool name"),
        }
    }
}

pub(crate) fn register_tools(
    registry: &mut ToolRegistry,
    instance: &InstanceName,
    artifacts: Arc<ArtifactStore>,
) -> Result<(), ToolError> {
    for name in ["task_read", "task_input"] {
        registry.register(Arc::new(TaskTool {
            name: ToolName::parse(name).map_err(error)?,
            instance: instance.clone(),
            artifacts: Arc::clone(&artifacts),
        }))?;
    }
    Ok(())
}
