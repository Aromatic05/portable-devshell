use std::sync::Arc;

use schemars::schema_for;

use crate::tools::tmux::group::tmux_send_name;
use crate::tools::tmux::state::TmuxState;
use crate::tools::tmux::types::{TmuxPaneOperationOutput, TmuxSendParams};
use crate::tools::{ToolAccess, ToolCall, ToolCatalogEntry, ToolError, ToolHandler, ToolName};

pub struct TmuxSendTool {
    name: ToolName,
    state: Arc<TmuxState>,
}

impl TmuxSendTool {
    pub fn new(state: Arc<TmuxState>) -> Self {
        Self {
            name: tmux_send_name(),
            state,
        }
    }
}

impl ToolHandler for TmuxSendTool {
    fn name(&self) -> &ToolName {
        &self.name
    }

    fn catalog_entry(&self) -> ToolCatalogEntry {
        ToolCatalogEntry {
            group: self.name.group().to_string(),
            name: self.name.as_str(),
            description: "Send real terminal input to one managed tmux pane. Caret notation is supported: append ^M to submit a command; common controls include ^C for interrupt, ^D for EOF, and ^I for Tab. ^B / Ctrl-B is forbidden. wait=block waits for command completion, wait=nonblock starts a long-running task, and wait=interactive sends input to an existing nonblock task.".to_string(),
            input_schema: serde_json::to_value(schema_for!(TmuxSendParams)).unwrap(),
            output_schema: serde_json::to_value(schema_for!(TmuxPaneOperationOutput)).unwrap(),
            access: ToolAccess::Execute,
        }
    }

    fn call(&self, call: ToolCall) -> Result<serde_json::Value, ToolError> {
        let params = serde_json::from_value(call.params.clone())
            .map_err(|error| ToolError::new("tool.invalidArguments", error.to_string()))?;
        serde_json::to_value(self.state.send(&call, params)?)
            .map_err(|error| ToolError::new("tool.internalError", error.to_string()))
    }
}
