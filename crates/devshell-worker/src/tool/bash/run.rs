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
const MAX_TIMEOUT_MS: u64 = 100_000;
const MAX_CAPTURE_BYTES: usize = 16 * 1024 * 1024;
const MAX_STDIN_BYTES: usize = 4 * 1024 * 1024;
// Model-facing MCP projections are smaller than the Worker capture budget.
// Retain the original streams before any protocol-side presentation trimming.
const RECOVERY_OUTPUT_BYTES: usize = 4 * 1024;

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
            "Execute a shell command. waitMs controls how long to wait; a running command returns a task ID. timeoutMs is an optional hard execution deadline. tty allocates a PTY at startup. Use task_read and task_input to continue. Retained output paths can be read with file_read.",
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
                        "command": "Shell command. Run devshell help to discover authorized MCP model CLI commands.",
                        "cwd": "Working directory; bare relative and ./ paths are workspace-relative, absolute paths are also accepted.",
                        "stdin": "Omit to send EOF.",
                        "timeoutMs": "Optional hard execution deadline.", "waitMs": "Wait before returning a running task ID; does not stop the process.", "tty": "Allocate a PTY at startup."
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
        let timeout_ms = params.timeout_ms.unwrap_or(MAX_TIMEOUT_MS);
        if params.wait_ms.is_some_and(|wait| wait > 3_600_000) {
            return Err(ToolError::new(
                "tool.invalidArguments",
                "waitMs cannot exceed 3600000",
            ));
        }
        let max_capture = params
            .max_capture_bytes
            .unwrap_or(DEFAULT_MAX_CAPTURE_BYTES);
        if timeout_ms == 0 || max_capture == 0 {
            return Err(ToolError::new(
                "tool.invalidArguments",
                "timeoutMs and maxCaptureBytes must be positive",
            ));
        }
        if timeout_ms > MAX_TIMEOUT_MS {
            return Err(ToolError::new(
                "tool.invalidArguments",
                "timeoutMs cannot exceed 100000",
            ));
        }
        if max_capture > MAX_CAPTURE_BYTES {
            return Err(ToolError::new(
                "tool.invalidArguments",
                "maxCaptureBytes exceeds the worker limit",
            ));
        }
        if params
            .stdin
            .as_ref()
            .is_some_and(|stdin| stdin.len() > MAX_STDIN_BYTES)
        {
            return Err(ToolError::new(
                "tool.invalidArguments",
                "stdin exceeds the worker limit",
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
            &self.instance, &self.artifacts, &call, params, &task_id, max_capture,
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
