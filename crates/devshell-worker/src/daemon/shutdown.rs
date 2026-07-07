use std::thread;
use std::time::{Duration, Instant};

use crate::daemon::process;
use crate::rpc::request::RpcRequest;
use crate::socket::SocketPaths;
use crate::storage::InstancePaths;

pub fn request_stop(socket_paths: &SocketPaths) -> Result<(), String> {
    let response = crate::rpc::bridge::send_request(
        &socket_paths.socket_file,
        &RpcRequest::request("stop-1", "worker.stop", serde_json::json!({})),
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

pub fn wait_until_stopped(
    instance_paths: &InstancePaths,
    socket_paths: &SocketPaths,
    timeout: Duration,
) -> Result<(), String> {
    let started = Instant::now();
    while started.elapsed() <= timeout {
        if !process::is_running(instance_paths, &socket_paths.socket_file) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(50));
    }

    Err(format!(
        "daemon did not stop for {}",
        instance_paths.instance_root.display()
    ))
}
