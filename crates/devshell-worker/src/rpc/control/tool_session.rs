use std::sync::Arc;

use serde::Deserialize;

use crate::rpc::error::RpcError;
use crate::rpc::request::RpcRequest;
use crate::rpc::router::ControlHandler;
use crate::tools::file::FileToolState;
#[cfg(unix)]
use crate::tools::tmux::state::TmuxState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ToolSessionCloseInput {
    session_id: String,
}

pub struct ToolSessionCloseHandler {
    files: Arc<FileToolState>,
    #[cfg(unix)]
    tmux: Option<Arc<TmuxState>>,
}

impl ToolSessionCloseHandler {
    pub fn new(files: Arc<FileToolState>, #[cfg(unix)] tmux: Option<Arc<TmuxState>>) -> Self {
        Self {
            files,
            #[cfg(unix)]
            tmux,
        }
    }
}

impl ControlHandler for ToolSessionCloseHandler {
    fn handle(&self, request: &RpcRequest) -> Result<serde_json::Value, RpcError> {
        let input: ToolSessionCloseInput = serde_json::from_value(request.params.clone())
            .map_err(|error| RpcError::new("rpc.invalidParams", error.to_string()))?;
        if input.session_id.is_empty() {
            return Err(RpcError::new(
                "rpc.invalidParams",
                "sessionId must not be empty",
            ));
        }
        self.files
            .session_snapshots
            .lock()
            .map_err(|_| RpcError::new("worker.internalError", "snapshot registry lock poisoned"))?
            .clear_session(&input.session_id);
        #[cfg(unix)]
        if let Some(tmux) = &self.tmux {
            tmux.close_session(&input.session_id)
                .map_err(|error| RpcError::new(error.code, error.message))?;
        }
        Ok(serde_json::json!({ "closed": true }))
    }
}
