use std::ffi::OsStr;
use std::io::{Write, stderr, stdout};
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::capability::rpc::bridge::send_request;
use crate::capability::rpc::path::protocol_path;
use crate::capability::rpc::request::RpcRequest;
use crate::capability::rpc::response::RpcResponse;
use crate::instance::storage::ensure_dir;
use crate::tool::{ToolCall, ToolCommandEnvironment, ToolCommandEnvironmentProvider};
use crate::transport::endpoint::channel::EndpointPaths;

pub const WORKER_TOOL_ENV: &str = "DEVSHELL_WORKER_TOOL";

pub const BROKER_SOCKET_ENV: &str = "DEVSHELL_MODEL_BROKER_SOCKET";
pub const CTX_ID_ENV: &str = "DEVSHELL_MODEL_CTX_ID";
pub const PARENT_CALL_ID_ENV: &str = "DEVSHELL_MODEL_PARENT_CALL_ID";
pub const TASK_ID_ENV: &str = "DEVSHELL_MODEL_TASK_ID";
pub const WORKSPACE_ENV: &str = "DEVSHELL_MODEL_WORKSPACE";

#[derive(Clone, Debug)]
pub struct ModelDevshellShim {
    bin_dir: PathBuf,
    socket_file: PathBuf,
}

impl ModelDevshellShim {
    pub fn prepare(socket_paths: &EndpointPaths) -> Result<Self, String> {
        let bin_dir = socket_paths
            .instance_runtime_dir
            .join("model-cli")
            .join("bin");
        ensure_dir(&bin_dir, 0o700)?;
        let executable = std::env::current_exe()
            .map_err(|error| format!("failed to resolve Worker executable: {error}"))?;
        let shim = bin_dir.join(shim_file_name());
        replace_link(&executable, &shim)?;
        Ok(Self {
            bin_dir,
            socket_file: socket_paths.socket_file.clone(),
        })
    }

    pub fn environment(
        &self,
        call: &ToolCall,
        task_id: Option<&str>,
        requested_path: Option<&str>,
    ) -> Option<ToolCommandEnvironment> {
        if call.source.as_deref() != Some("mcp") {
            return Some(ToolCommandEnvironment::new(
                vec![(WORKER_TOOL_ENV, "1".to_string())],
                Vec::new(),
            ));
        }
        let inherited = requested_path
            .map(ToOwned::to_owned)
            .or_else(|| std::env::var("PATH").ok())
            .unwrap_or_default();
        let shim_path = self.bin_dir.to_string_lossy();
        let path = if inherited.is_empty() {
            shim_path.into_owned()
        } else {
            format!("{}{}{}", shim_path, path_separator(), inherited)
        };
        Some(model_command_environment(
            self.socket_file.to_string_lossy().into_owned(),
            call.ctx_id.clone(),
            call.operation_id.clone(),
            path,
            task_id,
            protocol_path(&call.workspace),
        ))
    }
}

impl ToolCommandEnvironmentProvider for ModelDevshellShim {
    fn environment(
        &self,
        call: &ToolCall,
        task_id: Option<&str>,
        requested_path: Option<&str>,
    ) -> Option<ToolCommandEnvironment> {
        ModelDevshellShim::environment(self, call, task_id, requested_path)
    }
}

fn model_command_environment(
    broker_socket: String,
    ctx_id: String,
    parent_call_id: String,
    path: String,
    task_id: Option<&str>,
    workspace: String,
) -> ToolCommandEnvironment {
    let mut values = vec![
        (WORKER_TOOL_ENV, "1".to_string()),
        (BROKER_SOCKET_ENV, broker_socket),
        (CTX_ID_ENV, ctx_id),
        (PARENT_CALL_ID_ENV, parent_call_id),
        (WORKSPACE_ENV, workspace),
        ("PATH", path),
    ];
    let unset = if let Some(task_id) = task_id {
        values.push((TASK_ID_ENV, task_id.to_string()));
        Vec::new()
    } else {
        vec![TASK_ID_ENV]
    };
    ToolCommandEnvironment::new(values, unset)
}

pub fn try_run_shim() -> Option<Result<i32, String>> {
    let argv0 = std::env::args_os().next()?;
    if !is_shim_argv0(&argv0) {
        return None;
    }
    Some(run_shim())
}

fn run_shim() -> Result<i32, String> {
    let socket_file = required_env(BROKER_SOCKET_ENV)?;
    let ctx_id = required_env(CTX_ID_ENV)?;
    let parent_call_id = required_env(PARENT_CALL_ID_ENV)?;
    let workspace = required_env(WORKSPACE_ENV)?;
    let cwd = std::env::current_dir()
        .map_err(|error| format!("failed to read current directory: {error}"))?
        .to_string_lossy()
        .into_owned();
    let mut argv = std::env::args().skip(1).collect::<Vec<_>>();
    if argv.is_empty() {
        argv.push("--help".to_string());
    }
    let task_id = std::env::var(TASK_ID_ENV)
        .ok()
        .filter(|value| !value.is_empty());
    let open = send_request(
        Path::new(&socket_file),
        &RpcRequest::request(
            "devshell-open",
            "devshell.command.open",
            serde_json::json!({
                "argv": argv,
                "ctxId": ctx_id,
                "cwd": cwd,
                "parentCallId": parent_call_id,
                "taskId": task_id,
                "workspace": workspace,
            }),
        ),
    )?;
    let open: OpenResult = response_result(open)?;
    let result = run_open_session(Path::new(&socket_file), &open.session_id);
    if result.is_err() {
        best_effort_close(Path::new(&socket_file), &open.session_id);
    }
    result
}

fn run_open_session(socket_file: &Path, session_id: &str) -> Result<i32, String> {
    let mut sequence = 0_u64;
    loop {
        sequence += 1;
        let read = send_request(
            socket_file,
            &RpcRequest::request(
                format!("devshell-read-{sequence}"),
                "devshell.command.read",
                serde_json::json!({ "sessionId": session_id }),
            ),
        )?;
        let read: ReadResult = response_result(read)?;
        for event in read.events {
            match event.stream.as_str() {
                "stdout" => {
                    let mut output = stdout().lock();
                    output
                        .write_all(event.data.as_bytes())
                        .and_then(|()| output.flush())
                        .map_err(|error| format!("failed to write stdout: {error}"))?;
                }
                "stderr" => {
                    let mut output = stderr().lock();
                    output
                        .write_all(event.data.as_bytes())
                        .and_then(|()| output.flush())
                        .map_err(|error| format!("failed to write stderr: {error}"))?;
                }
                stream => return Err(format!("invalid devshell output stream: {stream}")),
            }
        }
        if let Some(terminal) = read.terminal {
            if let Some(error) = terminal.error.filter(|value| !value.is_empty()) {
                let mut output = stderr().lock();
                writeln!(output, "{error}")
                    .map_err(|write_error| format!("failed to write stderr: {write_error}"))?;
            }
            return Ok(terminal.exit_code);
        }
    }
}

fn best_effort_close(socket_file: &Path, session_id: &str) {
    let _ = send_request(
        socket_file,
        &RpcRequest::request(
            "devshell-close",
            "devshell.command.close",
            serde_json::json!({ "sessionId": session_id }),
        ),
    );
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenResult {
    session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadResult {
    events: Vec<OutputEvent>,
    terminal: Option<Terminal>,
}

#[derive(Debug, Deserialize)]
struct OutputEvent {
    stream: String,
    data: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Terminal {
    exit_code: i32,
    error: Option<String>,
}

fn response_result<T: for<'de> Deserialize<'de>>(response: RpcResponse) -> Result<T, String> {
    if !response.ok {
        let error = response
            .error
            .map(|error| format!("{}: {}", error.code, error.message))
            .unwrap_or_else(|| "Worker rejected model devshell command".to_string());
        return Err(error);
    }
    serde_json::from_value(
        response
            .result
            .ok_or_else(|| "Worker returned an empty model devshell response".to_string())?,
    )
    .map_err(|error| format!("invalid model devshell response: {error}"))
}

fn required_env(name: &str) -> Result<String, String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("model devshell environment is missing {name}"))
}

fn is_shim_argv0(argv0: &OsStr) -> bool {
    Path::new(argv0)
        .file_stem()
        .is_some_and(|name| name == "devshell")
}

#[cfg(unix)]
fn replace_link(executable: &Path, shim: &Path) -> Result<(), String> {
    use std::os::unix::fs::symlink;

    let _ = std::fs::remove_file(shim);
    symlink(executable, shim).map_err(|error| {
        format!(
            "failed to create model devshell shim {}: {error}",
            shim.display()
        )
    })
}

#[cfg(windows)]
fn replace_link(executable: &Path, shim: &Path) -> Result<(), String> {
    let _ = std::fs::remove_file(shim);
    std::fs::hard_link(executable, shim)
        .or_else(|_| std::fs::copy(executable, shim).map(|_| ()))
        .map_err(|error| {
            format!(
                "failed to create model devshell shim {}: {error}",
                shim.display()
            )
        })
}

#[cfg(windows)]
fn shim_file_name() -> &'static str {
    "devshell.exe"
}

#[cfg(not(windows))]
fn shim_file_name() -> &'static str {
    "devshell"
}

#[cfg(windows)]
fn path_separator() -> char {
    ';'
}

#[cfg(not(windows))]
fn path_separator() -> char {
    ':'
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::{
        BROKER_SOCKET_ENV, CTX_ID_ENV, PARENT_CALL_ID_ENV, TASK_ID_ENV, WORKSPACE_ENV,
        model_command_environment,
    };

    #[cfg(unix)]
    #[test]
    fn cli_and_mcp_worker_shells_reject_installer_before_any_work() {
        use crate::instance::sandbox::policy::DisabledSecurityPolicy;
        use crate::tool::{
            ToolCall, ToolCancellation, ToolProcessGuard, ToolProcessRegistry, ToolProgressEmitter,
        };
        use std::sync::Arc;
        struct NoProcesses;
        impl ToolProcessRegistry for NoProcesses {
            fn register(self: Arc<Self>, _: i32) -> Result<Box<dyn ToolProcessGuard>, String> {
                unreachable!()
            }
        }
        let root = crate::testing::temp_dir();
        let shim = super::ModelDevshellShim {
            bin_dir: root.path().join("bin"),
            socket_file: root.path().join("worker.sock"),
        };
        for source in [None, Some("cli"), Some("mcp")] {
            let call = ToolCall {
                workspace: root.path().to_path_buf(),
                params: serde_json::Value::Null,
                ctx_id: "ctx".into(),
                operation_id: "call".into(),
                source: source.map(str::to_string),
                policy: Arc::new(DisabledSecurityPolicy),
                process_registry: Arc::new(NoProcesses),
                cancellation: ToolCancellation::default(),
                progress: ToolProgressEmitter::new(|_| {}),
            };
            let environment = shim.environment(&call, None, None).unwrap();
            let mut env = BTreeMap::from([(super::WORKER_TOOL_ENV.to_string(), None)]);
            environment.inject(&mut env);
            assert_eq!(env[super::WORKER_TOOL_ENV].as_deref(), Some("1"));
            let output = std::process::Command::new("/bin/sh")
                .arg("-c")
                .arg(include_str!("../../../../../../scripts/install-release.sh"))
                .env_clear()
                .envs(environment.pairs())
                .output()
                .unwrap();
            assert_eq!(output.status.code(), Some(1));
            assert!(String::from_utf8_lossy(&output.stderr).contains("独立终端或 SSH"));
            assert!(output.stdout.is_empty());
        }
    }

    #[test]
    fn authoritative_model_environment_overrides_caller_values() {
        let model = model_command_environment(
            "/run/worker.sock".to_string(),
            "ctx-real".to_string(),
            "call-real".to_string(),
            "/run/model-bin:/usr/bin".to_string(),
            Some("task-real"),
            "/repo".to_string(),
        );
        let mut env = BTreeMap::from([
            (CTX_ID_ENV.to_string(), Some("ctx-spoofed".to_string())),
            ("PATH".to_string(), Some("/malicious".to_string())),
        ]);
        model.inject(&mut env);
        assert_eq!(env[CTX_ID_ENV].as_deref(), Some("ctx-real"));
        assert_eq!(env[PARENT_CALL_ID_ENV].as_deref(), Some("call-real"));
        assert_eq!(env[TASK_ID_ENV].as_deref(), Some("task-real"));
        assert_eq!(env[WORKSPACE_ENV].as_deref(), Some("/repo"));
        assert_eq!(env[BROKER_SOCKET_ENV].as_deref(), Some("/run/worker.sock"));
        assert_eq!(env["PATH"].as_deref(), Some("/run/model-bin:/usr/bin"));
    }

    #[test]
    fn bash_model_environment_explicitly_clears_inherited_tmux_task_binding() {
        let model = model_command_environment(
            "/run/worker.sock".to_string(),
            "ctx-real".to_string(),
            "call-real".to_string(),
            "/run/model-bin:/usr/bin".to_string(),
            None,
            "/repo".to_string(),
        );
        let mut env = BTreeMap::from([(
            TASK_ID_ENV.to_string(),
            Some("task-inherited-from-outer-tmux".to_string()),
        )]);

        model.inject(&mut env);

        assert_eq!(env.get(TASK_ID_ENV), Some(&None));
    }
}
