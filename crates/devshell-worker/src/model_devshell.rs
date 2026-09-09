use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::io::{Write, stderr, stdout};
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::rpc::bridge::send_request;
use crate::rpc::request::RpcRequest;
use crate::rpc::response::RpcResponse;
use crate::socket::SocketPaths;
use crate::storage::permissions::ensure_dir;
use crate::tools::ToolCall;

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

#[derive(Clone, Debug)]
pub struct ModelDevshellEnvironment {
    pub broker_socket: String,
    pub ctx_id: String,
    pub parent_call_id: String,
    pub path: String,
    pub task_id: Option<String>,
    pub workspace: String,
}

impl ModelDevshellShim {
    pub fn prepare(socket_paths: &SocketPaths) -> Result<Self, String> {
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
    ) -> Option<ModelDevshellEnvironment> {
        if call.source.as_deref() != Some("mcp") {
            return None;
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
        Some(ModelDevshellEnvironment {
            broker_socket: self.socket_file.to_string_lossy().into_owned(),
            ctx_id: call.ctx_id.clone(),
            parent_call_id: call.operation_id.clone(),
            path,
            task_id: task_id.map(ToOwned::to_owned),
            workspace: call.workspace.to_string_lossy().into_owned(),
        })
    }
}

impl ModelDevshellEnvironment {
    pub fn inject(&self, env: &mut BTreeMap<String, Option<String>>) {
        env.insert(
            BROKER_SOCKET_ENV.to_string(),
            Some(self.broker_socket.clone()),
        );
        env.insert(CTX_ID_ENV.to_string(), Some(self.ctx_id.clone()));
        env.insert(
            PARENT_CALL_ID_ENV.to_string(),
            Some(self.parent_call_id.clone()),
        );
        env.insert(WORKSPACE_ENV.to_string(), Some(self.workspace.clone()));
        match &self.task_id {
            Some(task_id) => {
                env.insert(TASK_ID_ENV.to_string(), Some(task_id.clone()));
            }
            None => {
                env.remove(TASK_ID_ENV);
            }
        }
        env.insert("PATH".to_string(), Some(self.path.clone()));
    }

    pub fn pairs(&self) -> Vec<(&'static str, &str)> {
        let mut pairs = vec![
            (BROKER_SOCKET_ENV, self.broker_socket.as_str()),
            (CTX_ID_ENV, self.ctx_id.as_str()),
            (PARENT_CALL_ID_ENV, self.parent_call_id.as_str()),
            (WORKSPACE_ENV, self.workspace.as_str()),
            ("PATH", self.path.as_str()),
        ];
        if let Some(task_id) = self.task_id.as_deref() {
            pairs.push((TASK_ID_ENV, task_id));
        }
        pairs
    }
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
        BROKER_SOCKET_ENV, CTX_ID_ENV, ModelDevshellEnvironment, PARENT_CALL_ID_ENV, TASK_ID_ENV,
        WORKSPACE_ENV,
    };

    #[test]
    fn authoritative_model_environment_overrides_caller_values() {
        let model = ModelDevshellEnvironment {
            broker_socket: "/run/worker.sock".to_string(),
            ctx_id: "ctx-real".to_string(),
            parent_call_id: "call-real".to_string(),
            path: "/run/model-bin:/usr/bin".to_string(),
            task_id: Some("task-real".to_string()),
            workspace: "/repo".to_string(),
        };
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
}
