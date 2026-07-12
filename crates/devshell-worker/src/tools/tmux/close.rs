use std::sync::Arc;

use schemars::schema_for;

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
        ToolCatalogEntry {
            group: self.name.group().to_string(),
            name: self.name.as_str(),
            description: "Close one managed tmux pane. Without force the pane must be idle. The final managed pane cannot be closed.".to_string(),
            input_schema: serde_json::to_value(schema_for!(TmuxCloseParams)).unwrap(),
            output_schema: serde_json::to_value(schema_for!(TmuxCloseOutput)).unwrap(),
            required_capabilities: vec![ToolCapability::Execute],
        }
    }

    fn call(&self, call: ToolCall) -> Result<serde_json::Value, ToolError> {
        let params = serde_json::from_value(call.params.clone())
            .map_err(|error| ToolError::new("tool.invalidArguments", error.to_string()))?;
        serde_json::to_value(self.state.close(&call, params)?)
            .map_err(|error| ToolError::new("tool.internalError", error.to_string()))
    }
}
