use std::thread;
use std::time::{Duration, Instant};

use crate::daemon::process;
use crate::instance::InstanceLock;
use crate::platform::{process_is_running, terminate_process};
use crate::rpc::request::RpcRequest;
use crate::socket::SocketPaths;
use crate::storage::InstancePaths;

pub fn request_stop(socket_paths: &SocketPaths) -> Result<(), String> {
    let response = crate::rpc::bridge::send_request_with_timeout(
        &socket_paths.socket_file,
        &RpcRequest::request("stop-1", "worker.stop", serde_json::json!({})),
        Duration::from_secs(1),
    )?;

    if response.ok {
        Ok(())
    } else {
        let error = response
            .error
            .map(|value| value.message)
            .unwrap_or_else(|| "daemon stop request failed".to_string());
        Err(error)
    }
}

pub fn stop_stale_daemon(
    instance_paths: &InstancePaths,
    socket_paths: &SocketPaths,
    timeout: Duration,
) -> Result<bool, String> {
    let Some(pid) = process::read_pid(instance_paths) else {
        process::clear_runtime_files(instance_paths, &socket_paths.socket_file)?;
        return Ok(false);
    };

    if !process_is_running(pid) {
        process::clear_runtime_files(instance_paths, &socket_paths.socket_file)?;
        return Ok(false);
    }

    if InstanceLock::try_acquire_daemon(instance_paths)?.is_some() {
        process::clear_runtime_files(instance_paths, &socket_paths.socket_file)?;
        return Ok(false);
    }

    terminate_daemon_process(pid, instance_paths, socket_paths, timeout)?;
    Ok(true)
}

pub fn terminate_daemon_process(
    pid: u32,
    instance_paths: &InstancePaths,
    socket_paths: &SocketPaths,
    timeout: Duration,
) -> Result<(), String> {
    if process_is_running(pid) {
        terminate_process(pid, false)?;
        if !wait_for_process_exit(pid, timeout) {
            terminate_process(pid, true)?;
            if !wait_for_process_exit(pid, timeout) {
                return Err(format!("daemon process {pid} did not stop"));
            }
        }
    }
    process::clear_runtime_files(instance_paths, &socket_paths.socket_file)
}

pub fn terminate_spawned_daemon(
    daemon: &mut process::SpawnedDaemon,
    instance_paths: &InstancePaths,
    socket_paths: &SocketPaths,
    timeout: Duration,
) -> Result<(), String> {
    let pid = daemon.pid();
    if !daemon.has_exited() {
        terminate_process(pid, false)?;
        if !wait_for_spawned_process_exit(daemon, timeout) {
            terminate_process(pid, true)?;
            if !wait_for_spawned_process_exit(daemon, timeout) {
                return Err(format!("daemon process {pid} did not stop"));
            }
        }
    }
    process::clear_runtime_files(instance_paths, &socket_paths.socket_file)
}

pub fn wait_until_stopped(
    expected_pid: Option<u32>,
    instance_paths: &InstancePaths,
    timeout: Duration,
) -> Result<(), String> {
    let started = Instant::now();
    while started.elapsed() <= timeout {
        let stopped = match expected_pid {
            Some(pid) => !process_is_running(pid),
            None => InstanceLock::try_acquire_daemon(instance_paths)?.is_some(),
        };
        if stopped {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(50));
    }

    Err(format!(
        "daemon did not stop for {}",
        instance_paths.instance_root.display()
    ))
}

fn wait_for_process_exit(pid: u32, timeout: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() <= timeout {
        if !process_is_running(pid) {
            return true;
        }
        thread::sleep(Duration::from_millis(50));
    }
    false
}

fn wait_for_spawned_process_exit(daemon: &mut process::SpawnedDaemon, timeout: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() <= timeout {
        if daemon.has_exited() {
            return true;
        }
        thread::sleep(Duration::from_millis(50));
    }
    daemon.has_exited()
}
