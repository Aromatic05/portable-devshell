use std::sync::Arc;

use schemars::schema_for;

use crate::tools::tmux::group::tmux_capture_name;
use crate::tools::tmux::state::TmuxState;
use crate::tools::tmux::types::{TmuxCaptureParams, TmuxPaneOperationOutput};
use crate::tools::{ToolCall, ToolCapability, ToolCatalogEntry, ToolError, ToolHandler, ToolName};

pub struct TmuxCaptureTool {
    name: ToolName,
    state: Arc<TmuxState>,
}

impl TmuxCaptureTool {
    pub fn new(state: Arc<TmuxState>) -> Self {
        Self {
            name: tmux_capture_name(),
            state,
        }
    }
}

impl ToolHandler for TmuxCaptureTool {
    fn name(&self) -> &ToolName {
        &self.name
    }

    fn catalog_entry(&self) -> ToolCatalogEntry {
        ToolCatalogEntry {
            group: self.name.group().to_string(),
            name: self.name.as_str(),
            description: "Consume unread output from one managed tmux pane. Positive line values return the oldest unread lines, zero discards unread output, and negative values return only the requested tail.".to_string(),
            input_schema: serde_json::to_value(schema_for!(TmuxCaptureParams)).unwrap(),
            output_schema: serde_json::to_value(schema_for!(TmuxPaneOperationOutput)).unwrap(),
            required_capabilities: vec![ToolCapability::Read],
        }
    }

    fn call(&self, call: ToolCall) -> Result<serde_json::Value, ToolError> {
        let params = serde_json::from_value(call.params.clone())
            .map_err(|error| ToolError::new("tool.invalidArguments", error.to_string()))?;
        serde_json::to_value(self.state.capture(&call, params)?)
            .map_err(|error| ToolError::new("tool.internalError", error.to_string()))
    }
}
