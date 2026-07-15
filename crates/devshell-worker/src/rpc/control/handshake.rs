use std::sync::Arc;

use serde_json::json;

use crate::daemon::process::WorkerRuntimeContext;
use crate::instance::WorkerConfig;
use crate::platform::detect_environment;
use crate::rpc::codec::PROTOCOL_VERSION;
use crate::rpc::error::RpcError;
use crate::rpc::router::{ControlHandler, control_handler};
use crate::tools::bash::runtime::ShellRuntime;

pub fn handler(config: WorkerConfig, runtime: WorkerRuntimeContext) -> Arc<dyn ControlHandler> {
    control_handler(move |request| {
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
        let environment = detect_environment();
        Ok(json!({
            "instance": config.instance,
            "workspace": runtime.workspace,
            "workerVersion": env!("CARGO_PKG_VERSION"),
            "workerSha256": runtime.worker_sha256,
            "protocolVersion": PROTOCOL_VERSION,
            "platform": {
                "os": runtime.platform.os,
                "arch": runtime.platform.arch,
                "distribution": environment.distribution,
                "packageManager": environment.package_manager,
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
    })
}
