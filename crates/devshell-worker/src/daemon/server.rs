use std::fs;
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use crate::daemon::log_writer::append_log;
use crate::daemon::process;
use crate::instance::{InstanceName, read_config};
use crate::rpc::codec::{decode_request_frame, read_frame, write_response};
use crate::rpc::error::RpcError;
use crate::rpc::response::RpcResponse;
use crate::rpc::router::RpcRouter;
use crate::socket::SocketPaths;
use crate::storage::InstancePaths;
use crate::storage::permissions::{ensure_dir, ensure_file_mode};
use crate::tools::builtin_registry;

const FAIL_AFTER_BIND_ENV: &str = "DEVSHELL_WORKER_TEST_FAIL_AFTER_BIND";
const FAIL_ACCEPT_LOOP_ENV: &str = "DEVSHELL_WORKER_TEST_FAIL_ACCEPT_LOOP";

pub fn serve(instance: InstanceName) -> Result<(), String> {
    let instance_paths = InstancePaths::resolve(&instance)?;
    let socket_paths = SocketPaths::resolve(&instance)?;
    ensure_dir(&instance_paths.logs_dir, 0o700)?;
    ensure_dir(&instance_paths.state_dir, 0o700)?;
    ensure_dir(&socket_paths.instance_runtime_dir, 0o700)?;
    let config = read_config(&instance_paths, &instance)?;
    let runtime = process::read_runtime_context()?;
    let runtime_guard = RuntimeFilesGuard::new(instance_paths.clone(), socket_paths.clone());

    process::remove_if_exists(&socket_paths.socket_file)?;
    process::write_pid(&instance_paths, std::process::id())?;
    append_log(&instance_paths, "daemon starting")?;

    let listener = match UnixListener::bind(&socket_paths.socket_file) {
        Ok(listener) => listener,
        Err(error) => {
            let _ = process::clear_runtime_files(&instance_paths, &socket_paths.socket_file);
            return Err(format!(
                "failed to bind {}: {error}",
                socket_paths.socket_file.display()
            ));
        }
    };
    if test_flag_enabled(FAIL_AFTER_BIND_ENV) {
        return Err("forced failure after bind for testing".to_string());
    }
    ensure_file_mode(&socket_paths.socket_file, 0o600)?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("failed to set listener nonblocking: {error}"))?;

    let tools = Arc::new(builtin_registry().map_err(|error| error.message)?);
    let router = Arc::new(RpcRouter::new(config.clone(), runtime, tools));

    while !router.shutdown_requested() {
        if test_flag_enabled(FAIL_ACCEPT_LOOP_ENV) {
            return Err("forced accept loop failure for testing".to_string());
        }
        match listener.accept() {
            Ok((stream, _)) => {
                stream
                    .set_nonblocking(false)
                    .map_err(|error| format!("failed to set accepted stream blocking: {error}"))?;
                let router = Arc::clone(&router);
                let instance_paths = instance_paths.clone();
                thread::spawn(move || {
                    if let Err(error) = handle_connection(stream, &router) {
                        let _ = append_log(&instance_paths, &format!("connection error: {error}"));
                    }
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(50));
            }
            Err(error) => {
                return Err(format!("failed to accept connection: {error}"));
            }
        }
    }

    append_log(&instance_paths, "daemon stopping")?;
    runtime_guard.disarm();
    process::clear_runtime_files(&instance_paths, &socket_paths.socket_file)?;
    remove_empty_runtime_dir(&socket_paths.instance_runtime_dir);
    Ok(())
}

fn handle_connection(mut stream: UnixStream, router: &RpcRouter) -> Result<(), String> {
    loop {
        let frame = match read_frame(&mut stream) {
            Ok(Some(frame)) => frame,
            Ok(None) => return Ok(()),
            Err(error) => {
                if error.starts_with("rpc.frameTooLarge:") {
                    let response = RpcResponse::failure(
                        String::new(),
                        RpcError::new(
                            "rpc.frameTooLarge",
                            format!(
                                "RPC frame exceeds maximum allowed size of {} bytes.",
                                crate::rpc::codec::MAX_FRAME_SIZE
                            ),
                        ),
                    );
                    let _ = write_response(&mut stream, &response);
                }
                return Err(error);
            }
        };

        match decode_request_frame(&frame) {
            Ok(request) => {
                let response = router.dispatch(request);
                write_response(&mut stream, &response)?;
                if router.shutdown_requested() {
                    break;
                }
            }
            Err(error) => {
                let response = RpcResponse::failure(error.id, error.error);
                write_response(&mut stream, &response)?;
            }
        }
    }

    Ok(())
}

fn remove_empty_runtime_dir(path: &std::path::Path) {
    match fs::remove_dir(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => {}
    }
}

struct RuntimeFilesGuard {
    instance_paths: InstancePaths,
    socket_paths: SocketPaths,
    armed: bool,
}

impl RuntimeFilesGuard {
    fn new(instance_paths: InstancePaths, socket_paths: SocketPaths) -> Self {
        Self {
            instance_paths,
            socket_paths,
            armed: true,
        }
    }

    fn disarm(mut self) {
        self.armed = false;
    }
}

impl Drop for RuntimeFilesGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ =
                process::clear_runtime_files(&self.instance_paths, &self.socket_paths.socket_file);
            remove_empty_runtime_dir(&self.socket_paths.instance_runtime_dir);
        }
    }
}

fn test_flag_enabled(name: &str) -> bool {
    std::env::var_os(name).is_some()
}
