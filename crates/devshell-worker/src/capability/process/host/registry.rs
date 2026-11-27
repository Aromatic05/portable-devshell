use super::super::protocol::{MAX_INPUT_BYTES, SpawnInput};
use super::super::protocol::{invalid, serialize, validate_dimensions};
use super::super::resource::{ManagedProcess, SpawnSpec};
use super::Host;
use crate::capability::rpc::error::RpcError;
use crate::instance::sandbox::path::{
    FilesystemCapability, PathNamespace, normalize_requested_path, parse_requested_path,
    resolve_existing_target,
};
use serde_json::Value;
use std::collections::{BTreeMap, VecDeque};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};
use uuid::Uuid;

const MAX_RESOURCES: usize = 64;

#[derive(Default)]
pub(super) struct Registry {
    pub(super) processes: BTreeMap<String, Arc<ManagedProcess>>,
    pub(super) order: VecDeque<String>,
    retiring: bool,
    // Named references transfer from a creating ToolCall to a committed Wait.
    wait_pins: BTreeMap<String, String>,
}

impl Host {
    pub(super) fn spawn(&self, mut input: SpawnInput) -> Result<(Value, Arc<ManagedProcess>), RpcError> {
        if input.command.trim().is_empty() && !input.interactive {
            return Err(invalid("command is required"));
        }
        if let Some(name) = input.name.as_deref() {
            validate_name(name)?;
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
        if input.interactive && !input.tty {
            return Err(invalid("interactive shell requires tty"));
        }
        if input.persistent && !input.interactive {
            return Err(invalid("persistent process requires interactive shell"));
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
        if !input.prepared_env
            && let Some(execution) = self.execution.as_ref()
        {
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
            // Live persistent terminals stay in "running" state across shell
            // respawns, so they are protected automatically. Once explicitly
            // closed (or permanently failed), their slot becomes reclaimable.
            let Some(index) = registry
                .order
                .iter()
                .position(|id| {
                    let process = &registry.processes[id];
                    // A retained RPC owns an Arc until its caller finishes
                    // observing the task, including across capture pages.
                    Arc::strong_count(process) == 1
                        && !registry.wait_pins.values().any(|task| task == id)
                        && process.descriptor().state != "running"
                })
            else {
                return Err(RpcError::new(
                    "process.resourceLimit",
                    "all process slots are active or retained",
                ));
            };
            let id = registry
                .order
                .remove(index)
                .expect("finished process index");
            registry.processes.remove(&id);
        }
        let id = input
            .id
            .unwrap_or_else(|| format!("process-{}", Uuid::new_v4()));
        if !id
            .strip_prefix("process-")
            .is_some_and(|id| Uuid::parse_str(id).is_ok())
        {
            return Err(invalid("invalid process id"));
        }
        if registry.processes.contains_key(&id) {
            return Err(RpcError::new(
                "process.duplicateId",
                "process id already exists",
            ));
        }
        let process = ManagedProcess::spawn(
            id.clone(),
            SpawnSpec {
                shell: &self.shell,
                command: &input.command,
                cwd: &cwd,
                env: &input.env,
                execution: self.execution.as_ref(),
                dimensions,
                interactive: input.interactive,
                persistent: input.persistent,
                name: input.name,
                stdin: input.stdin,
                keep_stdin: input.keep_stdin,
                workspace: input.workspace.map(|_| workspace),
                timeout_ms: input.timeout_ms,
                capture_root: &self.capture_root,
                capture_budget: Arc::clone(&self.capture_budget),
            },
        )?;
        let descriptor = process.descriptor();
        registry.order.push_back(id.clone());
        registry.processes.insert(id, Arc::clone(&process));
        Ok((serialize(descriptor)?, process))
    }

    pub(super) fn require(&self, id: &str) -> Result<Arc<ManagedProcess>, RpcError> {
        self.registry
            .lock()
            .map_err(lock_error)?
            .processes
            .get(id)
            .cloned()
            .ok_or_else(|| RpcError::new("process.notFound", format!("unknown process {id}")))
    }

    pub(super) fn pin_wait(&self, owner: String, id: String) -> Result<Value, RpcError> {
        let mut registry = self.registry.lock().map_err(lock_error)?;
        if !registry.processes.contains_key(&id) {
            return Err(RpcError::new("process.notFound", format!("unknown process {id}")));
        }
        if registry.wait_pins.get(&owner).is_some_and(|existing| existing != &id) {
            return Err(invalid("wait owner already holds another task"));
        }
        registry.wait_pins.insert(owner, id);
        Ok(serde_json::json!({"retained": true}))
    }

    pub(super) fn confirm_wait(&self, owner: &str, id: &str) -> Result<Value, RpcError> {
        let registry = self.registry.lock().map_err(lock_error)?;
        Ok(serde_json::json!({
            "retained": registry.wait_pins.get(owner).is_some_and(|task| task == id)
        }))
    }

    pub(super) fn reconcile_wait(&self, owners: Vec<String>) -> Result<Value, RpcError> {
        let mut registry = self.registry.lock().map_err(lock_error)?;
        let owners: std::collections::BTreeSet<_> = owners.into_iter().collect();
        registry.wait_pins.retain(|owner, _| owners.contains(owner));
        Ok(serde_json::json!({"reconciled": true}))
    }

    pub(super) fn retire(&self) -> Result<(), RpcError> {
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
}

pub(super) fn lock_error<T>(_: std::sync::PoisonError<T>) -> RpcError {
    RpcError::new("process.internal", "process registry lock poisoned")
}

pub(super) fn io_error(error: std::io::Error) -> RpcError {
    RpcError::new("process.ioFailed", error.to_string())
}

fn validate_name(name: &str) -> Result<(), RpcError> {
    let bytes = name.as_bytes();
    if bytes.is_empty() || bytes.len() > 64 {
        return Err(invalid("invalid process name"));
    }
    if !bytes[0].is_ascii_alphanumeric() {
        return Err(invalid("invalid process name"));
    }
    if !bytes[1..]
        .iter()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    {
        return Err(invalid("invalid process name"));
    }
    Ok(())
}
