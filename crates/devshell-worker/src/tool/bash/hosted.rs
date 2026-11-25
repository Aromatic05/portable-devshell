//! Model-facing adapter for the independent process resource owner.
use std::io::{self, Read};
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::time::{Duration, Instant};

use base64::{Engine, engine::general_purpose::STANDARD};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::capability::artifact::{
    result_path::tool_result_path, store::ArtifactStore, types::ArtifactStream,
};
use crate::capability::process::client::ProcessHostClient;
use crate::instance::sandbox::path::FilesystemCapability;
use crate::instance::{InstanceName, storage::InstancePaths};
use crate::tool::contract::{catalog_entry, serialize};
use crate::tool::{
    ToolCall, ToolCapability, ToolCatalogEntry, ToolError, ToolHandler, ToolName, ToolRegistry,
};
use crate::transport::endpoint::channel::EndpointPaths;

use super::model::{BashRunOutput, BashRunParams, BashTermination};
use super::run::{
    BashProgress, BashProgressStream, StreamOutput, begin_artifact, enforce_inline_rpc_budget,
    persist_artifact, render_inline_stream, spawn_reader,
};

const RPC_TIMEOUT: Duration = Duration::from_secs(5);
const DEFAULT_WAIT_MS: u64 = 10_000;
const DEFAULT_CAPTURE: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskCursor {
    #[serde(default)]
    pub seq: u64,
    #[serde(default)]
    pub stdout: usize,
    #[serde(default)]
    pub stderr: usize,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TaskDescriptor {
    pub id: String,
    pub status: String,
    pub tty: bool,
}

fn error(message: impl Into<String>) -> ToolError {
    ToolError::new("process.hostFailed", message)
}

fn rpc(client: &ProcessHostClient, method: &str, value: Value) -> Result<Value, ToolError> {
    client.call(method, value, RPC_TIMEOUT).map_err(error)
}

fn connect(instance: &InstanceName) -> Result<ProcessHostClient, ToolError> {
    let paths = InstancePaths::resolve(instance).map_err(error)?;
    let endpoints = EndpointPaths::resolve(instance).map_err(error)?;
    ProcessHostClient::connect(instance, &paths, &endpoints)
        .map_err(error)?
        .ok_or_else(|| error("no Process Host for this instance"))
}

fn require_read(call: &ToolCall) -> Result<(), ToolError> {
    call.policy
        .check_capability(if call.stateless {
            FilesystemCapability::AbsoluteRead
        } else {
            FilesystemCapability::WorkspaceRead
        })
        .map_err(ToolError::from)
}

fn scoped(call: &ToolCall, descriptor: &Value) -> Result<bool, ToolError> {
    if call.stateless {
        call.policy
            .check_capability(FilesystemCapability::AbsoluteRead)
            .map_err(ToolError::from)?;
        Ok(descriptor["workspace"].is_null())
    } else {
        call.policy
            .check_capability(FilesystemCapability::WorkspaceRead)
            .map_err(ToolError::from)?;
        let workspace = descriptor["workspace"]
            .as_str()
            .map(std::path::PathBuf::from);
        Ok(workspace.as_ref() == Some(&call.workspace))
    }
}

fn require(client: &ProcessHostClient, call: &ToolCall, id: &str) -> Result<Value, ToolError> {
    let descriptor = rpc(client, "process.v1.describe", json!({"id": id}))?;
    if !scoped(call, &descriptor)? {
        return Err(ToolError::new(
            "process.notFound",
            "task does not belong to this execution scope",
        ));
    }
    Ok(descriptor)
}

fn require_execute(call: &ToolCall) -> Result<(), ToolError> {
    call.policy
        .check_capability(FilesystemCapability::ProcessExecute)
        .map_err(ToolError::from)?;
    let capability = if call.stateless {
        FilesystemCapability::AbsoluteWrite
    } else {
        FilesystemCapability::WorkspaceWrite
    };
    call.policy
        .check_capability(capability)
        .map_err(ToolError::from)
}

pub(super) fn run(
    instance: &InstanceName,
    artifacts: &ArtifactStore,
    call: &ToolCall,
    params: BashRunParams,
    id: &str,
    max_capture: usize,
) -> Result<BashRunOutput, ToolError> {
    let client = ProcessHostClient::ensure(instance).map_err(error)?;
    let started = Instant::now();
    let descriptor = rpc(
        &client,
        "process.v1.spawn",
        json!({
            "id": id,
            "command": params.command,
            "cwd": params.cwd.unwrap_or_else(|| "./".into()),
            "workspace": (!call.stateless).then_some(&call.workspace),
            "env": params.env,
            "preparedEnv": true,
            "tty": params.tty,
            "keepStdin": params.keep_stdin,
            "stdin": params.stdin,
            "timeoutMs": params.timeout_ms,
        }),
    )?;
    let wait = params
        .wait_ms
        .unwrap_or_else(|| params.timeout_ms.unwrap_or(DEFAULT_WAIT_MS));
    let wait = if params.wait_ms.is_none() && params.timeout_ms.is_some() {
        wait.saturating_add(1500)
    } else {
        wait
    };
    let descriptor = wait_for(&client, call, id, descriptor, 0, wait, false, true)?;
    collect(
        &client,
        artifacts,
        id,
        descriptor,
        TaskCursor::default(),
        max_capture,
        started,
        call,
    )
}

fn wait_for(
    client: &ProcessHostClient,
    call: &ToolCall,
    id: &str,
    mut descriptor: Value,
    mut seq: u64,
    wait_ms: u64,
    until_output: bool,
    kill_on_cancel: bool,
) -> Result<Value, ToolError> {
    let deadline = Instant::now() + Duration::from_millis(wait_ms);
    let original_seq = seq;
    loop {
        if call.cancellation.is_cancelled() {
            if kill_on_cancel {
                rpc(client, "process.v1.kill", json!({"id": id}))?;
            }
            return call.check_cancelled().map(|_| descriptor);
        }
        if descriptor["state"] != "running" || Instant::now() >= deadline {
            return Ok(descriptor);
        }
        if until_output && descriptor["latestSeq"].as_u64().unwrap_or(0) > original_seq {
            return Ok(descriptor);
        }
        let remaining = deadline
            .saturating_duration_since(Instant::now())
            .as_millis() as u64;
        let output = rpc(
            client,
            "process.v1.read",
            json!({
                "id": id, "fromSeq": seq, "waitMs": remaining.min(250)
            }),
        )?;
        descriptor = output["process"].clone();
        seq = descriptor["latestSeq"].as_u64().unwrap_or(seq);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CapturePage {
    source_bytes: usize,
    stored_bytes: usize,
    truncated: bool,
    data_base64: String,
}

struct CaptureReader {
    client: ProcessHostClient,
    id: String,
    channel: &'static str,
    offset: usize,
    end: usize,
    pending: std::io::Cursor<Vec<u8>>,
}

impl Read for CaptureReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        let count = self.pending.read(buffer)?;
        if count != 0 {
            return Ok(count);
        }
        if self.offset >= self.end {
            return Ok(0);
        }
        let page = capture(
            &self.client,
            &self.id,
            self.channel,
            self.offset,
            (self.end - self.offset).min(256 * 1024),
        )
        .map_err(|error| io::Error::other(error.message))?;
        let bytes = STANDARD
            .decode(page.data_base64)
            .map_err(io::Error::other)?;
        if bytes.is_empty() {
            return Err(io::Error::other(
                "capture ended before its published boundary",
            ));
        }
        self.offset += bytes.len();
        self.pending = io::Cursor::new(bytes);
        self.pending.read(buffer)
    }
}

fn capture(
    client: &ProcessHostClient,
    id: &str,
    channel: &'static str,
    offset: usize,
    limit: usize,
) -> Result<CapturePage, ToolError> {
    serde_json::from_value(rpc(
        client,
        "process.v1.capture",
        json!({
            "id": id, "channel": channel, "offset": offset, "limit": limit,
        }),
    )?)
    .map_err(|error_value| error(error_value.to_string()))
}

fn collect_stream(
    client: &ProcessHostClient,
    artifacts: &ArtifactStore,
    id: &str,
    channel: &'static str,
    offset: usize,
    max: usize,
    progress: Arc<BashProgress>,
    stream: ArtifactStream,
    progress_stream: BashProgressStream,
) -> Result<(StreamOutput, usize, usize), ToolError> {
    let metadata = capture(client, id, channel, offset, 0)?;
    if offset > metadata.stored_bytes {
        return Err(error("output cursor exceeds retained capture"));
    }
    let reader = CaptureReader {
        client: client.clone(),
        id: id.into(),
        channel,
        offset,
        end: metadata.stored_bytes,
        pending: std::io::Cursor::new(Vec::new()),
    };
    let bytes = Arc::new(AtomicUsize::new(0));
    let (draft, warning) = begin_artifact(artifacts, stream);
    let mut output = spawn_reader(
        reader,
        Arc::clone(&bytes),
        max,
        draft,
        warning,
        progress,
        progress_stream,
    )
    .join()
    .map_err(|_| error("capture reader panicked"))??;
    if metadata.truncated {
        output.truncated = true;
        output.artifact_draft = None;
        output.artifact_warning = Some("Process Host capture limit reached".into());
    }
    enforce_inline_rpc_budget(&mut output);
    Ok((
        output,
        metadata.source_bytes.saturating_sub(offset),
        metadata.stored_bytes,
    ))
}

fn collect(
    client: &ProcessHostClient,
    artifacts: &ArtifactStore,
    id: &str,
    descriptor: Value,
    cursor: TaskCursor,
    max: usize,
    started: Instant,
    call: &ToolCall,
) -> Result<BashRunOutput, ToolError> {
    if descriptor["state"] == "failed" {
        return Err(error(
            descriptor["error"].as_str().unwrap_or("process failed"),
        ));
    }
    let progress = Arc::new(BashProgress::new(started, call.progress()));
    progress.emit_initial();
    let (mut stdout, stdout_bytes, stdout_end) = collect_stream(
        client,
        artifacts,
        id,
        "stdout",
        cursor.stdout,
        max,
        Arc::clone(&progress),
        ArtifactStream::Stdout,
        BashProgressStream::Stdout,
    )?;
    let (mut stderr, stderr_bytes, stderr_end) = collect_stream(
        client,
        artifacts,
        id,
        "stderr",
        cursor.stderr,
        max,
        Arc::clone(&progress),
        ArtifactStream::Stderr,
        BashProgressStream::Stderr,
    )?;
    progress.finish();
    let retain = stdout.truncated
        || stderr.truncated
        || stdout.kept.len().saturating_add(stderr.kept.len()) > 4096;
    let retain_stdout = retain && !stdout.kept.is_empty();
    let retain_stderr = retain && !stderr.kept.is_empty();
    let mut warnings = Vec::new();
    let stdout_artifact = persist_artifact(
        artifacts,
        &mut stdout,
        "stdout",
        retain_stdout,
        &mut warnings,
    );
    let stderr_artifact = persist_artifact(
        artifacts,
        &mut stderr,
        "stderr",
        retain_stderr,
        &mut warnings,
    );
    let running = descriptor["state"] == "running";
    let signal = descriptor["exit"]["signal"]
        .as_i64()
        .filter(|signal| *signal != 0)
        .map(|signal| signal as i32);
    let exit_code = descriptor["exit"]["exitCode"]
        .as_i64()
        .filter(|code| *code >= 0)
        .map(|code| code as i32);
    let timed_out = descriptor["timedOut"] == true;
    let termination = if running {
        BashTermination::Running
    } else if timed_out {
        BashTermination::Timeout
    } else if signal.is_some() {
        BashTermination::Signaled
    } else {
        BashTermination::Exited
    };
    let status = if running {
        "running".into()
    } else {
        exit_code
            .map(|code| code.to_string())
            .unwrap_or_else(|| "failed".into())
    };
    Ok(BashRunOutput {
        exit_code: if termination == BashTermination::Exited {
            exit_code
        } else {
            None
        },
        term_signal: signal,
        timed_out: timed_out.then_some(true),
        stdout: render_inline_stream(&stdout),
        stderr: render_inline_stream(&stderr),
        stdout_bytes,
        stderr_bytes,
        stdout_truncated: stdout.truncated,
        stderr_truncated: stderr.truncated,
        stdout_path: stdout_artifact.as_ref().map(tool_result_path),
        stderr_path: stderr_artifact.as_ref().map(tool_result_path),
        stdout_artifact,
        stderr_artifact,
        artifact_warnings: (!warnings.is_empty()).then_some(warnings),
        duration_ms: started.elapsed().as_millis(),
        termination,
        task: Some(TaskDescriptor {
            id: id.into(),
            status,
            tty: descriptor["tty"] == true,
        }),
        cursor: Some(TaskCursor {
            seq: descriptor["latestSeq"].as_u64().unwrap_or(0),
            stdout: stdout_end,
            stderr: stderr_end,
        }),
    })
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadParams {
    task: String,
    #[serde(default)]
    cursor: TaskCursor,
    #[serde(default)]
    #[schemars(range(min = 0, max = 100000))]
    time_ms: u64,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InputParams {
    task: String,
    input: Option<String>,
    #[serde(default)]
    eof: bool,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InspectParams {
    terminal: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(tag = "command", rename_all = "camelCase", deny_unknown_fields)]
enum ManageParams {
    List,
    Close {
        id: String,
    },
    Create {
        cwd: Option<String>,
        shell: Option<String>,
    },
}

struct ProcessTool {
    name: ToolName,
    instance: InstanceName,
    artifacts: Arc<ArtifactStore>,
}

impl ToolHandler for ProcessTool {
    fn name(&self) -> &ToolName {
        &self.name
    }
    fn catalog_entry(&self) -> ToolCatalogEntry {
        match self.name.as_str().as_str() {
            "task_read" => catalog_entry::<ReadParams, BashRunOutput>(
                &self.name,
                "Read task output from an independent cursor; optionally wait for new output. Use returned cursor for the next read.",
                [ToolCapability::Read],
            ),
            "task_input" => catalog_entry::<InputParams, Value>(
                &self.name,
                "Send literal input to a task/terminal or close pipe stdin with eof.",
                [ToolCapability::Execute],
            ),
            "terminal_inspect" => catalog_entry::<InspectParams, Value>(
                &self.name,
                "Inspect the current terminal screen without consuming task output.",
                [ToolCapability::Read],
            ),
            _ => catalog_entry::<ManageParams, Value>(
                &self.name,
                "List, create or close process terminals in the current execution scope.",
                [ToolCapability::Execute],
            ),
        }
    }

    fn call(&self, call: ToolCall) -> Result<Value, ToolError> {
        call.check_cancelled()?;
        match self.name.as_str().as_str() {
            "task_read" => {
                require_read(&call)?;
                let params: ReadParams = call.parse_params()?;
                if params.time_ms > 100000 {
                    return Err(ToolError::new(
                        "tool.invalidArguments",
                        "timeMs cannot exceed 100000",
                    ));
                }
                let client = connect(&self.instance)?;
                let descriptor = require(&client, &call, &params.task)?;
                let started = Instant::now();
                let descriptor = wait_for(
                    &client,
                    &call,
                    &params.task,
                    descriptor,
                    params.cursor.seq,
                    params.time_ms,
                    true,
                    false,
                )?;
                serialize(collect(
                    &client,
                    &self.artifacts,
                    &params.task,
                    descriptor,
                    params.cursor,
                    DEFAULT_CAPTURE,
                    started,
                    &call,
                )?)
            }
            "task_input" => {
                let params: InputParams = call.parse_params()?;
                require_execute(&call)?;
                let client = connect(&self.instance)?;
                require(&client, &call, &params.task)?;
                if let Some(input) = params.input {
                    if input.len() > 4 * 1024 * 1024 {
                        return Err(ToolError::new("tool.invalidArguments", "input too large"));
                    }
                    rpc(
                        &client,
                        "process.v1.input",
                        json!({"id": params.task, "dataBase64": STANDARD.encode(input)}),
                    )?;
                }
                if params.eof {
                    rpc(&client, "process.v1.closeInput", json!({"id": params.task}))?;
                }
                Ok(json!({"task": params.task, "accepted": true}))
            }
            "terminal_inspect" => {
                require_read(&call)?;
                let params: InspectParams = call.parse_params()?;
                let client = connect(&self.instance)?;
                require(&client, &call, &params.terminal)?;
                rpc(
                    &client,
                    "process.v1.inspect",
                    json!({"id": params.terminal}),
                )
            }
            _ => {
                let params: ManageParams = call.parse_params()?;
                match params {
                    ManageParams::List => {
                        require_read(&call)?;
                        let paths = InstancePaths::resolve(&self.instance).map_err(error)?;
                        let endpoints = EndpointPaths::resolve(&self.instance).map_err(error)?;
                        let Some(client) =
                            ProcessHostClient::connect(&self.instance, &paths, &endpoints)
                                .map_err(error)?
                        else {
                            return Ok(json!({"tasks": []}));
                        };
                        let mut tasks = Vec::new();
                        for descriptor in client
                            .list()
                            .map_err(error)?
                            .as_array()
                            .ok_or_else(|| error("invalid resource list"))?
                        {
                            if scoped(&call, descriptor)? {
                                tasks.push(descriptor.clone());
                            }
                        }
                        Ok(json!({"tasks": tasks}))
                    }
                    ManageParams::Close { id } => {
                        require_execute(&call)?;
                        let client = connect(&self.instance)?;
                        require(&client, &call, &id)?;
                        rpc(&client, "process.v1.kill", json!({"id": id}))
                    }
                    ManageParams::Create { cwd, shell } => {
                        require_execute(&call)?;
                        if call.stateless && cwd.is_none() {
                            return Err(ToolError::new(
                                "tool.invalidArguments",
                                "absolute cwd is required in stateless mode",
                            ));
                        }
                        let client = ProcessHostClient::ensure(&self.instance).map_err(error)?;
                        #[cfg(unix)]
                        let default_shell = "exec bash --noprofile --norc -i";
                        #[cfg(windows)]
                        let default_shell = "powershell.exe -NoLogo -NoProfile";
                        rpc(
                            &client,
                            "process.v1.spawn",
                            json!({
                                "command": shell.unwrap_or_else(|| default_shell.into()),
                                "cwd": cwd.unwrap_or_else(|| "./".into()),
                                "workspace": (!call.stateless).then_some(&call.workspace),
                                "tty": true, "keepStdin": true
                            }),
                        )
                    }
                }
            }
        }
    }
}

pub(crate) fn register_tools(
    registry: &mut ToolRegistry,
    instance: &InstanceName,
    artifacts: Arc<ArtifactStore>,
) -> Result<(), ToolError> {
    for name in [
        "task_read",
        "task_input",
        "terminal_inspect",
        "terminal_manage",
    ] {
        registry.register(Arc::new(ProcessTool {
            name: ToolName::parse(name).map_err(error)?,
            instance: instance.clone(),
            artifacts: Arc::clone(&artifacts),
        }))?;
    }
    Ok(())
}
