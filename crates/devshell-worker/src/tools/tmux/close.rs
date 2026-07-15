use std::sync::Arc;

use crate::tools::tmux::group::tmux_close_name;
use crate::tools::tmux::state::TmuxState;
use crate::tools::tmux::types::{TmuxCloseOutput, TmuxCloseParams};
use crate::tools::{ToolCall, ToolCapability, ToolCatalogEntry, ToolError, ToolHandler, ToolName};

pub struct TmuxCloseTool {
    name: ToolName,
    state: Arc<TmuxState>,
}

impl TmuxCloseTool {
    pub fn new(state: Arc<TmuxState>) -> Self {
        Self {
            name: tmux_close_name(),
            state,
        }
    }
}

impl ToolHandler for TmuxCloseTool {
    fn name(&self) -> &ToolName {
        &self.name
    }

    fn catalog_entry(&self) -> ToolCatalogEntry {
        crate::tools::contract::catalog_entry::<TmuxCloseParams, TmuxCloseOutput>(
            &self.name,
            "Close a managed pane. A running pane requires force, and the final pane cannot be closed.".to_string(),
            [ToolCapability::Execute],
        )
    }

    fn call(&self, call: ToolCall) -> Result<serde_json::Value, ToolError> {
        let params = serde_json::from_value(call.params.clone())
            .map_err(|error| ToolError::new("tool.invalidArguments", error.to_string()))?;
        serde_json::to_value(self.state.close(&call, params)?)
            .map_err(|error| ToolError::new("tool.internalError", error.to_string()))
    }
}
