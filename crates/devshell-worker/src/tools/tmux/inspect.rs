use std::sync::Arc;

use schemars::schema_for;

use crate::tools::tmux::group::tmux_inspect_name;
use crate::tools::tmux::state::TmuxState;
use crate::tools::tmux::types::{TmuxInspectParams, TmuxPaneOperationOutput};
use crate::tools::{ToolAccess, ToolCall, ToolCatalogEntry, ToolError, ToolHandler, ToolName};

pub struct TmuxInspectTool {
    name: ToolName,
    state: Arc<TmuxState>,
}

impl TmuxInspectTool {
    pub fn new(state: Arc<TmuxState>) -> Self {
        Self {
            name: tmux_inspect_name(),
            state,
        }
    }
}

impl ToolHandler for TmuxInspectTool {
    fn name(&self) -> &ToolName {
        &self.name
    }

    fn catalog_entry(&self) -> ToolCatalogEntry {
        ToolCatalogEntry {
            group: self.name.group().to_string(),
            name: self.name.as_str(),
            description: "Inspect terminal history without consuming unread output. Select one pane with pane or inspect every managed pane with panes=all.".to_string(),
            input_schema: serde_json::to_value(schema_for!(TmuxInspectParams)).unwrap(),
            output_schema: serde_json::to_value(schema_for!(TmuxPaneOperationOutput)).unwrap(),
            access: ToolAccess::Read,
        }
    }

    fn call(&self, call: ToolCall) -> Result<serde_json::Value, ToolError> {
        let params = serde_json::from_value(call.params.clone())
            .map_err(|error| ToolError::new("tool.invalidArguments", error.to_string()))?;
        serde_json::to_value(self.state.inspect(&call, params)?)
            .map_err(|error| ToolError::new("tool.internalError", error.to_string()))
    }
}
