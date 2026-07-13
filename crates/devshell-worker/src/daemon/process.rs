#[cfg(windows)]
use std::ffi::OsStr;
use std::fs;
#[cfg(unix)]
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::process::{Command, Stdio};

use crate::instance::InstanceName;
#[cfg(unix)]
use crate::platform::configure_daemon_command;
use crate::platform::process_is_running;
#[cfg(windows)]
use crate::platform::spawn_daemon_process;
use crate::rpc::bridge::send_request;
use crate::rpc::request::RpcRequest;
use crate::security::SecurityMode;
use crate::socket::SocketPaths;
use crate::storage::InstancePaths;
#[cfg(unix)]
use crate::storage::permissions::ensure_file_mode;

pub const INTERNAL_INSTANCE_ENV: &str = "DEVSHELL_WORKER_INTERNAL_INSTANCE";
pub const INTERNAL_WORKSPACE_ENV: &str = "DEVSHELL_WORKER_INTERNAL_WORKSPACE";
pub const INTERNAL_SECURITY_MODE_ENV: &str = "DEVSHELL_WORKER_INTERNAL_SECURITY_MODE";
pub const SECURITY_MODE_ENV: &str = "DEVSHELL_WORKER_SECURITY_MODE";

#[derive(Clone, Debug)]
pub struct PlatformInfo {
    pub os: &'static str,
    pub arch: &'static str,
}

#[derive(Clone, Debug)]
pub struct WorkerRuntimeContext {
    pub instance: InstanceName,
    pub workspace: PathBuf,
    pub platform: PlatformInfo,
    pub security_mode: SecurityMode,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DaemonState {
    Running,
    Stopped,
    Stale,
}

pub fn spawn(
    instance: &InstanceName,
    paths: &InstancePaths,
    runtime: &WorkerRuntimeContext,
) -> Result<(), String> {
    #[cfg(unix)]
    {
        let log_file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&paths.log_file)
            .map_err(|error| format!("failed to open {}: {error}", paths.log_file.display()))?;
        ensure_file_mode(&paths.log_file, 0o600)?;
        let stdout_file = log_file
            .try_clone()
            .map_err(|error| format!("failed to clone {}: {error}", paths.log_file.display()))?;

        let mut command = Command::new(std::env::current_exe().map_err(|error| error.to_string())?);
        command
            .env(INTERNAL_INSTANCE_ENV, instance.as_str())
            .env(INTERNAL_WORKSPACE_ENV, &runtime.workspace)
            .env(
                INTERNAL_SECURITY_MODE_ENV,
                match runtime.security_mode {
                    SecurityMode::Disabled => "disabled",
                    SecurityMode::Workspace => "workspace",
                },
            )
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout_file))
            .stderr(Stdio::from(log_file));
        configure_daemon_command(&mut command);
        command
            .spawn()
            .map_err(|error| format!("failed to spawn daemon process: {error}"))?;
        Ok(())
    }
    #[cfg(windows)]
    {
        let _ = paths;
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let security_mode = OsStr::new(match runtime.security_mode {
            SecurityMode::Disabled => "disabled",
            SecurityMode::Workspace => "workspace",
        });
        spawn_daemon_process(
            &executable,
            &runtime.workspace,
            &[
                (INTERNAL_INSTANCE_ENV, OsStr::new(instance.as_str())),
                (INTERNAL_WORKSPACE_ENV, runtime.workspace.as_os_str()),
                (INTERNAL_SECURITY_MODE_ENV, security_mode),
            ],
        )
    }
}

pub fn capture_workspace() -> Result<PathBuf, String> {
    let cwd =
        std::env::current_dir().map_err(|error| format!("failed to read current dir: {error}"))?;
    let workspace = cwd.canonicalize().map_err(|error| {
        format!(
            "failed to canonicalize workspace {}: {error}",
            cwd.display()
        )
    })?;
    if !workspace.is_dir() {
        return Err(format!(
            "workspace is not a directory: {}",
            workspace.display()
        ));
    }
    Ok(workspace)
}

pub fn read_runtime_context() -> Result<WorkerRuntimeContext, String> {
    let instance = std::env::var(INTERNAL_INSTANCE_ENV)
        .map_err(|_| "internal daemon instance is missing".to_string())?;
    let instance = InstanceName::parse(&instance)?;
    let workspace = std::env::var_os(INTERNAL_WORKSPACE_ENV)
        .ok_or_else(|| "internal daemon workspace is missing".to_string())?;
    let workspace = PathBuf::from(workspace)
        .canonicalize()
        .map_err(|error| format!("failed to canonicalize daemon workspace: {error}"))?;
    if !workspace.is_dir() {
        return Err(format!(
            "daemon workspace is not a directory: {}",
            workspace.display()
        ));
    }
    Ok(WorkerRuntimeContext {
        instance,
        workspace,
        platform: PlatformInfo {
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
        },
        security_mode: read_security_mode_from_env(),
    })
}

pub fn current_security_mode() -> SecurityMode {
    read_security_mode_from_env()
}

fn read_security_mode_from_env() -> SecurityMode {
    let raw = std::env::var(INTERNAL_SECURITY_MODE_ENV)
        .ok()
        .or_else(|| std::env::var(SECURITY_MODE_ENV).ok());
    match raw.as_deref() {
        Some("workspace") => SecurityMode::Workspace,
        _ => SecurityMode::Disabled,
    }
}

pub fn read_pid(paths: &InstancePaths) -> Option<u32> {
    let text = fs::read_to_string(&paths.pid_file).ok()?;
    text.trim().parse::<u32>().ok()
}

pub fn write_pid(paths: &InstancePaths, pid: u32) -> Result<(), String> {
    fs::write(&paths.pid_file, format!("{pid}\n"))
        .map_err(|error| format!("failed to write {}: {error}", paths.pid_file.display()))
}

pub fn clear_pid(paths: &InstancePaths) -> Result<(), String> {
    remove_if_exists(&paths.pid_file)
}

pub fn clear_runtime_files(
    instance_paths: &InstancePaths,
    socket_path: &Path,
) -> Result<(), String> {
    clear_pid(instance_paths)?;
    remove_ipc_endpoint_if_exists(socket_path)
}

pub fn is_running(paths: &InstancePaths, socket_path: &Path) -> bool {
    #[cfg(windows)]
    let _ = socket_path;
    let Some(pid) = read_pid(paths) else {
        return false;
    };
    #[cfg(windows)]
    let endpoint_ready = true;
    #[cfg(unix)]
    let endpoint_ready = socket_path.exists();
    endpoint_ready && process_is_running(pid)
}

pub fn daemon_is_responsive(socket_paths: &SocketPaths) -> bool {
    matches!(
        send_request(
            &socket_paths.socket_file,
            &RpcRequest::request("ping-1", "worker.ping", serde_json::json!({})),
        ),
        Ok(response) if response.ok
    )
}

pub fn daemon_state(instance_paths: &InstancePaths, socket_paths: &SocketPaths) -> DaemonState {
    if daemon_is_responsive(socket_paths) {
        return DaemonState::Running;
    }

    if has_runtime_residue(instance_paths, socket_paths) {
        DaemonState::Stale
    } else {
        DaemonState::Stopped
    }
}

pub fn has_runtime_residue(instance_paths: &InstancePaths, socket_paths: &SocketPaths) -> bool {
    instance_paths.pid_file.exists()
        || unix_socket_exists(&socket_paths.socket_file)
        || read_pid(instance_paths)
            .map(process_is_running)
            .unwrap_or(false)
}

pub fn remove_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("failed to remove {}: {error}", path.display())),
    }
}

#[cfg(unix)]
fn unix_socket_exists(path: &Path) -> bool {
    path.exists()
}

#[cfg(windows)]
fn unix_socket_exists(_path: &Path) -> bool {
    false
}

pub fn remove_ipc_endpoint_if_exists(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    if path.to_string_lossy().starts_with(r"\\.\pipe\") {
        return Ok(());
    }
    remove_if_exists(path)
}
