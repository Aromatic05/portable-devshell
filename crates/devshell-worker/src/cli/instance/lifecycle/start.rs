use serde::Serialize;

use crate::capability::rpc::bridge::send_request_with_timeout;
use crate::capability::rpc::codec::PROTOCOL_VERSION;
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
    let mut previous_generation = state::generation(&instance_paths);
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

    let status = send_request_with_timeout(
        &socket_paths.socket_file,
        &RpcRequest::request("status-1", "worker.status", serde_json::json!({})),
        std::time::Duration::from_secs(5),
    )?;
    if !status.ok {
        return Err(status
            .error
            .map(|error| error.message)
            .unwrap_or_else(|| "worker status request failed".to_string()));
    }

    let pid = process::read_pid(&instance_paths);
    // Reconnect and generation allocation take this lock too. The request
    // returns a baseline serialized with generation allocation, so an older
    // Ready cannot satisfy it even if a natural reconnect raced with start.
    drop(_lock);
    if reverse && !started {
        let request = send_request_with_timeout(
            &socket_paths.socket_file,
            &RpcRequest::request(
                "reconnect-1",
                "worker.reconnect",
                serde_json::json!({"expectedPid": pid}),
            ),
            std::time::Duration::from_secs(5),
        )?;
        match request
            .result
            .as_ref()
            .and_then(|value| value.get("generation"))
            .and_then(serde_json::Value::as_u64)
        {
            Some(generation) if request.ok => previous_generation = generation,
            _ if request
                .error
                .as_ref()
                .is_some_and(|error| error.code == "rpc.methodNotFound") =>
            {
                return Err("running Worker does not support worker.reconnect; cannot prove fresh Reverse Ready; daemon preserved; explicitly upgrade it before retrying".to_string());
            }
            _ => {
                let reason = request.error.map(|error| error.message).unwrap_or_else(|| {
                    "Worker reconnect did not provide a generation baseline".to_string()
                });
                return Err(format!(
                    "{reason}; cannot prove fresh Reverse Ready; daemon preserved"
                ));
            }
        }
    }
    // Upgrade restart and daemon replacement also acquire this lock. Never
    // hold it while waiting for the Control-side final Ready handshake.
    if reverse {
        eprintln!("Waiting for Reverse Worker {instance} to become Ready...");
        wait_for_reverse_ready(&instance_paths, &socket_paths, previous_generation, started)?;
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
    let current_sha256 = process::current_worker_sha256();
    let status = send_request_with_timeout(
        &socket_paths.socket_file,
        &RpcRequest::request("status-identity", "worker.status", serde_json::json!({})),
        std::time::Duration::from_secs(5),
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
    let running_version = status
        .result
        .as_ref()
        .and_then(|result| result.get("workerVersion"))
        .and_then(serde_json::Value::as_str);
    if let (Some(running), Some(current)) = (running_sha256, current_sha256.as_deref()) {
        if running == current {
            return Ok(true);
        }
        if running_version == Some(env!("CARGO_PKG_VERSION")) {
            return Err("running Worker has the same version but a different build; daemon preserved; use an explicit upgrade to replace it".to_string());
        }
    }
    if let Some(running_version) = running_version {
        let running = semver::Version::parse(running_version)
            .map_err(|_| "cannot determine running Worker version; daemon preserved".to_string())?;
        let current =
            semver::Version::parse(env!("CARGO_PKG_VERSION")).map_err(|error| error.to_string())?;
        if running > current {
            return Err(format!(
                "running Worker {running} is newer than this CLI {current}; daemon preserved"
            ));
        }
    }
    let protocol = status
        .result
        .as_ref()
        .and_then(|value| value.get("protocolVersion"))
        .and_then(serde_json::Value::as_str);
    if protocol == Some(PROTOCOL_VERSION)
        && (running_version.is_none() || running_version == Some(env!("CARGO_PKG_VERSION")))
    {
        // Missing content identity is not evidence of a different binary.
        // Reuse a protocol-compatible daemon unless its version proves that
        // this CLI start requests a version change.
        return Ok(true);
    }
    if protocol.is_none()
        || running_version.is_none()
        || running_version == Some(env!("CARGO_PKG_VERSION"))
    {
        return Err(
            "cannot establish compatibility of running Worker; daemon preserved".to_string(),
        );
    }
    eprintln!(
        "Running Worker version differs from this CLI; restarting with {}.",
        env!("CARGO_PKG_VERSION")
    );
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
    started: bool,
) -> Result<(), String> {
    // Bound only an observed Control upgrade, including a stalled helper.
    // Ordinary offline reconnects may wait indefinitely and remain interruptible.
    let mut upgrade_deadline: Option<std::time::Instant> = None;
    loop {
        // The lifecycle lock also covers replacement and rollback. Observe only
        // completed lifecycle operations, never their temporary stopped state.
        if let Some(_lock) = InstanceLock::try_acquire(paths)? {
            if process::daemon_state(paths, sockets) != DaemonState::Running {
                return Err("Worker stopped before Reverse Ready".to_string());
            }
            let connection = state::read(paths).filter(|connection| {
                connection.pid == process::read_pid(paths).unwrap_or(0)
                    && connection.generation == state::generation(paths)
                    && (started || connection.generation > previous_generation)
            });
            if let Some(connection) = connection {
                if connection.state == "failed" {
                    return Err(connection
                        .last_error
                        .unwrap_or_else(|| "Reverse connector failed".to_string()));
                }
                if connection.generation > previous_generation && connection.state == "connected" {
                    return Ok(());
                }
                if connection.state == "upgrading" && upgrade_deadline.is_none() {
                    // Once an upgrade is observed, later reconnecting states
                    // must not turn the bounded upgrade wait into an infinite
                    // ordinary-offline wait.
                    upgrade_deadline =
                        Some(std::time::Instant::now() + std::time::Duration::from_secs(300));
                }
            }
        }
        if upgrade_deadline.is_some_and(|deadline| std::time::Instant::now() >= deadline) {
            return Err("timed out waiting for Reverse Ready after Control reported upgrading; daemon preserved; inspect Worker logs".to_string());
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
}
