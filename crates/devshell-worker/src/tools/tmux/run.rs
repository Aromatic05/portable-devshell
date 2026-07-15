use std::sync::Arc;

use crate::tools::tmux::group::tmux_run_name;
use crate::tools::tmux::state::TmuxState;
use crate::tools::tmux::types::{TmuxRunParams, TmuxTaskOperationOutput};
use crate::tools::{ToolCall, ToolCapability, ToolCatalogEntry, ToolError, ToolHandler, ToolName};

pub struct TmuxRunTool {
    name: ToolName,
    state: Arc<TmuxState>,
}

impl TmuxRunTool {
    pub fn new(state: Arc<TmuxState>) -> Self {
        Self {
            name: tmux_run_name(),
            state,
        }
    }
}

impl ToolHandler for TmuxRunTool {
    fn name(&self) -> &ToolName {
        &self.name
    }

    fn catalog_entry(&self) -> ToolCatalogEntry {
        crate::tools::contract::catalog_entry::<TmuxRunParams, TmuxTaskOperationOutput>(
            &self.name,
            "Run a long-running or interactive shell task from one shell line. wait defaults to block; timeMs limits only this call's wait and never stops the task. Use wait=nonblock to return after start, then use tmux_read, tmux_input, or tmux_inspect.".to_string(),
            [ToolCapability::Execute],
        )
    }

    fn call(&self, call: ToolCall) -> Result<serde_json::Value, ToolError> {
        let params = serde_json::from_value(call.params.clone())
            .map_err(|error| ToolError::new("tool.invalidArguments", error.to_string()))?;
        serde_json::to_value(self.state.run(&call, params)?)
            .map_err(|error| ToolError::new("tool.internalError", error.to_string()))
    }
}
