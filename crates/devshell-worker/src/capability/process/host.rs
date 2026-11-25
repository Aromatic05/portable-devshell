//! Instance-local resource owner. The Worker and terminal clients connect to
//! this process, but neither owns the lifetime of a running command.

use std::collections::{BTreeMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::capability::execution::ExecutionConfig;
use crate::capability::rpc::{codec, error::RpcError, request::RpcRequest, response::RpcResponse};
use crate::instance::InstanceName;
use crate::instance::sandbox::path::{
    FilesystemCapability, PathNamespace, normalize_requested_path, parse_requested_path,
    resolve_existing_target,
};
use crate::instance::sandbox::{SecurityPolicy, build_security_policy};
use crate::instance::storage::{InstanceLock, InstancePaths, ensure_dir, ensure_file_mode};
use crate::transport::endpoint::channel::{EndpointPaths, LocalIpcListener, LocalIpcStream};

use super::managed::{ManagedProcess, SpawnSpec};
use super::shell::ShellRuntime;

const VERSION: u32 = 1;
const MAX_RESOURCES: usize = 64;
const MAX_WAIT_MS: u64 = 30_000;
const MAX_INPUT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SpawnInput {
    command: String,
    cwd: String,
    workspace: Option<PathBuf>,
    #[serde(default)]
    tty: bool,
    cols: Option<u16>,
    rows: Option<u16>,
    #[serde(default)]
    env: BTreeMap<String, Option<String>>,
    stdin: Option<String>,
    #[serde(default)]
    keep_stdin: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Target {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadInput {
    id: String,
    #[serde(default)]
    from_seq: u64,
    #[serde(default)]
    wait_ms: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WriteInput {
    id: String,
    data_base64: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResizeInput {
    id: String,
    cols: u16,
    rows: u16,
}

#[derive(Default)]
struct Registry {
    processes: BTreeMap<String, Arc<ManagedProcess>>,
    order: VecDeque<String>,
    retiring: bool,
}

struct Host {
    registry: Mutex<Registry>,
    shell: ShellRuntime,
    execution: Option<ExecutionConfig>,
    policy: Arc<dyn SecurityPolicy>,
    instance_root: PathBuf,
    stopped: AtomicBool,
}

impl Host {
    fn spawn(&self, mut input: SpawnInput) -> Result<Value, RpcError> {
        if input.command.trim().is_empty() {
            return Err(invalid("command is required"));
        }
        if input
            .stdin
            .as_ref()
            .is_some_and(|text| text.len() > MAX_INPUT_BYTES)
        {
            return Err(invalid("initial stdin exceeds the input limit"));
        }
        self.policy
            .check_capability(FilesystemCapability::ProcessExecute)
            .map_err(crate::tool::ToolError::from)?;
        let workspace = match input.workspace.as_ref() {
            Some(path) if path.is_absolute() => path.canonicalize().map_err(io_error)?,
            Some(_) => return Err(invalid("workspace must be absolute")),
            None => {
                if !Path::new(&input.cwd).is_absolute() {
                    return Err(invalid("cwd must be absolute without a workspace"));
                }
                self.instance_root.clone()
            }
        };
        let raw = normalize_requested_path(&input.cwd)?;
        let requested = parse_requested_path(&raw)?;
        let (read, write) = match requested.namespace {
            PathNamespace::Workspace => (
                FilesystemCapability::WorkspaceRead,
                FilesystemCapability::WorkspaceWrite,
            ),
            PathNamespace::Absolute => (
                FilesystemCapability::AbsoluteRead,
                FilesystemCapability::AbsoluteWrite,
            ),
        };
        self.policy
            .check_capability(read)
            .and_then(|_| self.policy.check_capability(write))
            .map_err(crate::tool::ToolError::from)?;
        let cwd = resolve_existing_target(&workspace, &requested)?;
        if !cwd.metadata().map_err(io_error)?.is_dir() {
            return Err(invalid("cwd must be a directory"));
        }
        let dimensions = if input.tty {
            let cols = input.cols.unwrap_or(80);
            let rows = input.rows.unwrap_or(24);
            validate_dimensions(cols, rows)?;
            Some((cols, rows))
        } else {
            if input.cols.is_some() || input.rows.is_some() {
                return Err(invalid("terminal dimensions require tty"));
            }
            None
        };
        if let Some(execution) = self.execution.as_ref() {
            let mut env = execution
                .environment(cwd.access_path())
                .map_err(|error| RpcError::new("execution.providerFailed", error))?;
            env.append(&mut input.env);
            input.env = env;
        }

        let mut registry = self.registry.lock().map_err(lock_error)?;
        if registry.retiring {
            return Err(RpcError::new(
                "process.retiring",
                "process host is retiring",
            ));
        }
        while registry.processes.len() >= MAX_RESOURCES {
            let Some(index) = registry
                .order
                .iter()
                .position(|id| registry.processes[id].descriptor().state != "running")
            else {
                return Err(RpcError::new(
                    "process.resourceLimit",
                    "all process slots are active",
                ));
            };
            let id = registry
                .order
                .remove(index)
                .expect("finished process index");
            registry.processes.remove(&id);
        }
        let id = format!("process-{}", Uuid::new_v4());
        let process = ManagedProcess::spawn(
            id.clone(),
            SpawnSpec {
                shell: &self.shell,
                command: &input.command,
                cwd: &cwd,
                env: &input.env,
                execution: self.execution.as_ref(),
                dimensions,
                stdin: input.stdin,
                keep_stdin: input.keep_stdin,
            },
        )?;
        let descriptor = process.descriptor();
        registry.order.push_back(id.clone());
        registry.processes.insert(id, process);
        serialize(descriptor)
    }

    fn require(&self, id: &str) -> Result<Arc<ManagedProcess>, RpcError> {
        self.registry
            .lock()
            .map_err(lock_error)?
            .processes
            .get(id)
            .cloned()
            .ok_or_else(|| RpcError::new("process.notFound", format!("unknown process {id}")))
    }

    fn retire(&self) -> Result<(), RpcError> {
        let processes = {
            let mut registry = self.registry.lock().map_err(lock_error)?;
            registry.retiring = true;
            registry.processes.values().cloned().collect::<Vec<_>>()
        };
        for process in &processes {
            process.kill()?;
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        for process in processes {
            if !process.wait_done(deadline.saturating_duration_since(Instant::now()))? {
                return Err(RpcError::new(
                    "process.retireTimeout",
                    "a process has not finished draining",
                ));
            }
        }
        Ok(())
    }

    fn dispatch(&self, request: &RpcRequest) -> Result<Value, RpcError> {
        match request.method.as_str() {
            "process.handshake" => Ok(json!({ "version": VERSION, "pid": std::process::id() })),
            "process.v1.spawn" => self.spawn(parse(request)?),
            "process.v1.list" => {
                let registry = self.registry.lock().map_err(lock_error)?;
                serialize(
                    registry
                        .order
                        .iter()
                        .map(|id| registry.processes[id].descriptor())
                        .collect::<Vec<_>>(),
                )
            }
            "process.v1.read" => {
                let input: ReadInput = parse(request)?;
                if input.wait_ms > MAX_WAIT_MS {
                    return Err(invalid("waitMs exceeds the host read window"));
                }
                serialize(
                    self.require(&input.id)?
                        .read(input.from_seq, Duration::from_millis(input.wait_ms))?,
                )
            }
            "process.v1.input" => {
                let input: WriteInput = parse(request)?;
                let data = STANDARD
                    .decode(&input.data_base64)
                    .map_err(|error| invalid(error.to_string()))?;
                if data.len() > MAX_INPUT_BYTES {
                    return Err(invalid("input exceeds the input limit"));
                }
                self.require(&input.id)?.input(&data)?;
                Ok(json!({ "accepted": true }))
            }
            "process.v1.resize" => {
                let input: ResizeInput = parse(request)?;
                validate_dimensions(input.cols, input.rows)?;
                self.require(&input.id)?.resize(input.cols, input.rows)?;
                Ok(json!({ "resized": true }))
            }
            "process.v1.kill" => {
                let input: Target = parse(request)?;
                self.require(&input.id)?.kill()?;
                Ok(json!({ "accepted": true }))
            }
            "process.v1.retire" => {
                self.retire()?;
                Ok(json!({ "retired": true }))
            }
            _ => Err(RpcError::new("rpc.methodNotFound", &request.method)),
        }
    }

    fn handle(&self, mut channel: LocalIpcStream) -> Result<(), String> {
        let Some(frame) = codec::read_frame(&mut channel)? else {
            return Ok(());
        };
        let request = match codec::decode_request_frame(&frame) {
            Ok(request) => request,
            Err(error) => {
                return codec::write_response(
                    &mut channel,
                    &RpcResponse::failure(error.id, error.error),
                );
            }
        };
        let result = self.dispatch(&request);
        let retired = request.method == "process.v1.retire" && result.is_ok();
        let response = match result {
            Ok(value) => RpcResponse::success(request.id, value),
            Err(error) => RpcResponse::failure(request.id, error),
        };
        let written = codec::write_response(&mut channel, &response);
        // Even if the requester disconnects after retirement, the host must
        // complete the lifecycle operation instead of remaining inaccessible.
        if retired {
            self.stopped.store(true, Ordering::Release);
        }
        written
    }
}

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
    let _lock = InstanceLock::acquire_path(&paths.state_dir.join("process-host.lock"), true)?
        .ok_or_else(|| "process host already owns this instance".to_string())?;
    let endpoint = endpoint(&endpoints);
    crate::daemon::process::remove_ipc_endpoint_if_exists(&endpoint)?;
    let listener = LocalIpcListener::bind(&endpoint).map_err(|error| error.to_string())?;
    let _endpoint = EndpointGuard(endpoint.clone());
    ensure_file_mode(&endpoint, 0o600)?;
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;

    let host = Arc::new(Host {
        registry: Mutex::new(Registry::default()),
        shell: ShellRuntime::detect().map_err(|error| error.message)?,
        execution: ExecutionConfig::from_env()?,
        policy: build_security_policy(crate::daemon::process::read_security_mode_from_env()),
        instance_root: paths.instance_root,
        stopped: AtomicBool::new(false),
    });
    while !host.stopped.load(Ordering::Acquire) {
        match listener.accept() {
            Ok(channel) => {
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

fn validate_dimensions(cols: u16, rows: u16) -> Result<(), RpcError> {
    if cols == 0 || rows == 0 || cols > 1000 || rows > 1000 {
        return Err(invalid("invalid terminal dimensions"));
    }
    Ok(())
}

fn parse<T: serde::de::DeserializeOwned>(request: &RpcRequest) -> Result<T, RpcError> {
    serde_json::from_value(request.params.clone()).map_err(|error| invalid(error.to_string()))
}

fn serialize(value: impl serde::Serialize) -> Result<Value, RpcError> {
    serde_json::to_value(value)
        .map_err(|error| RpcError::new("process.internal", error.to_string()))
}

fn invalid(message: impl Into<String>) -> RpcError {
    RpcError::new("rpc.invalidParams", message)
}

fn lock_error<T>(_: std::sync::PoisonError<T>) -> RpcError {
    RpcError::new("process.internal", "process registry lock poisoned")
}

fn io_error(error: std::io::Error) -> RpcError {
    RpcError::new("process.ioFailed", error.to_string())
}
