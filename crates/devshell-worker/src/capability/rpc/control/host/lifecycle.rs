pub mod handshake {
    use std::sync::Arc;

    use serde_json::json;

    use crate::capability::rpc::codec::{LEGACY_PROTOCOL_VERSION, PROTOCOL_VERSION};
    use crate::capability::rpc::error::RpcError;
    use crate::capability::rpc::path::protocol_path;
    use crate::capability::rpc::router::{ControlHandler, control_handler};
    use crate::daemon::process::WorkerRuntimeContext;
    use crate::host::environment::detect_environment;
    use crate::host::home::user_home_directory;
    use crate::instance::WorkerConfig;
    use crate::tool::bash::model::ShellRuntime;

    pub fn handler(config: WorkerConfig, runtime: WorkerRuntimeContext) -> Arc<dyn ControlHandler> {
        control_handler(move |request| {
            let protocol_range = request.params.get("protocolRange");
            let compatible = if let Some(protocol_range) = protocol_range {
                let min = protocol_range
                    .get("min")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| RpcError::new("rpc.invalidParams", "missing protocolRange.min"))?;
                let max = protocol_range
                    .get("max")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| RpcError::new("rpc.invalidParams", "missing protocolRange.max"))?;
                let current = parse_protocol_version(PROTOCOL_VERSION)?;
                let min_version = parse_protocol_version(min)?;
                let max_version = parse_protocol_version(max)?;
                min_version <= current && current <= max_version
            } else {
                let min = request
                    .params
                    .get("minProtocolVersion")
                    .and_then(serde_json::Value::as_u64)
                    .ok_or_else(|| RpcError::new("rpc.invalidParams", "missing minProtocolVersion"))?;
                let max = request
                    .params
                    .get("maxProtocolVersion")
                    .and_then(serde_json::Value::as_u64)
                    .ok_or_else(|| RpcError::new("rpc.invalidParams", "missing maxProtocolVersion"))?;
                min <= LEGACY_PROTOCOL_VERSION as u64 && LEGACY_PROTOCOL_VERSION as u64 <= max
            };

            if !compatible {
                return Err(RpcError::new(
                    "worker.protocolVersionUnsupported",
                    "Worker protocol version is not supported by the client.",
                )
                .with_details(json!({
                    "workerProtocolVersion": PROTOCOL_VERSION,
                    "legacyProtocolVersion": LEGACY_PROTOCOL_VERSION,
                    "protocolRange": protocol_range,
                    "minProtocolVersion": request.params.get("minProtocolVersion"),
                    "maxProtocolVersion": request.params.get("maxProtocolVersion")
                })));
            }

            let shell = ShellRuntime::detect().ok();
            let environment = detect_environment();
            let home_directory = user_home_directory()
                .map_err(|error| RpcError::new("worker.environmentUnavailable", error))?;
            Ok(json!({
                "homeDirectory": protocol_path(&home_directory),
                "instance": config.instance,
                "workerVersion": env!("CARGO_PKG_VERSION"),
                "workerSha256": runtime.worker_sha256,
                "protocolVersion": PROTOCOL_VERSION,
                "legacyProtocolVersion": LEGACY_PROTOCOL_VERSION,
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
                    "streaming": true,
                    "cancel": true,
                    "terminalPty": crate::capability::rpc::control::terminal::capabilities()
                }
            }))
        })
    }

    fn parse_protocol_version(version: &str) -> Result<(u64, u64, u64), RpcError> {
        let mut parts = version.split('.');
        let major = parse_protocol_part(parts.next(), version)?;
        let minor = parse_protocol_part(parts.next(), version)?;
        let patch = parse_protocol_part(parts.next(), version)?;
        if parts.next().is_some() {
            return Err(invalid_protocol_version(version));
        }
        Ok((major, minor, patch))
    }

    fn parse_protocol_part(part: Option<&str>, version: &str) -> Result<u64, RpcError> {
        part.and_then(|value| value.parse::<u64>().ok())
            .ok_or_else(|| invalid_protocol_version(version))
    }

    fn invalid_protocol_version(version: &str) -> RpcError {
        RpcError::new(
            "rpc.invalidParams",
            format!("invalid protocol version {version}; expected x.y.z"),
        )
    }
}

pub mod ping {
    use std::sync::Arc;

    use serde_json::json;

    use crate::capability::rpc::router::{ControlHandler, control_handler};

    pub fn handler() -> Arc<dyn ControlHandler> {
        control_handler(|_| Ok(json!({ "pong": true })))
    }
}

pub mod status {
    use std::sync::Arc;

    use serde_json::json;

    use crate::capability::rpc::codec::{LEGACY_PROTOCOL_VERSION, PROTOCOL_VERSION};
    use crate::capability::rpc::router::{ControlHandler, control_handler};
    use crate::daemon::process::WorkerRuntimeContext;

    pub fn handler(runtime: WorkerRuntimeContext) -> Arc<dyn ControlHandler> {
        control_handler(move |_| {
            Ok(json!({
                "instance": runtime.instance.as_str(),
                "protocolVersion": PROTOCOL_VERSION,
                "legacyProtocolVersion": LEGACY_PROTOCOL_VERSION,
                "workerVersion": env!("CARGO_PKG_VERSION"),
                "workerSha256": runtime.worker_sha256,
                "securityMode": match runtime.security_mode {
                    crate::instance::sandbox::SecurityMode::Disabled => "disabled",
                    crate::instance::sandbox::SecurityMode::Workspace => "workspace",
                }
            }))
        })
    }
}

pub mod stop {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    use serde_json::json;

    use crate::capability::rpc::error::RpcError;
    use crate::capability::rpc::router::{ActiveToolCallRegistry, ControlHandler, control_handler};
    use crate::daemon::process::registry::ActiveProcessRegistry;

    const ACTIVE_PROCESS_STOP_TIMEOUT: Duration = Duration::from_secs(5);
    const ACTIVE_TOOL_CALL_STOP_TIMEOUT: Duration = Duration::from_secs(5);
    const FAIL_STOP_ENV: &str = "DEVSHELL_WORKER_TEST_FAIL_STOP";

    pub fn handler(
        shutdown_requested: Arc<AtomicBool>,
        active_processes: Arc<ActiveProcessRegistry>,
        active_tool_calls: Arc<ActiveToolCallRegistry>,
    ) -> Arc<dyn ControlHandler> {
        control_handler(move |_| {
            if std::env::var(FAIL_STOP_ENV).as_deref() == Ok("1") {
                return Err(stop_error("injected worker stop failure".to_string()));
            }
            active_tool_calls.begin_stop().map_err(stop_error)?;
            active_processes
                .stop_all(ACTIVE_PROCESS_STOP_TIMEOUT)
                .map_err(stop_error)?;
            active_tool_calls
                .wait_idle(ACTIVE_TOOL_CALL_STOP_TIMEOUT)
                .map_err(stop_error)?;
            shutdown_requested.store(true, Ordering::SeqCst);
            Ok(json!({ "stopping": true }))
        })
    }

    fn stop_error(message: String) -> RpcError {
        let mut error = RpcError::new("worker.stopFailed", message);
        error.retryable = true;
        error
    }
}
