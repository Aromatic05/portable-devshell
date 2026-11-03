use serde::Serialize;

use crate::capability::rpc::bridge::send_request;
use crate::capability::rpc::request::RpcRequest;
use crate::cli::InstanceArgs;
use crate::daemon::process;
use crate::daemon::process::DaemonState;
use crate::daemon::process::lifecycle::{readiness, shutdown};
use crate::instance::storage::InstancePaths;
use crate::instance::storage::ensure_dir;
use crate::instance::{InstanceLock, InstanceName, build_config, read_config, write_config};
use crate::transport::endpoint::channel::EndpointPaths;
use crate::transport::reverse::state;

#[derive(Serialize)]
struct StartResponse {
    ok: bool,
    instance: String,
    started: bool,
    pid: Option<u32>,
}

pub fn run(args: InstanceArgs) -> Result<String, String> {
    let instance = InstanceName::parse(&args.instance)?;
    let instance_paths = InstancePaths::resolve(&instance)?;
    let socket_paths = EndpointPaths::resolve(&instance)?;

    ensure_dir(&instance_paths.instance_root, 0o700)?;
    ensure_dir(&instance_paths.logs_dir, 0o700)?;
    ensure_dir(&instance_paths.artifacts_dir, 0o700)?;
    ensure_dir(&instance_paths.state_dir, 0o700)?;
    ensure_dir(&socket_paths.instance_runtime_dir, 0o700)?;

    let _lock = InstanceLock::acquire(&instance_paths)?;
    let reverse = instance_paths.config_file.exists()
        && read_config(&instance_paths, &instance)?.reverse.is_some();
    let previous_generation = state::generation(&instance_paths);
    let started = match process::daemon_state(&instance_paths, &socket_paths) {
        DaemonState::Running if running_daemon_matches_current_worker(&socket_paths)? => false,
        DaemonState::Running => {
            crate::cli::instance::lifecycle::stop::stop_running_daemon(
                &instance_paths,
                &socket_paths,
            )?;
            start_daemon(&instance, &instance_paths, &socket_paths)?;
            true
        }
        DaemonState::Stale => {
            shutdown::stop_stale_daemon(
                &instance_paths,
                &socket_paths,
                std::time::Duration::from_secs(5),
            )?;
            start_daemon(&instance, &instance_paths, &socket_paths)?;
            true
        }
        DaemonState::Stopped => {
            start_daemon(&instance, &instance_paths, &socket_paths)?;
            true
        }
    };

    let status = send_request(
        &socket_paths.socket_file,
        &RpcRequest::request("status-1", "worker.status", serde_json::json!({})),
    )?;
    if !status.ok {
        return Err(status
            .error
            .map(|error| error.message)
            .unwrap_or_else(|| "worker status request failed".to_string()));
    }

    if reverse && !started {
        let request = send_request(
            &socket_paths.socket_file,
            &RpcRequest::request("reconnect-1", "worker.reconnect", serde_json::json!({})),
        )?;
        if !request.ok {
            return Err(request
                .error
                .map(|error| error.message)
                .unwrap_or_else(|| "Worker reconnect request failed".to_string()));
        }
    }
    // Upgrade restart and daemon replacement also acquire this lock. Never
    // hold it while waiting for the Control-side final Ready handshake.
    drop(_lock);
    if reverse {
        eprintln!("Waiting for Reverse Worker {instance} to become Ready...");
        wait_for_reverse_ready(&instance_paths, &socket_paths, previous_generation)?;
    }

    serde_json::to_string_pretty(&StartResponse {
        ok: true,
        instance: instance.as_str().to_string(),
        started,
        pid: process::read_pid(&instance_paths),
    })
    .map_err(|error| error.to_string())
}

fn running_daemon_matches_current_worker(socket_paths: &EndpointPaths) -> Result<bool, String> {
    let Some(current_sha256) = process::current_worker_sha256() else {
        return Err(
            "cannot identify the current Worker binary; running daemon preserved".to_string(),
        );
    };
    let status = send_request(
        &socket_paths.socket_file,
        &RpcRequest::request("status-identity", "worker.status", serde_json::json!({})),
    )?;
    if !status.ok {
        return Err(status
            .error
            .map(|error| error.message)
            .unwrap_or_else(|| "worker status identity request failed".to_string()));
    }
    let running_sha256 = status
        .result
        .as_ref()
        .and_then(|result| result.get("workerSha256"))
        .and_then(serde_json::Value::as_str);
    let Some(running_sha256) = running_sha256 else {
        return Err("running Worker has no SHA identity; daemon preserved for Control version negotiation; upgrade it before requesting fresh Ready with this CLI".to_string());
    };
    if running_sha256 == current_sha256 {
        return Ok(true);
    }
    if status
        .result
        .as_ref()
        .and_then(|result| result.get("workerVersion"))
        .and_then(serde_json::Value::as_str)
        == Some(env!("CARGO_PKG_VERSION"))
    {
        return Err("running Worker has the same version but a different build; daemon preserved; use an explicit upgrade to replace it".to_string());
    }
    Ok(false)
}

pub(crate) fn start_daemon(
    instance: &InstanceName,
    instance_paths: &InstancePaths,
    socket_paths: &EndpointPaths,
) -> Result<(), String> {
    if !instance_paths.config_file.exists() {
        let config = build_config(instance)?;
        write_config(instance_paths, &config)?;
    }

    let runtime = process::WorkerRuntimeContext {
        instance: instance.clone(),
        platform: process::PlatformInfo {
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
        },
        security_mode: process::current_security_mode(),
        worker_sha256: process::current_worker_sha256(),
    };
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    start_daemon_executable(
        instance,
        instance_paths,
        socket_paths,
        &runtime,
        &executable,
    )
}

pub(crate) fn start_daemon_executable(
    instance: &InstanceName,
    instance_paths: &InstancePaths,
    socket_paths: &EndpointPaths,
    runtime: &process::WorkerRuntimeContext,
    executable: &std::path::Path,
) -> Result<(), String> {
    let mut daemon = process::spawn_executable(instance, instance_paths, runtime, executable)?;
    let readiness_timeout = std::env::var("DEVSHELL_WORKER_TEST_READY_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .map(std::time::Duration::from_millis)
        .unwrap_or_else(|| std::time::Duration::from_secs(5));
    if let Err(error) = readiness::wait_until_ready(socket_paths, readiness_timeout) {
        let cleanup = shutdown::terminate_spawned_daemon(
            &mut daemon,
            instance_paths,
            socket_paths,
            std::time::Duration::from_secs(5),
        );
        if let Err(cleanup_error) = cleanup {
            return Err(format!("{error}; cleanup failed: {cleanup_error}"));
        }
        return Err(error);
    }
    Ok(())
}

fn wait_for_reverse_ready(
    paths: &InstancePaths,
    sockets: &EndpointPaths,
    previous_generation: u64,
) -> Result<(), String> {
    loop {
        // The lifecycle lock also covers replacement and rollback. Observe only
        // completed lifecycle operations, never their temporary stopped state.
        {
            let _lock = InstanceLock::acquire(paths)?;
            if process::daemon_state(paths, sockets) != DaemonState::Running {
                return Err("Worker stopped before Reverse Ready".to_string());
            }
            if let Some(connection) = state::read(paths) {
                if connection.pid == process::read_pid(paths).unwrap_or(0)
                    && connection.state == "failed"
                {
                    return Err(connection
                        .last_error
                        .unwrap_or_else(|| "Reverse connector failed".to_string()));
                }
                if connection.pid == process::read_pid(paths).unwrap_or(0)
                    && connection.generation == state::generation(paths)
                    && connection.generation > previous_generation
                    && connection.state == "connected"
                {
                    return Ok(());
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
}
