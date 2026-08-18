pub mod backend;
pub mod codec;
pub mod output;
pub mod replay;
pub mod shell;
pub mod state;
pub mod task;
pub mod types;

use std::collections::HashMap;
use std::marker::PhantomData;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use schemars::JsonSchema;
use serde::{Serialize, de::DeserializeOwned};

use crate::daemon::process::WorkerRuntimeContext;
use crate::socket::SocketPaths;
use crate::storage::InstancePaths;
use crate::tools::tmux::backend::TmuxBackend;
use crate::tools::tmux::state::TmuxState;
use crate::tools::tmux::types::{
    TmuxCloseOutput, TmuxCloseParams, TmuxCreateOutput, TmuxCreateParams, TmuxInputOutput,
    TmuxInputParams, TmuxInspectParams, TmuxListOutput, TmuxListParams, TmuxPaneOperationOutput,
    TmuxReadParams, TmuxRunParams, TmuxTaskOperationOutput, TmuxWarning,
};
use crate::tools::{
    ToolCall, ToolCapability, ToolCatalogEntry, ToolError, ToolHandler, ToolName, ToolRegistry,
};

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
    states: Arc<TmuxStateRegistry>,
    operation: fn(&TmuxState, &ToolCall, I) -> Result<O, ToolError>,
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
        crate::tools::contract::catalog_entry::<I, O>(
            &self.name,
            self.description,
            [self.capability],
        )
    }

    fn call(&self, call: ToolCall) -> Result<serde_json::Value, ToolError> {
        let params = call.parse_params()?;
        let state = self.states.state_for(&call.workspace)?;
        crate::tools::contract::serialize((self.operation)(state.as_ref(), &call, params)?)
    }
}

struct TmuxStateRegistry {
    instance_paths: InstancePaths,
    runtime: WorkerRuntimeContext,
    socket_paths: SocketPaths,
    states: Mutex<HashMap<PathBuf, Arc<TmuxState>>>,
}

impl TmuxStateRegistry {
    fn new(
        instance_paths: &InstancePaths,
        socket_paths: &SocketPaths,
        runtime: &WorkerRuntimeContext,
    ) -> Self {
        Self {
            instance_paths: instance_paths.clone(),
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
        let state = Arc::new(TmuxState::new(TmuxBackend::new(
            &self.instance_paths,
            &self.socket_paths,
            &self.runtime,
            workspace,
        )?)?);
        TmuxState::start_reaper(&state);
        states.insert(workspace.to_path_buf(), Arc::clone(&state));
        Ok(state)
    }
}

fn tool<I, O>(
    name: ToolName,
    description: &'static str,
    capability: ToolCapability,
    states: Arc<TmuxStateRegistry>,
    operation: fn(&TmuxState, &ToolCall, I) -> Result<O, ToolError>,
) -> Arc<dyn ToolHandler>
where
    I: DeserializeOwned + JsonSchema + 'static,
    O: Serialize + JsonSchema + 'static,
{
    Arc::new(TmuxTool {
        name,
        description,
        capability,
        states,
        operation,
        marker: PhantomData,
    })
}

pub fn register_tools(
    registry: &mut ToolRegistry,
    instance_paths: &InstancePaths,
    socket_paths: &SocketPaths,
    runtime: &WorkerRuntimeContext,
) -> Result<(), ToolError> {
    if !TmuxBackend::available() {
        return Ok(());
    }
    let states = Arc::new(TmuxStateRegistry::new(
        instance_paths,
        socket_paths,
        runtime,
    ));
    registry.register(tool::<TmuxRunParams, TmuxTaskOperationOutput>(
        ToolName::parse("tmux_run").unwrap(),
        "Run a long-running shell program in a fresh managed task pane using clean Bash without user rc files. command may contain multiple lines. cwd defaults to the workspace. The pane exists only while the task runs; task transcript remains readable after exit. wait defaults to block and timeMs limits only this call's wait, never the task.",
        ToolCapability::Execute,
        Arc::clone(&states),
        TmuxState::run,
    ))?;
    registry.register(tool::<TmuxInputParams, TmuxInputOutput>(
        ToolName::parse("tmux_input").unwrap(),
        "Send raw terminal input to exactly one target: a running managed task by task id, or a persistent interactive pane by pane id/name. Managed task panes cannot be controlled through pane targeting. Caret notation supports control keys such as ^B, ^C, ^D, ^I, and ^M. line and nonzero timeMs apply only to task targets.",
        ToolCapability::Execute,
        Arc::clone(&states),
        TmuxState::input,
    ))?;
    registry.register(tool::<TmuxReadParams, TmuxTaskOperationOutput>(
        ToolName::parse("tmux_read").unwrap(),
        "Consume a managed task's durable terminal transcript. Positive line values return the oldest unread lines, zero discards unread transcript data, and negative values return only the requested tail. Use tmux_inspect for current terminal screen state while the task is running.",
        ToolCapability::Read,
        Arc::clone(&states),
        TmuxState::read,
    ))?;
    registry.register(tool::<TmuxInspectParams, TmuxPaneOperationOutput>(
        ToolName::parse("tmux_inspect").unwrap(),
        "Inspect terminal history without consuming unread output. Use this for curses applications or terminal screen state.",
        ToolCapability::Read,
        Arc::clone(&states),
        TmuxState::inspect,
    ))?;
    registry.register(tool::<TmuxListParams, TmuxListOutput>(
        ToolName::parse("tmux_list").unwrap(),
        "List managed panes, running tasks, and pane capacity.",
        ToolCapability::Read,
        Arc::clone(&states),
        |state, call, _| state.list(call),
    ))?;
    registry.register(tool::<TmuxCreateParams, TmuxCreateOutput>(
        ToolName::parse("tmux_create").unwrap(),
        "Create a persistent interactive pane using the user's configured shell and shell rc files. The pane remains until tmux_close.",
        ToolCapability::Execute,
        Arc::clone(&states),
        TmuxState::create,
    ))?;
    registry.register(tool::<TmuxCloseParams, TmuxCloseOutput>(
        ToolName::parse("tmux_close").unwrap(),
        "Close exactly one tmux-owned resource: terminate a running managed task by task id, or close a persistent interactive pane by pane id/name. Active resources require force=true. The main interactive pane cannot be closed.",
        ToolCapability::Execute,
        states,
        TmuxState::close,
    ))?;
    Ok(())
}
