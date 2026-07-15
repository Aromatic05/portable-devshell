use std::sync::Arc;

use crate::tools::tmux::group::tmux_input_name;
use crate::tools::tmux::state::TmuxState;
use crate::tools::tmux::types::{TmuxInputParams, TmuxTaskOperationOutput};
use crate::tools::{ToolCall, ToolCapability, ToolCatalogEntry, ToolError, ToolHandler, ToolName};

pub struct TmuxInputTool {
    name: ToolName,
    state: Arc<TmuxState>,
}

impl TmuxInputTool {
    pub fn new(state: Arc<TmuxState>) -> Self {
        Self {
            name: tmux_input_name(),
            state,
        }
    }
}

impl ToolHandler for TmuxInputTool {
    fn name(&self) -> &ToolName {
        &self.name
    }

    fn catalog_entry(&self) -> ToolCatalogEntry {
        crate::tools::contract::catalog_entry::<TmuxInputParams, TmuxTaskOperationOutput>(
            &self.name,
            "Send terminal input to a running task. Caret notation supports ^C, ^D, ^I, and ^M. Ctrl-B is forbidden.".to_string(),
            [ToolCapability::Execute],
        )
    }

    fn call(&self, call: ToolCall) -> Result<serde_json::Value, ToolError> {
        let params = serde_json::from_value(call.params.clone())
            .map_err(|error| ToolError::new("tool.invalidArguments", error.to_string()))?;
        serde_json::to_value(self.state.input(&call, params)?)
            .map_err(|error| ToolError::new("tool.internalError", error.to_string()))
    }
}
