use super::capture::BashProgress;
use super::model::{BashRunOutput, TaskCursor};
use super::output::collect;
use super::scope::{check_spawn_cancelled, confirmed_spawn_error, error, spawn, wait_for};
use crate::capability::artifact::store::ArtifactStore;
use crate::capability::process::client::ProcessHostClient;
use crate::instance::InstanceName;
use crate::tool::bash::model::BashRunParams;
use crate::tool::{ToolCall, ToolError};
use serde_json::json;
use std::sync::Arc;
use std::time::Instant;

const DEFAULT_WAIT_MS: u64 = 10_000;
const DEFAULT_PTY_COLS: u16 = 120;
const DEFAULT_PTY_ROWS: u16 = 36;

pub(crate) fn run(
    instance: &InstanceName,
    artifacts: &ArtifactStore,
    call: &ToolCall,
    params: BashRunParams,
    id: &str,
    max_capture: usize,
) -> Result<BashRunOutput, ToolError> {
    let client = ProcessHostClient::ensure(instance).map_err(error)?;
    let started = Instant::now();
    let mut spawn_payload = json!({
        "id": id,
        "command": params.command,
        "cwd": params.cwd.unwrap_or_else(|| "./".into()),
        "workspace": (!call.stateless).then_some(&call.workspace),
        "env": params.env,
        "preparedEnv": true,
        "tty": params.pty,
        "persistent": false,
        "interactive": false,
    });
    if params.pty
        && let Some(object) = spawn_payload.as_object_mut()
    {
        object.insert("cols".into(), json!(DEFAULT_PTY_COLS));
        object.insert("rows".into(), json!(DEFAULT_PTY_ROWS));
    }
    let mut descriptor = spawn(&client, call, id, spawn_payload)?;
    let wait = params.wait_ms.unwrap_or(DEFAULT_WAIT_MS);
    let progress = Arc::new(BashProgress::new(started, call.progress()));
    progress.emit_initial();
    let waited = wait_for(
        &client,
        call,
        id,
        &mut descriptor,
        0,
        None,
        wait,
        false,
        0,
        Some(&progress),
    );
    check_spawn_cancelled(&client, call, id, &descriptor)
        .and(waited)
        .map_err(|failure| confirmed_spawn_error(failure, id))?;
    let collected = collect(
        &client,
        artifacts,
        id,
        descriptor.clone(),
        TaskCursor::default(),
        max_capture,
        started,
        progress,
    );
    let mut result = check_spawn_cancelled(&client, call, id, &descriptor)
        .and(collected)
        .map_err(|failure| confirmed_spawn_error(failure, id))?;
    result.wait_reason = Some(
        if result.termination == super::model::BashTermination::Running {
            "timeout"
        } else {
            "terminal"
        }
        .into(),
    );
    result.wait_ms = Some(wait);
    Ok(result)
}
