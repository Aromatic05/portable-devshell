use super::model::{BashRunOutput, TaskCursor};
use super::output::collect;
use super::scope::{error, rpc, wait_for};
use crate::capability::artifact::store::ArtifactStore;
use crate::capability::process::client::ProcessHostClient;
use crate::instance::InstanceName;
use crate::tool::bash::model::BashRunParams;
use crate::tool::{ToolCall, ToolError};
use serde_json::json;
use std::time::Instant;

const DEFAULT_WAIT_MS: u64 = 10_000;

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
    let mut result = collect(
        &client,
        artifacts,
        id,
        descriptor,
        TaskCursor::default(),
        max_capture,
        started,
        call,
    )?;
    result.wait_reason = Some(if result.termination == super::model::BashTermination::Running { "timeout" } else { "terminal" }.into());
    result.wait_ms = Some(wait);
    Ok(result)
}
