use std::sync::Arc;

use schemars::schema_for;

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
        ToolCatalogEntry {
            group: self.name.group().to_string(),
            name: self.name.as_str(),
            description: "Run one shell command as a managed tmux task. pane is optional: the worker atomically selects an idle pane, or creates an auto-N pane when capacity permits. wait=block waits for exit; wait=nonblock returns after task start. The returned task id is required by tmux_input and tmux_read.".to_string(),
            input_schema: serde_json::to_value(schema_for!(TmuxRunParams)).unwrap(),
            output_schema: serde_json::to_value(schema_for!(TmuxTaskOperationOutput)).unwrap(),
            required_capabilities: vec![ToolCapability::Execute],
        }
    }

    fn call(&self, call: ToolCall) -> Result<serde_json::Value, ToolError> {
        let params = serde_json::from_value(call.params.clone())
            .map_err(|error| ToolError::new("tool.invalidArguments", error.to_string()))?;
        serde_json::to_value(self.state.run(&call, params)?)
            .map_err(|error| ToolError::new("tool.internalError", error.to_string()))
    }
}
