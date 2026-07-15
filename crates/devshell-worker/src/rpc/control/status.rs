use std::sync::Arc;

use serde_json::json;

use crate::daemon::process::WorkerRuntimeContext;
use crate::rpc::codec::PROTOCOL_VERSION;
use crate::rpc::router::{ControlHandler, control_handler};

pub fn handler(runtime: WorkerRuntimeContext) -> Arc<dyn ControlHandler> {
    control_handler(move |_| {
        Ok(json!({
            "instance": runtime.instance.as_str(),
            "workspace": runtime.workspace,
            "protocolVersion": PROTOCOL_VERSION,
            "workerVersion": env!("CARGO_PKG_VERSION"),
            "workerSha256": runtime.worker_sha256,
            "securityMode": match runtime.security_mode {
                crate::security::SecurityMode::Disabled => "disabled",
                crate::security::SecurityMode::Workspace => "workspace",
            }
        }))
    })
}
