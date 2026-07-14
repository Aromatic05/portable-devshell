use serde::Serialize;

use crate::cli::InstanceArgs;
use crate::daemon::process::{self, DaemonState};
use crate::instance::InstanceName;
use crate::rpc::bridge::send_request;
use crate::rpc::request::RpcRequest;
use crate::socket::SocketPaths;
use crate::storage::InstancePaths;

#[derive(Serialize)]
struct StatusResponse {
    ok: bool,
    instance: String,
    state: &'static str,
    running: bool,
    pid: Option<u32>,
    workspace: Option<String>,
    #[serde(rename = "workerSha256")]
    worker_sha256: Option<String>,
}

pub fn run(args: InstanceArgs) -> Result<String, String> {
    let instance = InstanceName::parse(&args.instance)?;
    let instance_paths = InstancePaths::resolve(&instance)?;
    let socket_paths = SocketPaths::resolve(&instance)?;
    let pid = process::read_pid(&instance_paths);
    let daemon_state = process::daemon_state(&instance_paths, &socket_paths);
    let daemon_status = if daemon_state == DaemonState::Running {
        send_request(
            &socket_paths.socket_file,
            &RpcRequest::request("status-1", "worker.status", serde_json::json!({})),
        )?
        .result
    } else {
        None
    };
    let workspace = daemon_status
        .as_ref()
        .and_then(|result| result.get("workspace"))
        .and_then(serde_json::Value::as_str)
        .map(ToString::to_string);
    let worker_sha256 = daemon_status
        .as_ref()
        .and_then(|result| result.get("workerSha256"))
        .and_then(serde_json::Value::as_str)
        .map(ToString::to_string);

    let (state, running) = match daemon_state {
        DaemonState::Running => ("running", true),
        DaemonState::Stopped => ("stopped", false),
        DaemonState::Stale => ("stale", false),
    };

    serde_json::to_string_pretty(&StatusResponse {
        ok: true,
        instance: instance.as_str().to_string(),
        state,
        running,
        pid,
        workspace,
        worker_sha256,
    })
    .map_err(|error| error.to_string())
}
