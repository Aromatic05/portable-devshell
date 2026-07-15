use std::fs;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use crate::daemon::log_writer::append_log;
use crate::daemon::process;
use crate::instance::{InstanceLock, InstanceName, read_config};
use crate::reverse::connector::ReverseConnector;
use crate::rpc::codec::{decode_request_frame, read_frame, write_response};
use crate::rpc::error::RpcError;
use crate::rpc::response::RpcResponse;
use crate::rpc::router::RpcRouter;
use crate::socket::{LocalIpcListener, LocalIpcStream, SocketPaths};
use crate::storage::InstancePaths;
use crate::storage::permissions::{ensure_dir, ensure_file_mode};
use crate::tools::artifact::payload::ArtifactPayloadStore;
use crate::tools::artifact::receive::ArtifactReceiveStore;
use crate::tools::artifact::store::ArtifactStore;
use crate::tools::builtin_registry;

const FAIL_AFTER_BIND_ENV: &str = "DEVSHELL_WORKER_TEST_FAIL_AFTER_BIND";
const FAIL_ACCEPT_LOOP_ENV: &str = "DEVSHELL_WORKER_TEST_FAIL_ACCEPT_LOOP";

pub fn serve(instance: InstanceName) -> Result<(), String> {
    let instance_paths = InstancePaths::resolve(&instance)?;
    let socket_paths = SocketPaths::resolve(&instance)?;
    ensure_dir(&instance_paths.logs_dir, 0o700)?;
    ensure_dir(&instance_paths.artifacts_dir, 0o700)?;
    ensure_dir(&instance_paths.state_dir, 0o700)?;
    ensure_dir(&socket_paths.instance_runtime_dir, 0o700)?;
    let _daemon_lock = InstanceLock::acquire_daemon(&instance_paths)?;
    let config = read_config(&instance_paths, &instance)?;
    let runtime = process::read_runtime_context()?;
    let runtime_guard = RuntimeFilesGuard::new(instance_paths.clone(), socket_paths.clone());

    process::remove_ipc_endpoint_if_exists(&socket_paths.socket_file)?;
    process::write_pid(&instance_paths, std::process::id())?;
    append_log(&instance_paths, "daemon starting")?;

    let listener = match LocalIpcListener::bind(&socket_paths.socket_file) {
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

    let artifacts =
        ArtifactStore::new(instance_paths.artifacts_dir.clone()).map_err(|error| error.message)?;
    let payloads = ArtifactPayloadStore::new(
        instance_paths.artifacts_dir.join("payloads"),
        Arc::clone(&artifacts),
    )
    .map_err(|error| error.message)?;
    let receives = ArtifactReceiveStore::new(instance_paths.artifacts_dir.join("receives"))
        .map_err(|error| error.message)?;
    let builtin_tools = builtin_registry(
        &instance_paths,
        &socket_paths,
        &config,
        &runtime,
        Arc::clone(&artifacts),
    )
    .map_err(|error| error.message)?;
    let tools = Arc::new(builtin_tools.registry);
    let router = Arc::new(RpcRouter::new(
        config.clone(),
        runtime,
        tools,
        builtin_tools.files,
        payloads,
        receives,
    ));
    let _reverse_connector = config.reverse.clone().map(|reverse| {
        ReverseConnector::new(
            instance.clone(),
            instance_paths.clone(),
            reverse,
            Arc::clone(&router),
        )
        .spawn()
    });

    while !router.shutdown_requested() {
        if test_flag_enabled(FAIL_ACCEPT_LOOP_ENV) {
            return Err("forced accept loop failure for testing".to_string());
        }
        match listener.accept() {
            Ok(stream) => {
                stream
                    .set_nonblocking(false)
                    .map_err(|error| format!("failed to set accepted stream blocking: {error}"))?;
                let router = Arc::clone(&router);
                let instance_paths = instance_paths.clone();
                thread::spawn(move || {
                    if let Err(error) = handle_connection(stream, router) {
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

fn handle_connection(stream: LocalIpcStream, router: Arc<RpcRouter>) -> Result<(), String> {
    let mut reader = stream
        .try_clone()
        .map_err(|error| format!("failed to clone rpc connection: {error}"))?;
    let writer = Arc::new(Mutex::new(stream));

    loop {
        let frame = match read_frame(&mut reader) {
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
                    let _ = write_serialized_response(&writer, &response);
                }
                return Err(error);
            }
        };

        match decode_request_frame(&frame) {
            Ok(request) if router.is_control_method(&request.method) => {
                let response = router.dispatch_control(request);
                write_serialized_response(&writer, &response)?;
                if router.shutdown_requested() {
                    if let Ok(stream) = writer.lock() {
                        let _ = stream.shutdown_both();
                    }
                    return Ok(());
                }
            }
            Ok(request) => match router.acquire_tool_permit(&request) {
                Ok(permit) => {
                    #[cfg(unix)]
                    {
                        let router = Arc::clone(&router);
                        let writer = Arc::clone(&writer);
                        thread::spawn(move || {
                            let response = router.dispatch_tool(request, permit);
                            let _ = write_serialized_response(&writer, &response);
                        });
                    }
                    #[cfg(windows)]
                    {
                        // The Windows bridge opens one named-pipe connection per request.
                        // Keep synchronous I/O on that connection ordered: dispatch and write
                        // the response before the connection thread blocks on another read.
                        let response = router.dispatch_tool(request, permit);
                        write_serialized_response(&writer, &response)?;
                    }
                }
                Err(error) => {
                    let response = RpcResponse::failure(request.id, error);
                    write_serialized_response(&writer, &response)?;
                }
            },
            Err(error) => {
                let response = RpcResponse::failure(error.id, error.error);
                write_serialized_response(&writer, &response)?;
            }
        }
    }
}

fn write_serialized_response(
    writer: &Arc<Mutex<LocalIpcStream>>,
    response: &RpcResponse,
) -> Result<(), String> {
    let mut stream = writer
        .lock()
        .map_err(|_| "rpc connection writer lock poisoned".to_string())?;
    write_response(&mut *stream, response)
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
