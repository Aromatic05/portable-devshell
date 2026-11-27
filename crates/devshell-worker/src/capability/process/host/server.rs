use super::super::output::CaptureBudget;
use super::super::protocol::{self, Handshake, PROTOCOL_VERSION, execution_identity};
use super::super::shell::ShellRuntime;
use super::{Host, Registry};
use crate::capability::execution::ExecutionConfig;
use crate::instance::InstanceName;
use crate::instance::sandbox::build_security_policy;
use crate::instance::storage::{InstanceLock, InstancePaths, ensure_dir, ensure_file_mode};
use crate::transport::endpoint::channel::{EndpointPaths, LocalIpcListener};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use uuid::Uuid;

pub(crate) fn endpoint(paths: &EndpointPaths) -> PathBuf {
    #[cfg(unix)]
    {
        paths.instance_runtime_dir.join("process.sock")
    }
    #[cfg(windows)]
    {
        PathBuf::from(format!("{}-process", paths.socket_file.display()))
    }
}

struct EndpointGuard(PathBuf);

impl Drop for EndpointGuard {
    fn drop(&mut self) {
        let _ = crate::daemon::process::remove_ipc_endpoint_if_exists(&self.0);
    }
}

pub(crate) fn serve(instance: &InstanceName) -> Result<(), String> {
    let paths = InstancePaths::resolve(instance)?;
    let endpoints = EndpointPaths::resolve(instance)?;
    ensure_dir(&paths.state_dir, 0o700)?;
    ensure_dir(&endpoints.instance_runtime_dir, 0o700)?;
    let _lock = InstanceLock::acquire_path(&protocol::ownership_lock(&paths), true)?
        .ok_or_else(|| "process host already owns this instance".to_string())?;
    let endpoint = endpoint(&endpoints);
    crate::daemon::process::remove_ipc_endpoint_if_exists(&endpoint)?;
    let listener = LocalIpcListener::bind_private(&endpoint).map_err(|error| error.to_string())?;
    let _endpoint = EndpointGuard(endpoint.clone());
    ensure_file_mode(&endpoint, 0o600)?;
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;

    let security_mode = crate::daemon::process::read_security_mode_from_env();
    let host = Arc::new(Host {
        registry: Mutex::new(Registry::default()),
        shell: ShellRuntime::detect().map_err(|error| error.message)?,
        execution: ExecutionConfig::from_env()?,
        policy: build_security_policy(security_mode.clone()),
        instance_root: paths.instance_root,
        stopped: AtomicBool::new(false),
        capture_root: paths.state_dir.clone(),
        capture_budget: Arc::new(CaptureBudget::default()),
        handshake: Handshake {
            version: PROTOCOL_VERSION,
            pid: std::process::id(),
            instance: instance.as_str().to_owned(),
            generation: Uuid::new_v4().to_string(),
            execution_identity: execution_identity(&security_mode)?,
        },
    });
    while !host.stopped.load(Ordering::Acquire) {
        match listener.accept() {
            Ok(channel) => {
                channel.set_nonblocking(false).map_err(|error| {
                    format!("failed to set accepted Process Host stream blocking: {error}")
                })?;
                let host = Arc::clone(&host);
                std::thread::spawn(move || {
                    if let Err(error) = host.handle(channel) {
                        eprintln!("process host connection: {error}");
                    }
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}
