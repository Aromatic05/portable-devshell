use std::thread;
use std::time::{Duration, Instant};

use crate::rpc::bridge::send_request;
use crate::rpc::request::RpcRequest;
use crate::socket::{SocketPaths, endpoint_may_exist};

pub fn wait_until_ready(socket_paths: &SocketPaths, timeout: Duration) -> Result<(), String> {
    let started = Instant::now();
    while started.elapsed() <= timeout {
        if endpoint_may_exist(&socket_paths.socket_file) {
            match send_request(
                &socket_paths.socket_file,
                &RpcRequest::request("ready-1", "worker.ping", serde_json::json!({})),
            ) {
                Ok(response) if response.ok => return Ok(()),
                Ok(_) | Err(_) => {}
            }
        }
        thread::sleep(Duration::from_millis(50));
    }

    Err(format!(
        "daemon did not become ready on {}",
        socket_paths.socket_file.display()
    ))
}
