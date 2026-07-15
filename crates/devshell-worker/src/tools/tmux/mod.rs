pub mod backend;
pub mod codec;
pub mod output;
pub mod replay;
pub mod shell;
pub mod state;
pub mod task;
pub mod types;

use std::marker::PhantomData;
use std::sync::Arc;

use schemars::JsonSchema;
use serde::{Serialize, de::DeserializeOwned};

use crate::daemon::process::WorkerRuntimeContext;
use crate::socket::SocketPaths;
use crate::storage::InstancePaths;
use crate::tools::tmux::backend::TmuxBackend;
use crate::tools::tmux::state::TmuxState;
use crate::tools::tmux::types::{
    TmuxCloseOutput, TmuxCloseParams, TmuxCreateOutput, TmuxCreateParams, TmuxInputParams,
    TmuxInspectParams, TmuxListOutput, TmuxListParams, TmuxPaneOperationOutput, TmuxReadParams,
    TmuxRunParams, TmuxTaskOperationOutput, TmuxWarning,
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
    state: Arc<TmuxState>,
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
        crate::tools::contract::serialize((self.operation)(&self.state, &call, params)?)
    }
}

fn tool<I, O>(
    name: ToolName,
    description: &'static str,
    capability: ToolCapability,
    state: Arc<TmuxState>,
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
        state,
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
    let state = Arc::new(TmuxState::new(TmuxBackend::new(
        instance_paths,
        socket_paths,
        runtime,
    )?));
    registry.register(tool::<TmuxRunParams, TmuxTaskOperationOutput>(
        ToolName::parse("tmux_run").unwrap(),
        "Run a long-running or interactive shell task from one shell line. wait defaults to block; timeMs limits only this call's wait and never stops the task. Use wait=nonblock to return after start, then use tmux_read, tmux_input, or tmux_inspect.",
        ToolCapability::Execute,
        Arc::clone(&state),
        TmuxState::run,
    ))?;
    registry.register(tool::<TmuxInputParams, TmuxTaskOperationOutput>(
        ToolName::parse("tmux_input").unwrap(),
        "Send terminal input to a running task. Caret notation supports ^C, ^D, ^I, and ^M. Ctrl-B is forbidden.",
        ToolCapability::Execute,
        Arc::clone(&state),
        TmuxState::input,
    ))?;
    registry.register(tool::<TmuxReadParams, TmuxTaskOperationOutput>(
        ToolName::parse("tmux_read").unwrap(),
        "Consume unread terminal output associated with a managed task. Output is derived from terminal history and may include command echo, shell prompts, and terminal-rendered text; it is not raw process stdout. Positive line values return the oldest unread lines, zero discards unread output, and negative values return only the requested tail.",
        ToolCapability::Read,
        Arc::clone(&state),
        TmuxState::read,
    ))?;
    registry.register(tool::<TmuxInspectParams, TmuxPaneOperationOutput>(
        ToolName::parse("tmux_inspect").unwrap(),
        "Inspect terminal history without consuming unread output. Use this for curses applications or terminal screen state.",
        ToolCapability::Read,
        Arc::clone(&state),
        TmuxState::inspect,
    ))?;
    registry.register(tool::<TmuxListParams, TmuxListOutput>(
        ToolName::parse("tmux_list").unwrap(),
        "List managed panes, running tasks, and pane capacity.",
        ToolCapability::Read,
        Arc::clone(&state),
        |state, call, _| state.list(call),
    ))?;
    registry.register(tool::<TmuxCreateParams, TmuxCreateOutput>(
        ToolName::parse("tmux_create").unwrap(),
        "Create an empty managed pane. Use tmux_run to start a task in it.",
        ToolCapability::Execute,
        Arc::clone(&state),
        TmuxState::create,
    ))?;
    registry.register(tool::<TmuxCloseParams, TmuxCloseOutput>(
        ToolName::parse("tmux_close").unwrap(),
        "Close a managed pane. A running pane requires force, and the final pane cannot be closed.",
        ToolCapability::Execute,
        state,
        TmuxState::close,
    ))?;
    Ok(())
}
