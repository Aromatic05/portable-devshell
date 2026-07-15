use std::sync::Arc;

use schemars::schema_for;

use crate::tools::tmux::group::tmux_list_name;
use crate::tools::tmux::state::TmuxState;
use crate::tools::tmux::types::{TmuxListOutput, TmuxListParams};
use crate::tools::{ToolCall, ToolCapability, ToolCatalogEntry, ToolError, ToolHandler, ToolName};

pub struct TmuxListTool {
    name: ToolName,
    state: Arc<TmuxState>,
}

impl TmuxListTool {
    pub fn new(state: Arc<TmuxState>) -> Self {
        Self {
            name: tmux_list_name(),
            state,
        }
    }
}

impl ToolHandler for TmuxListTool {
    fn name(&self) -> &ToolName {
        &self.name
    }

    fn catalog_entry(&self) -> ToolCatalogEntry {
        ToolCatalogEntry {
            group: self.name.group().to_string(),
            name: self.name.as_str(),
            description: "List managed panes, running tasks, and pane capacity.".to_string(),
            input_schema: serde_json::to_value(schema_for!(TmuxListParams)).unwrap(),
            output_schema: serde_json::to_value(schema_for!(TmuxListOutput)).unwrap(),
            required_capabilities: vec![ToolCapability::Read],
        }
    }

    fn call(&self, call: ToolCall) -> Result<serde_json::Value, ToolError> {
        let _: TmuxListParams = serde_json::from_value(call.params.clone())
            .map_err(|error| ToolError::new("tool.invalidArguments", error.to_string()))?;
        serde_json::to_value(self.state.list(&call)?)
            .map_err(|error| ToolError::new("tool.internalError", error.to_string()))
    }
}
