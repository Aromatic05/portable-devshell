pub mod backend;
pub mod model;
pub mod state;
pub mod transcript;
#[cfg(all(test, unix))]
mod tests;

use std::collections::HashMap;
use std::marker::PhantomData;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use schemars::JsonSchema;
use serde::{Serialize, de::DeserializeOwned};

use crate::instance::runtime::WorkerRuntimeContext;
use crate::instance::sandbox::path::FilesystemCapability;
use crate::instance::storage::InstancePaths;
use crate::tool::ToolCommandEnvironmentProvider;
use crate::tool::file::FileToolState;
use crate::tool::tmux::backend::TmuxBackend;
use crate::tool::tmux::model::{
    TmuxInputOutput, TmuxInputParams, TmuxInspectParams, TmuxListOutput, TmuxListScope,
    TmuxManageCommand, TmuxManageOutput, TmuxManageParams,
    TmuxPaneOperationOutput, TmuxReadOutput, TmuxReadParams, TmuxRunOutput, TmuxRunParams,
    TmuxWarning,
};
use crate::tool::tmux::state::TmuxState;
use crate::tool::{
    ToolCall, ToolCapability, ToolCatalogEntry, ToolError, ToolHandler, ToolName, ToolRegistry,
};
use crate::transport::endpoint::channel::EndpointPaths;

pub use backend::retire::retire_instance_runtime;

#[cfg(unix)]
const RUN_DESCRIPTION: &str = "Start long-running or PTY/interactive work as a managed task. Prefer wait=block for work that must complete on the current critical path; use wait=nonblock when continuing other work or planning later interaction through tmux_read/tmux_input.";
#[cfg(windows)]
const RUN_DESCRIPTION: &str = "Start long-running or PTY/interactive work as a managed task. Prefer wait=block for work that must complete on the current critical path; use wait=nonblock when continuing other work or planning later interaction through tmux_read/tmux_input.";

fn warning(pane: Option<&str>, code: &str, message: &str) -> TmuxWarning {
    TmuxWarning {
        pane: pane.map(ToOwned::to_owned),
        code: code.to_string(),
        message: message.to_string(),
    }
}

struct TmuxTool<I, O> {
    name: ToolName,
    description: &'static str,
    capability: ToolCapability,
    meta: serde_json::Value,
    states: Arc<TmuxStateRegistry>,
    operation: fn(&TmuxStateRegistry, &ToolCall, I) -> Result<O, ToolError>,
    marker: PhantomData<fn(I) -> O>,
}

impl<I, O> ToolHandler for TmuxTool<I, O>
where
    I: DeserializeOwned + JsonSchema + 'static,
    O: Serialize + JsonSchema + 'static,
{
    fn name(&self) -> &ToolName {
        &self.name
    }

    fn catalog_entry(&self) -> ToolCatalogEntry {
        crate::tool::contract::catalog_entry_with_meta::<I, O>(
            &self.name,
            self.description,
            [self.capability],
            self.meta.clone(),
        )
    }

    fn call(&self, call: ToolCall) -> Result<serde_json::Value, ToolError> {
        let params = call.parse_params()?;
        let result =
            crate::tool::contract::serialize((self.operation)(&self.states, &call, params)?)?;
        #[cfg(unix)]
        {
            let tool_name = self.name.as_str();
            if matches!(tool_name.as_str(), "tmux_run" | "tmux_read") {
                self.states.state_for(&call.workspace)?.observe_read_output(&call, &tool_name, &result);
            }
        }
        Ok(result)
    }
}

struct TmuxStateRegistry {
    instance_paths: InstancePaths,
    model_devshell: Arc<dyn ToolCommandEnvironmentProvider>,
    runtime: WorkerRuntimeContext,
    socket_paths: EndpointPaths,
    files: Arc<FileToolState>,
    states: Mutex<HashMap<PathBuf, Arc<TmuxState>>>,
}

impl TmuxStateRegistry {
    fn new(
        instance_paths: &InstancePaths,
        socket_paths: &EndpointPaths,
        runtime: &WorkerRuntimeContext,
        model_devshell: Arc<dyn ToolCommandEnvironmentProvider>,
        files: Arc<FileToolState>,
    ) -> Self {
        Self {
            instance_paths: instance_paths.clone(),
            model_devshell,
            files,
            runtime: runtime.clone(),
            socket_paths: socket_paths.clone(),
            states: Mutex::new(HashMap::new()),
        }
    }

    fn state_for(&self, workspace: &Path) -> Result<Arc<TmuxState>, ToolError> {
        let mut states = self.states.lock().map_err(|_| {
            ToolError::new(
                "tmux.internalError",
                "tmux workspace registry lock poisoned",
            )
        })?;
        if let Some(state) = states.get(workspace) {
            return Ok(Arc::clone(state));
        }
        let state = Arc::new(TmuxState::new(
            TmuxBackend::new(
                &self.instance_paths,
                &self.socket_paths,
                &self.runtime,
                workspace,
            )?,
            Arc::clone(&self.model_devshell),
            Arc::clone(&self.files),
        )?);
        TmuxState::start_reaper(&state);
        states.insert(workspace.to_path_buf(), Arc::clone(&state));
        Ok(state)
    }

    fn manage(&self, call: &ToolCall, params: TmuxManageParams) -> Result<TmuxManageOutput, ToolError> {
        call.check_cancelled()?;
        call.policy.check_capability(FilesystemCapability::ProcessExecute).map_err(ToolError::from)?;
        if params.scope != Some(TmuxListScope::Instance) {
            return self.state_for(&call.workspace)?.manage(call, params);
        }
        if params.command != TmuxManageCommand::List
            || params.name.is_some()
            || params.cwd.is_some()
            || params.task.is_some()
            || params.pane.is_some()
            || params.force.is_some()
        {
            return Err(ToolError::new("tool.invalidArguments", "scope=instance accepts only command=list and scope"));
        }
        call.policy.check_capability(FilesystemCapability::WorkspaceRead).map_err(ToolError::from)?;
        let mut result = TmuxListOutput { panes: Vec::new(), warnings: None };
        let mut warnings = Vec::new();
        for workspace in TmuxBackend::discover_workspaces(&self.instance_paths)? {
            call.check_cancelled()?;
            let listed = self.state_for(&workspace)?.list(call, false, true)?;
            result.panes.extend(listed.panes);
            warnings.extend(listed.warnings.unwrap_or_default());
        }
        if !warnings.is_empty() {
            result.warnings = Some(warnings);
        }
        Ok(result.into())
    }
}

fn tool<I, O>(
    name: ToolName,
    description: &'static str,
    capability: ToolCapability,
    meta: serde_json::Value,
    states: Arc<TmuxStateRegistry>,
    operation: fn(&TmuxStateRegistry, &ToolCall, I) -> Result<O, ToolError>,
) -> Arc<dyn ToolHandler>
where
    I: DeserializeOwned + JsonSchema + 'static,
    O: Serialize + JsonSchema + 'static,
{
    Arc::new(TmuxTool {
        name,
        description,
        capability,
        meta,
        states,
        operation,
        marker: PhantomData,
    })
}

pub fn register_tools(
    registry: &mut ToolRegistry,
    instance_paths: &InstancePaths,
    socket_paths: &EndpointPaths,
    runtime: &WorkerRuntimeContext,
    model_devshell: Arc<dyn ToolCommandEnvironmentProvider>,
    files: Arc<FileToolState>,
) -> Result<(), ToolError> {
    if !TmuxBackend::available() {
        return Ok(());
    }
    let states = Arc::new(TmuxStateRegistry::new(
        instance_paths,
        socket_paths,
        runtime,
        model_devshell,
        files,
    ));
    registry.register(tool::<TmuxRunParams, TmuxRunOutput>(
        ToolName::parse("tmux_run").unwrap(),
        RUN_DESCRIPTION,
        ToolCapability::Execute,
        serde_json::json!({
            "devshell": { "mcp": {
                "annotations": {
                    "destructiveHint": true,
                    "idempotentHint": false,
                    "openWorldHint": true,
                    "readOnlyHint": false
                },
                "hiddenInputProperties": ["consumeOutput"],
                "inputHints": {
                    "cwd": "Initial task directory; bare relative and ./ paths are workspace-relative, absolute paths are also accepted.",
                    "line": "Output lines returned with the task.",
                    "timeout": "Block-wait deadline; the task keeps running after it expires.",
                    "wait": "block waits for progress; nonblock returns after start."
                },
                "title": "Run tmux task"
            }}
        }),
        Arc::clone(&states),
        |states, call, params| states.state_for(&call.workspace)?.run(call, params),
    ))?;
    registry.register(tool::<TmuxInputParams, TmuxInputOutput>(
        ToolName::parse("tmux_input").unwrap(),
        "Send terminal input to a managed task or persistent pane. Use task ids for managed executions and pane ids/names for persistent interactions; observe follow-up output with tmux_read or tmux_inspect as appropriate.",
        ToolCapability::Execute,
        serde_json::json!({
            "devshell": { "mcp": {
                "annotations": {
                    "destructiveHint": true,
                    "idempotentHint": false,
                    "openWorldHint": true,
                    "readOnlyHint": false
                },
                "hiddenInputProperties": ["line", "timeMs"],
                "title": "Send tmux input"
            }}
        }),
        Arc::clone(&states),
        |states, call, params| states.state_for(&call.workspace)?.input(call, params),
    ))?;
    registry.register(tool::<TmuxReadParams, TmuxReadOutput>(
        ToolName::parse("tmux_read").unwrap(),
        "Wait for or consume a managed task's durable transcript. Positive line values consume the oldest unread lines. Negative values also consume all unread transcript data, discard the earlier portion, and return only the requested tail after waiting. Use tmux_inspect instead when non-consuming pane screen state is required.",
        ToolCapability::Read,
        serde_json::json!({
            "devshell": { "mcp": {
                "annotations": {
                    "destructiveHint": false,
                    "idempotentHint": false,
                    "openWorldHint": false,
                    "readOnlyHint": false
                },
                "hiddenInputProperties": ["consumeOutput"],
                "inputHints": {
                    "line": "Positive consumes oldest unread lines; negative also consumes all unread data, discards the earlier part, and returns the requested tail after waiting.",
                    "timeMs": "Maximum wait, in milliseconds."
                },
                "title": "Read tmux task"
            }}
        }),
        Arc::clone(&states),
        |states, call, params| states.state_for(&call.workspace)?.read(call, params),
    ))?;
    registry.register(tool::<TmuxInspectParams, TmuxPaneOperationOutput>(
        ToolName::parse("tmux_inspect").unwrap(),
        "Inspect pane terminal screen/history without consuming a managed task transcript. Use it for persistent terminals and current TUI/curses screen state; use tmux_read for durable managed-task transcript consumption.",
        ToolCapability::Read,
        serde_json::json!({
            "devshell": { "mcp": {
                "annotations": {
                    "destructiveHint": false,
                    "idempotentHint": true,
                    "openWorldHint": false,
                    "readOnlyHint": true
                },
                "inputHints": {
                    "end": "History end offset; defaults to 0.",
                    "panes": "Set to all to inspect every pane.",
                    "start": "History start offset; defaults to -80."
                },
                "title": "Inspect tmux pane"
            }}
        }),
        Arc::clone(&states),
        |states, call, params| states.state_for(&call.workspace)?.inspect(call, params),
    ))?;
    registry.register(tool::<TmuxManageParams, TmuxManageOutput>(
        ToolName::parse("tmux_manage").unwrap(),
        "Manage tmux resources with command=list, create, or close. list discovers panes and active tasks; scope=instance lists existing panes across all registered backend workspaces and returns each pane's owning workspace. create opens a persistent interactive pane, and close terminates a task or closes a persistent pane; force explicitly permits busy-resource termination.",
        ToolCapability::Execute,
        serde_json::json!({
            "devshell": { "mcp": {
                "annotations": {
                    "destructiveHint": true,
                    "idempotentHint": false,
                    "openWorldHint": false,
                    "readOnlyHint": false
                },
                "inputHints": {
                    "cwd": "Initial pane directory; bare relative and ./ paths are workspace-relative, absolute paths are also accepted.",
                    "force": "Allow closing a running or busy resource."
                },
                "title": "Manage tmux resources"
            }}
        }),
        states,
        TmuxStateRegistry::manage,
    ))?;
    Ok(())
}
