use serde_json::json;

use crate::daemon::process::WorkerRuntimeContext;
use crate::instance::WorkerConfig;
use crate::rpc::codec::PROTOCOL_VERSION;
use crate::rpc::error::RpcError;
use crate::rpc::request::RpcRequest;
use crate::rpc::router::ControlHandler;
use crate::tools::bash::runtime::ShellRuntime;

pub struct HandshakeHandler {
    config: WorkerConfig,
    runtime: WorkerRuntimeContext,
}

impl HandshakeHandler {
    pub fn new(config: WorkerConfig, runtime: WorkerRuntimeContext) -> Self {
        Self { config, runtime }
    }
}

impl ControlHandler for HandshakeHandler {
    fn handle(&self, request: &RpcRequest) -> Result<serde_json::Value, RpcError> {
        let min_protocol_version = request
            .params
            .get("minProtocolVersion")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| RpcError::new("rpc.invalidParams", "missing minProtocolVersion"))?;
        let max_protocol_version = request
            .params
            .get("maxProtocolVersion")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| RpcError::new("rpc.invalidParams", "missing maxProtocolVersion"))?;

        if PROTOCOL_VERSION as u64 > max_protocol_version
            || (PROTOCOL_VERSION as u64) < min_protocol_version
        {
            return Err(RpcError::new(
                "worker.protocolVersionUnsupported",
                "Worker protocol version is not supported by the client.",
            )
            .with_details(json!({
                "workerProtocolVersion": PROTOCOL_VERSION,
                "minProtocolVersion": min_protocol_version,
                "maxProtocolVersion": max_protocol_version
            })));
        }

        let shell = ShellRuntime::detect().ok();
        Ok(json!({
            "instance": self.config.instance,
            "workspace": self.runtime.workspace,
            "workerVersion": env!("CARGO_PKG_VERSION"),
            "protocolVersion": PROTOCOL_VERSION,
            "platform": {
                "os": self.runtime.platform.os,
                "arch": self.runtime.platform.arch,
                "shell": shell.as_ref().map(|shell| json!({
                    "kind": shell.kind,
                    "executable": shell.executable,
                    "version": shell.version
                }))
            },
            "capabilities": {
                "tools": true,
                "streaming": false,
                "cancel": true
            }
        }))
    }
}
