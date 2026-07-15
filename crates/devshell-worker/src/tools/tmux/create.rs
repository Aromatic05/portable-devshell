use std::sync::Arc;

use schemars::schema_for;

use crate::tools::tmux::group::tmux_create_name;
use crate::tools::tmux::state::TmuxState;
use crate::tools::tmux::types::{TmuxCreateOutput, TmuxCreateParams};
use crate::tools::{ToolCall, ToolCapability, ToolCatalogEntry, ToolError, ToolHandler, ToolName};

pub struct TmuxCreateTool {
    name: ToolName,
    state: Arc<TmuxState>,
}

impl TmuxCreateTool {
    pub fn new(state: Arc<TmuxState>) -> Self {
        Self {
            name: tmux_create_name(),
            state,
        }
    }
}

impl ToolHandler for TmuxCreateTool {
    fn name(&self) -> &ToolName {
        &self.name
    }

    fn catalog_entry(&self) -> ToolCatalogEntry {
        ToolCatalogEntry {
            group: self.name.group().to_string(),
            name: self.name.as_str(),
            description: "Create an empty managed pane. Use tmux_run to start a task in it.".to_string(),
            input_schema: serde_json::to_value(schema_for!(TmuxCreateParams)).unwrap(),
            output_schema: serde_json::to_value(schema_for!(TmuxCreateOutput)).unwrap(),
            required_capabilities: vec![ToolCapability::Execute],
        }
    }

    fn call(&self, call: ToolCall) -> Result<serde_json::Value, ToolError> {
        let params = serde_json::from_value(call.params.clone())
            .map_err(|error| ToolError::new("tool.invalidArguments", error.to_string()))?;
        serde_json::to_value(self.state.create(&call, params)?)
            .map_err(|error| ToolError::new("tool.internalError", error.to_string()))
    }
}
