use super::scope::*;
use crate::capability::process::client::ProcessHostClient;
use crate::instance::InstanceName;
use crate::instance::storage::InstancePaths;
use crate::tool::contract::{catalog_entry_with_meta, serialize};
use crate::tool::{
    ToolCall, ToolCapability, ToolCatalogEntry, ToolError, ToolHandler, ToolName, ToolRegistry,
};
use crate::transport::endpoint::channel::EndpointPaths;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::Arc;

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InspectParams {
    /// Task or terminal ID to inspect (must be a PTY task or interactive terminal).
    #[schemars(length(min = 1))]
    task: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InspectSnapshot {
    seq: u64,
    rows: u16,
    cols: u16,
    cursor_row: u16,
    cursor_col: u16,
    alternate_screen: bool,
    text: String,
}

#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct TaskInspectOutput {
    task: String,
    state: String,
    human_control: bool,
    seq: u64,
    rows: u16,
    cols: u16,
    cursor_row: u16,
    cursor_col: u16,
    alternate_screen: bool,
    text: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, JsonSchema)]
#[serde(rename_all = "lowercase")]
enum TaskManageCommand {
    List,
    Create,
    Close,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManageParams {
    /// Management operation: list, create, or close.
    command: TaskManageCommand,
    /// Task or terminal ID to close (required for close; invalid for list/create).
    #[serde(default)]
    #[schemars(length(min = 1))]
    task: Option<String>,
    /// Optional human-readable name for create (1-64 ASCII alphanumeric or ._-).
    #[serde(default)]
    #[schemars(length(min = 1, max = 64))]
    name: Option<String>,
    /// Working directory for create (workspace-relative or absolute; required absolute in stateless mode).
    #[serde(default)]
    #[schemars(length(min = 1))]
    cwd: Option<String>,
    /// Optional shell executable for create (defaults to user login shell).
    #[serde(default)]
    #[schemars(length(min = 1))]
    shell: Option<String>,
    /// Optional initial terminal columns for create (default 80).
    #[serde(default)]
    #[schemars(range(min = 1, max = 1000))]
    cols: Option<u16>,
    /// Optional initial terminal rows for create (default 24).
    #[serde(default)]
    #[schemars(range(min = 1, max = 1000))]
    rows: Option<u16>,
}

#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct TaskSummary {
    id: String,
    kind: String,
    persistent: bool,
    pty: bool,
    state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    command: Option<String>,
    human_control: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<i32>,
    created_at_ms: u128,
}

#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct TaskManageOutput {
    #[serde(skip_serializing_if = "Option::is_none")]
    tasks: Option<Vec<TaskSummary>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    task: Option<TaskSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    closed_task: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    accepted: Option<bool>,
}

struct TerminalTool {
    name: ToolName,
    instance: InstanceName,
}

impl ToolHandler for TerminalTool {
    fn name(&self) -> &ToolName {
        &self.name
    }

    fn catalog_entry(&self) -> ToolCatalogEntry {
        match self.name.as_str().as_str() {
            "task_inspect" => catalog_entry_with_meta::<InspectParams, TaskInspectOutput>(
                &self.name,
                "Inspect the current visible terminal screen of a PTY task or interactive terminal without advancing cursors.",
                [ToolCapability::Read],
                json!({
                    "devshell": { "mcp": {
                        "annotations": {
                            "destructiveHint": false,
                            "idempotentHint": true,
                            "openWorldHint": false,
                            "readOnlyHint": true
                        },
                        "inputHints": {
                            "task": "Task or terminal ID to inspect; must be a PTY task or interactive terminal."
                        },
                        "title": "Inspect terminal screen"
                    }}
                }),
            ),
            _ => catalog_entry_with_meta::<ManageParams, TaskManageOutput>(
                &self.name,
                "List tasks and terminals, create a persistent interactive terminal, or close a running task/terminal in the current execution scope.",
                [ToolCapability::Execute],
                json!({
                    "devshell": { "mcp": {
                        "annotations": {
                            "destructiveHint": true,
                            "idempotentHint": false,
                            "openWorldHint": false,
                            "readOnlyHint": false
                        },
                        "inputHints": {
                            "command": "Operation to perform: list, create, or close.",
                            "task": "Task or terminal ID to close (required for close; forbidden for list/create).",
                            "name": "Optional name for create (1-64 ASCII alphanumeric or ._-).",
                            "cwd": "Working directory for create; workspace-relative or absolute (required absolute in stateless mode).",
                            "shell": "Optional shell executable for create; defaults to the user login shell.",
                            "cols": "Optional terminal width in columns for create (default 80).",
                            "rows": "Optional terminal height in rows for create (default 24)."
                        },
                        "title": "Manage tasks and interactive terminals"
                    }}
                }),
            ),
        }
    }

    fn call(&self, call: ToolCall) -> Result<Value, ToolError> {
        call.check_cancelled()?;
        match self.name.as_str().as_str() {
            "task_inspect" => {
                require_read(&call)?;
                let params: InspectParams = call.parse_params()?;
                if params.task.trim().is_empty() {
                    return Err(ToolError::new(
                        "tool.invalidArguments",
                        "task cannot be empty",
                    ));
                }
                let client = connect(&self.instance)?;
                let descriptor = require(&client, &call, &params.task)?;
                let raw_snapshot = rpc(&client, "process.v1.inspect", json!({"id": params.task}))?;
                let snapshot: InspectSnapshot = serde_json::from_value(raw_snapshot)
                    .map_err(|failure| error(failure.to_string()))?;
                let output = TaskInspectOutput {
                    task: params.task,
                    state: descriptor["state"]
                        .as_str()
                        .unwrap_or("unknown")
                        .to_string(),
                    human_control: descriptor["humanControl"].as_bool().unwrap_or(false),
                    seq: snapshot.seq,
                    rows: snapshot.rows,
                    cols: snapshot.cols,
                    cursor_row: snapshot.cursor_row,
                    cursor_col: snapshot.cursor_col,
                    alternate_screen: snapshot.alternate_screen,
                    text: snapshot.text,
                };
                serialize(output)
            }
            _ => {
                let params: ManageParams = call.parse_params()?;
                match params.command {
                    TaskManageCommand::List => {
                        if params.task.is_some()
                            || params.name.is_some()
                            || params.cwd.is_some()
                            || params.shell.is_some()
                            || params.cols.is_some()
                            || params.rows.is_some()
                        {
                            return Err(ToolError::new(
                                "tool.invalidArguments",
                                "list does not accept task, name, cwd, shell, cols, or rows",
                            ));
                        }
                        require_read(&call)?;
                        let paths = InstancePaths::resolve(&self.instance).map_err(error)?;
                        let endpoints = EndpointPaths::resolve(&self.instance).map_err(error)?;
                        let Some(client) =
                            ProcessHostClient::connect(&self.instance, &paths, &endpoints)
                                .map_err(error)?
                        else {
                            return serialize(TaskManageOutput {
                                tasks: Some(Vec::new()),
                                task: None,
                                closed_task: None,
                                accepted: None,
                            });
                        };
                        let mut tasks = Vec::new();
                        for descriptor in client
                            .list()
                            .map_err(error)?
                            .as_array()
                            .ok_or_else(|| error("invalid resource list"))?
                        {
                            if scoped(&call, descriptor)? {
                                tasks.push(summarize(descriptor)?);
                            }
                        }
                        serialize(TaskManageOutput {
                            tasks: Some(tasks),
                            task: None,
                            closed_task: None,
                            accepted: None,
                        })
                    }
                    TaskManageCommand::Create => {
                        if params.task.is_some() {
                            return Err(ToolError::new(
                                "tool.invalidArguments",
                                "create does not accept task",
                            ));
                        }
                        require_execute(&call)?;
                        if call.stateless && params.cwd.is_none() {
                            return Err(ToolError::new(
                                "tool.invalidArguments",
                                "absolute cwd is required in stateless mode",
                            ));
                        }
                        let client = ProcessHostClient::ensure(&self.instance).map_err(error)?;
                        let created = rpc(
                            &client,
                            "process.v1.spawn",
                            json!({
                                "command": params.shell.unwrap_or_default(),
                                "interactive": true,
                                "persistent": true,
                                "tty": true,
                                "name": params.name,
                                "cwd": params.cwd.unwrap_or_else(|| "./".into()),
                                "workspace": (!call.stateless).then_some(&call.workspace),
                                "cols": params.cols,
                                "rows": params.rows,
                            }),
                        )?;
                        serialize(TaskManageOutput {
                            tasks: None,
                            task: Some(summarize(&created)?),
                            closed_task: None,
                            accepted: None,
                        })
                    }
                    TaskManageCommand::Close => {
                        if params.name.is_some()
                            || params.cwd.is_some()
                            || params.shell.is_some()
                            || params.cols.is_some()
                            || params.rows.is_some()
                        {
                            return Err(ToolError::new(
                                "tool.invalidArguments",
                                "close does not accept name, cwd, shell, cols, or rows",
                            ));
                        }
                        let id = params
                            .task
                            .filter(|value| !value.trim().is_empty())
                            .ok_or_else(|| {
                                ToolError::new("tool.invalidArguments", "task is required for close")
                            })?;
                        require_execute(&call)?;
                        let client = connect(&self.instance)?;
                        require(&client, &call, &id)?;
                        rpc(&client, "process.v1.kill", json!({"id": id}))?;
                        serialize(TaskManageOutput {
                            tasks: None,
                            task: None,
                            closed_task: Some(id),
                            accepted: Some(true),
                        })
                    }
                }
            }
        }
    }
}

fn summarize(descriptor: &Value) -> Result<TaskSummary, ToolError> {
    let id = descriptor["id"]
        .as_str()
        .ok_or_else(|| error("process descriptor missing id"))?
        .to_string();
    let persistent = descriptor["persistent"].as_bool().unwrap_or(false);
    let interactive = descriptor["interactive"].as_bool().unwrap_or(false);
    let kind = if persistent || interactive {
        "terminal"
    } else {
        "task"
    }
    .to_string();
    let pty = descriptor["pty"]
        .as_bool()
        .unwrap_or_else(|| descriptor["tty"].as_bool().unwrap_or(false));
    let state = descriptor["state"]
        .as_str()
        .unwrap_or("unknown")
        .to_string();
    let name = descriptor["name"].as_str().map(str::to_string);
    let cwd = descriptor["cwd"].as_str().map(str::to_string);
    let command = descriptor["command"].as_str().map(str::to_string);
    let human_control = descriptor["humanControl"].as_bool().unwrap_or(false);
    let exit_code = descriptor["exit"]["exitCode"]
        .as_i64()
        .and_then(|code| i32::try_from(code).ok());
    let created_at_ms = descriptor["createdAtMs"]
        .as_u64()
        .map(u128::from)
        .unwrap_or(0);
    Ok(TaskSummary {
        id,
        kind,
        persistent,
        pty,
        state,
        name,
        cwd,
        command,
        human_control,
        exit_code,
        created_at_ms,
    })
}

pub(crate) fn register_tools(
    registry: &mut ToolRegistry,
    instance: &InstanceName,
) -> Result<(), ToolError> {
    for name in ["task_inspect", "task_manage"] {
        registry.register(Arc::new(TerminalTool {
            name: ToolName::parse(name).map_err(error)?,
            instance: instance.clone(),
        }))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::ManageParams;
    use crate::tool::registry::normalize_schema;

    #[test]
    fn task_manage_normalized_schema_preserves_command_enum() {
        let mut schema = serde_json::to_value(schemars::schema_for!(ManageParams)).unwrap();
        normalize_schema(&mut schema);

        assert_eq!(schema.get("type"), Some(&json!("object")));
        assert_eq!(schema.get("additionalProperties"), Some(&json!(false)));
        assert_eq!(schema.get("required"), Some(&json!(["command"])));

        let command_prop = schema
            .get("properties")
            .and_then(|props| props.get("command"))
            .expect("command property must exist");
        let resolved_command = match command_prop.get("$ref").and_then(serde_json::Value::as_str) {
            Some(reference) => {
                let def_name = reference.strip_prefix("#/$defs/").expect("local $ref");
                schema
                    .get("$defs")
                    .and_then(|defs| defs.get(def_name))
                    .expect("referenced $defs entry")
            }
            None => command_prop,
        };
        assert_eq!(
            resolved_command.get("enum"),
            Some(&json!(["list", "create", "close"]))
        );
    }
}
