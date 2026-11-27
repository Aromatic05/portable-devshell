use super::model::TaskCursor;
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

const DEFAULT_TERMINAL_COLS: u16 = 120;
const DEFAULT_TERMINAL_ROWS: u16 = 36;
const MAX_LISTED_COMPLETED_TASKS: usize = 10;

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
    /// Optional initial terminal columns for create (default 120).
    #[serde(default)]
    #[schemars(range(min = 1, max = 1000))]
    cols: Option<u16>,
    /// Optional initial terminal rows for create (default 36).
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
    cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    task_id: Option<String>,
    /// Whether the termination request was accepted, not whether the task ended.
    #[serde(skip_serializing_if = "Option::is_none")]
    kill_requested: Option<bool>,
    /// Observed task state after a brief wait, which may still be running.
    #[serde(skip_serializing_if = "Option::is_none")]
    state: Option<String>,
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
                "PTY-only: inspect the current visible terminal screen of a PTY task or persistent terminal without advancing cursors. For non-PTY command output, use task_input without input instead.",
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
                            "task": "PTY task or persistent terminal ID to inspect (fails on non-PTY pipe tasks; use task_input without input for pipe output)."
                        },
                        "title": "Inspect terminal screen"
                    }}
                }),
            ),
            _ => catalog_entry_with_meta::<ManageParams, TaskManageOutput>(
                &self.name,
                "Manage tasks and persistent interactive terminals in the current execution scope. Allowed fields per command: list -> {}; create -> {name?, cwd?, shell?, cols?, rows?}; close -> {task}. Use create only when you need a persistent login shell or human terminal attach (it auto-respawns on shell exit and does not inject the model devshell CLI; prefer bash_run for one-shot commands or background services). A successful close request does not guarantee that the task has ended.",
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
                            "command": "Operation: \"list\" (no extra fields), \"create\" (optional name/cwd/shell/cols/rows), or \"close\" (requires task). Close returns taskId, killRequested, and observed state. If state is still running, poll with task_manage(command=\"list\") until it leaves running.",
                            "task": "Task or terminal ID to close (required for close; forbidden for list/create).",
                            "name": "Optional name for create only (1-64 ASCII alphanumeric or ._-; must start with alphanumeric).",
                            "cwd": "Working directory for create only; workspace-relative or absolute (required absolute in stateless mode; forbidden for list/close).",
                            "shell": "Optional shell executable for create only; defaults to user login shell (note: persistent terminals do not inject the model devshell CLI).",
                            "cols": "Optional terminal width in columns for create only (default 120, range 1-1000).",
                            "rows": "Optional terminal height in rows for create only (default 36, range 1-1000)."
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
                let (descriptor, _lease) = require(&client, &call, &params.task)?;
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
                                cursor: None,
                                task_id: None,
                                kill_requested: None,
                                state: None,
                            });
                        };
                        let mut active = Vec::new();
                        let mut completed = Vec::new();
                        for descriptor in client
                            .list()
                            .map_err(error)?
                            .as_array()
                            .ok_or_else(|| error("invalid resource list"))?
                        {
                            if scoped(&call, descriptor)? {
                                let summary = summarize(descriptor)?;
                                if summary.state == "running" || summary.persistent {
                                    active.push(summary);
                                } else {
                                    completed.push(summary);
                                }
                            }
                        }
                        active.sort_by(|left, right| {
                            (right.state == "running")
                                .cmp(&(left.state == "running"))
                                .then_with(|| right.persistent.cmp(&left.persistent))
                                .then_with(|| right.created_at_ms.cmp(&left.created_at_ms))
                        });
                        completed.sort_by(|left, right| right.created_at_ms.cmp(&left.created_at_ms));
                        completed.truncate(MAX_LISTED_COMPLETED_TASKS);
                        let mut tasks = active;
                        tasks.extend(completed);
                        serialize(TaskManageOutput {
                            tasks: Some(tasks),
                            task: None,
                            cursor: None,
                            task_id: None,
                            kill_requested: None,
                            state: None,
                        })
                    }
                    TaskManageCommand::Create => {
                        if params.task.is_some() {
                            return Err(ToolError::new(
                                "tool.invalidArguments",
                                "create does not accept task",
                            ));
                        }
                        if let Some(name) = params.name.as_deref() {
                            validate_terminal_name(name)?;
                        }
                        if let Some(cols) = params.cols
                            && (cols == 0 || cols > 1000)
                        {
                            return Err(ToolError::new(
                                "tool.invalidArguments",
                                "cols must be between 1 and 1000",
                            ));
                        }
                        if let Some(rows) = params.rows
                            && (rows == 0 || rows > 1000)
                        {
                            return Err(ToolError::new(
                                "tool.invalidArguments",
                                "rows must be between 1 and 1000",
                            ));
                        }
                        if let Some(cwd) = params.cwd.as_deref()
                            && cwd.trim().is_empty()
                        {
                            return Err(ToolError::new(
                                "tool.invalidArguments",
                                "cwd cannot be empty",
                            ));
                        }
                        require_execute(&call)?;
                        if call.stateless {
                            match params.cwd.as_deref() {
                                Some(cwd) if std::path::Path::new(cwd).is_absolute() => {}
                                _ => {
                                    return Err(ToolError::new(
                                        "tool.invalidArguments",
                                        "absolute cwd is required in stateless mode",
                                    ));
                                }
                            }
                        }
                        let client = ProcessHostClient::ensure(&self.instance).map_err(error)?;
                        let id = format!("process-{}", uuid::Uuid::new_v4());
                        let (created, _lease) = spawn(
                            &client,
                            &call,
                            &id,
                            json!({
                                "id": id,
                                "command": params.shell.unwrap_or_default(),
                                "interactive": true,
                                "persistent": true,
                                "tty": true,
                                "name": params.name,
                                "cwd": params.cwd.unwrap_or_else(|| "./".into()),
                                "workspace": (!call.stateless).then_some(&call.workspace),
                                "cols": params.cols.unwrap_or(DEFAULT_TERMINAL_COLS),
                                "rows": params.rows.unwrap_or(DEFAULT_TERMINAL_ROWS),
                            }),
                        )?;
                        let result = summarize(&created).and_then(|task| {
                            if task.id != id {
                                return Err(error("process descriptor task id does not match spawn request"));
                            }
                            let initial_cursor = TaskCursor {
                                generation: created["shellGeneration"].as_u64(),
                                ..TaskCursor::default()
                            }
                            .encode(&task.id);
                            serialize(TaskManageOutput {
                                tasks: None,
                                task: Some(task),
                                cursor: Some(initial_cursor),
                                task_id: None,
                                kill_requested: None,
                                state: None,
                            })
                        });
                        check_spawn_cancelled(&client, &call, &id, &created)
                            .and(result)
                            .map_err(|failure| confirmed_spawn_error(failure, &id))
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
                        let (descriptor, _lease) = require(&client, &call, &id)?;
                        terminate(&client, &id, descriptor, Some(&call.cancellation))
                    }
                }
            }
        }
    }
}

fn validate_terminal_name(name: &str) -> Result<(), ToolError> {
    let bytes = name.as_bytes();
    if bytes.is_empty()
        || bytes.len() > 64
        || !bytes[0].is_ascii_alphanumeric()
        || !bytes[1..]
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    {
        return Err(ToolError::new(
            "tool.invalidArguments",
            "name must be 1-64 ASCII alphanumeric or ._- characters starting with alphanumeric",
        ));
    }
    Ok(())
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
