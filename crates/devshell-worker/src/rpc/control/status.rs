use serde_json::json;

use crate::daemon::process::WorkerRuntimeContext;
use crate::rpc::codec::PROTOCOL_VERSION;
use crate::rpc::error::RpcError;
use crate::rpc::request::RpcRequest;
use crate::rpc::router::ControlHandler;

pub struct StatusHandler {
    runtime: WorkerRuntimeContext,
}

impl StatusHandler {
    pub fn new(runtime: WorkerRuntimeContext) -> Self {
        Self { runtime }
    }
}

impl ControlHandler for StatusHandler {
    fn handle(&self, _request: &RpcRequest) -> Result<serde_json::Value, RpcError> {
        Ok(json!({
            "instance": self.runtime.instance.as_str(),
            "workspace": self.runtime.workspace,
            "protocolVersion": PROTOCOL_VERSION,
            "workerVersion": env!("CARGO_PKG_VERSION"),
            "securityMode": match self.runtime.security_mode {
                crate::security::SecurityMode::Disabled => "disabled",
                crate::security::SecurityMode::Workspace => "workspace",
            }
        }))
    }
}
