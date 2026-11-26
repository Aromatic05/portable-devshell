use std::sync::Arc;

use crate::capability::artifact::store::ArtifactStore;
use crate::instance::sandbox::path::{
    FilesystemCapability, PathNamespace, ResolvedPath, resolve_existing_target,
};
use crate::tool::ToolCommandEnvironmentProvider;
use crate::tool::bash::bash_run_name;
use crate::tool::bash::model::{BashRunOutput, BashRunParams, BashTermination};
#[cfg(unix)]
use crate::tool::file::observation::{CommandReadPlan, MAX_OUTPUT_BYTES};
use crate::tool::file::{FileToolState, requested_path};
use crate::tool::{
    ToolCall, ToolCapability, ToolCatalogEntry, ToolError, ToolHandler, ToolName,
};

const DEFAULT_MAX_CAPTURE_BYTES: usize = 4 * 1024 * 1024;
const MAX_WAIT_MS: u64 = 3_600_000;
// Model-facing MCP projections are smaller than the Worker capture budget.
// Retain the original streams before any protocol-side presentation trimming.

pub struct BashRunTool {
    name: ToolName,
    artifacts: Arc<ArtifactStore>,
    model_devshell: Arc<dyn ToolCommandEnvironmentProvider>,
    #[cfg_attr(windows, allow(dead_code))]
    files: Arc<FileToolState>,
    instance: crate::instance::InstanceName,
}
impl BashRunTool {
    pub fn new(
        artifacts: Arc<ArtifactStore>,
        model_devshell: Arc<dyn ToolCommandEnvironmentProvider>,
        files: Arc<FileToolState>,
        instance: crate::instance::InstanceName,
    ) -> Result<Self, ToolError> {
        Ok(Self {
            name: bash_run_name(),
            artifacts,
            model_devshell,
            files,
            instance,
        })
    }
}
impl ToolHandler for BashRunTool {
    fn name(&self) -> &ToolName {
        &self.name
    }
    fn catalog_entry(&self) -> ToolCatalogEntry {
        crate::tool::contract::catalog_entry_with_meta::<BashRunParams, BashRunOutput>(
            &self.name,
            "Execute a shell command (non-login shell). waitMs controls how long to wait (default 10000ms); a still-running command returns a task ID and cursor. Do not background long-lived services with '&' (process groups are cleaned up on shell exit); instead run them in the foreground with a short waitMs and stop them via task_manage(command=\"close\"). Set pty=true to allocate a PTY for interactive input. Use task_input to read/poll output or send input, task_inspect to inspect a PTY screen, and task_manage to list, create persistent terminals, or close tasks. Retained output paths can be read with file_read.",
            [ToolCapability::Execute],
            serde_json::json!({
                "devshell": { "mcp": {
                    "annotations": {
                        "destructiveHint": true,
                        "idempotentHint": false,
                        "openWorldHint": true,
                        "readOnlyHint": false
                    },
                    "inputHints": {
                        "command": "Shell command. Run in foreground with a short waitMs (not '&') for background services. Run devshell help to discover authorized MCP model CLI commands.",
                        "cwd": "Working directory; bare relative and ./ paths are workspace-relative, absolute paths are also accepted.",
                        "env": "Environment variable overrides; null removes an inherited variable.",
                        "pty": "Allocate a PTY at startup for interactive commands; required to send input via task_input.",
                        "waitMs": "Milliseconds to wait before returning a running task ID (default 10000, max 3600000); does not stop the process."
                    },
                    "title": "Run shell command"
                }}
            }),
        )
    }
    fn call(&self, call: ToolCall) -> Result<serde_json::Value, ToolError> {
        call.check_cancelled()?;
        let mut params: BashRunParams = call.parse_params()?;
        if params.command.trim().is_empty() {
            return Err(ToolError::new(
                "bash.invalidCommand",
                "command cannot be empty",
            ));
        }
        if params.wait_ms.is_some_and(|wait| wait > MAX_WAIT_MS) {
            return Err(ToolError::new(
                "tool.invalidArguments",
                "waitMs cannot exceed 3600000",
            ));
        }
        call.policy
            .check_capability(FilesystemCapability::ProcessExecute)
            .map_err(ToolError::from)?;
        let cwd = resolve_cwd(&call, params.cwd.as_deref())?;
        #[cfg(unix)]
        let read_plan = if call.stateless {
            None
        } else {
            CommandReadPlan::analyze(&params.command, &cwd.canonical)
        };
        let execution = crate::capability::execution::ExecutionConfig::from_env()
            .map_err(|error| ToolError::new("execution.invalidConfig", error))?;
        if let Some(config) = execution.as_ref() {
            let mut effective_env = config
                .environment(cwd.access_path())
                .map_err(|error| ToolError::new("execution.providerFailed", error))?;
            for (key, value) in std::mem::take(&mut params.env) {
                effective_env.insert(key, value);
            }
            params.env = effective_env;
        }
        let task_id = format!("process-{}", uuid::Uuid::new_v4());
        let requested_path = match params.env.get("PATH") {
            Some(Some(value)) => Some(value.as_str()),
            Some(None) => Some(""),
            None => None,
        };
        if !call.stateless
            && let Some(environment) =
                self.model_devshell
                    .environment(&call, Some(&task_id), requested_path)
        {
            environment.inject(&mut params.env);
        }
        let result = crate::tool::process::run::run(
            &self.instance,
            &self.artifacts,
            &call,
            params,
            &task_id,
            DEFAULT_MAX_CAPTURE_BYTES,
        )?;
        #[cfg(unix)]
        if result.termination == BashTermination::Exited
            && !result.stdout_truncated
            && !result.stderr_truncated
            && result.stdout_bytes.saturating_add(result.stderr_bytes) <= MAX_OUTPUT_BYTES
            && let Some(plan) = read_plan
        {
            plan.observe(&call, &self.files, &result.stdout);
        }
        crate::tool::contract::serialize(result)
    }
}

fn resolve_cwd(call: &ToolCall, raw: Option<&str>) -> Result<ResolvedPath, ToolError> {
    if call.stateless && raw.is_none() {
        return Err(ToolError::new(
            "bash.invalidCwd",
            "cwd is required in stateless mode",
        ));
    }
    let requested = requested_path(call, raw.unwrap_or("./"))
        .map_err(|error| ToolError::new("bash.invalidCwd", error.message))?;
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
    call.policy
        .check_capability(read)
        .and_then(|_| call.policy.check_capability(write))
        .map_err(ToolError::from)?;
    let resolved = resolve_existing_target(&call.workspace, &requested)
        .map_err(|error| ToolError::new("bash.invalidCwd", error.message))?;
    if !resolved
        .metadata()
        .map_err(|error| ToolError::new("bash.invalidCwd", error.to_string()))?
        .is_dir()
    {
        return Err(ToolError::new("bash.invalidCwd", "cwd is not a directory"));
    }
    Ok(resolved)
}
