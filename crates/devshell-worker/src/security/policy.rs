use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::tools::name::ToolName;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SecurityMode {
    Disabled,
    Workspace,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SecurityError {
    pub code: String,
    pub message: String,
    pub details: Option<serde_json::Value>,
}

impl SecurityError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }

    pub fn invalid_params(message: impl Into<String>) -> Self {
        Self::new("invalid_params", message)
    }
}

pub trait SecurityPolicy: Send + Sync {
    fn check_tool_call(
        &self,
        _tool_name: &ToolName,
        _params: &Value,
    ) -> Result<(), SecurityError> {
        Ok(())
    }

    fn resolve_workspace_path(
        &self,
        workspace: &Path,
        requested: Option<PathBuf>,
    ) -> Result<PathBuf, SecurityError>;
}

#[derive(Default)]
pub struct DisabledSecurityPolicy;

impl SecurityPolicy for DisabledSecurityPolicy {
    fn resolve_workspace_path(
        &self,
        workspace: &Path,
        requested: Option<PathBuf>,
    ) -> Result<PathBuf, SecurityError> {
        let path = requested.unwrap_or_else(|| workspace.to_path_buf());
        let path = if path.is_absolute() {
            path
        } else {
            workspace.join(path)
        };
        if path.exists() {
            Ok(path)
        } else {
            Err(SecurityError::invalid_params(format!(
                "cwd does not exist: {}",
                path.display()
            )))
        }
    }
}

pub struct WorkspaceSecurityPolicy;

impl SecurityPolicy for WorkspaceSecurityPolicy {
    fn resolve_workspace_path(
        &self,
        workspace: &Path,
        requested: Option<PathBuf>,
    ) -> Result<PathBuf, SecurityError> {
        let path = requested.unwrap_or_else(|| workspace.to_path_buf());
        let path = if path.is_absolute() {
            path
        } else {
            workspace.join(path)
        };
        let canonical = path.canonicalize().map_err(|error| {
            SecurityError::invalid_params(format!(
                "failed to canonicalize cwd {}: {error}",
                path.display()
            ))
        })?;
        if !canonical.starts_with(workspace) {
            return Err(SecurityError::new(
                "security.cwdOutsideWorkspace",
                format!("cwd must remain inside workspace: {}", canonical.display()),
            ));
        }
        Ok(canonical)
    }
}

pub fn build_security_policy(mode: SecurityMode) -> std::sync::Arc<dyn SecurityPolicy> {
    match mode {
        SecurityMode::Disabled => std::sync::Arc::new(DisabledSecurityPolicy),
        SecurityMode::Workspace => std::sync::Arc::new(WorkspaceSecurityPolicy),
    }
}
