use std::sync::Arc;

use crate::tools::tmux::group::tmux_read_name;
use crate::tools::tmux::state::TmuxState;
use crate::tools::tmux::types::{TmuxReadParams, TmuxTaskOperationOutput};
use crate::tools::{ToolCall, ToolCapability, ToolCatalogEntry, ToolError, ToolHandler, ToolName};

pub struct TmuxReadTool {
    name: ToolName,
    state: Arc<TmuxState>,
}

impl TmuxReadTool {
    pub fn new(state: Arc<TmuxState>) -> Self {
        Self {
            name: tmux_read_name(),
            state,
        }
    }
}

impl ToolHandler for TmuxReadTool {
    fn name(&self) -> &ToolName {
        &self.name
    }

    fn catalog_entry(&self) -> ToolCatalogEntry {
        crate::tools::contract::catalog_entry::<TmuxReadParams, TmuxTaskOperationOutput>(
            &self.name,
            "Consume unread terminal output associated with a managed task. Output is derived from terminal history and may include command echo, shell prompts, and terminal-rendered text; it is not raw process stdout. Positive line values return the oldest unread lines, zero discards unread output, and negative values return only the requested tail.".to_string(),
            [ToolCapability::Read],
        )
    }

    fn call(&self, call: ToolCall) -> Result<serde_json::Value, ToolError> {
        let params = serde_json::from_value(call.params.clone())
            .map_err(|error| ToolError::new("tool.invalidArguments", error.to_string()))?;
        serde_json::to_value(self.state.read(&call, params)?)
            .map_err(|error| ToolError::new("tool.internalError", error.to_string()))
    }
}
