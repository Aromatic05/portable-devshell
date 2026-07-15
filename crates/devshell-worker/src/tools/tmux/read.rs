use std::sync::Arc;

use schemars::schema_for;

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
        ToolCatalogEntry {
            group: self.name.group().to_string(),
            name: self.name.as_str(),
            description: "Consume unread line-oriented output from a task. Positive line values return the oldest unread lines, zero discards unread output, and negative values return only the requested tail.".to_string(),
            input_schema: serde_json::to_value(schema_for!(TmuxReadParams)).unwrap(),
            output_schema: serde_json::to_value(schema_for!(TmuxTaskOperationOutput)).unwrap(),
            required_capabilities: vec![ToolCapability::Read],
        }
    }

    fn call(&self, call: ToolCall) -> Result<serde_json::Value, ToolError> {
        let params = serde_json::from_value(call.params.clone())
            .map_err(|error| ToolError::new("tool.invalidArguments", error.to_string()))?;
        serde_json::to_value(self.state.read(&call, params)?)
            .map_err(|error| ToolError::new("tool.internalError", error.to_string()))
    }
}
