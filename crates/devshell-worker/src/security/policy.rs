use crate::security::path::FilesystemCapability;

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
    fn check_capability(&self, capability: FilesystemCapability) -> Result<(), SecurityError>;
}

#[derive(Default)]
pub struct DisabledSecurityPolicy;

impl SecurityPolicy for DisabledSecurityPolicy {
    fn check_capability(&self, _capability: FilesystemCapability) -> Result<(), SecurityError> {
        Ok(())
    }
}

pub struct WorkspaceSecurityPolicy;

impl SecurityPolicy for WorkspaceSecurityPolicy {
    fn check_capability(&self, capability: FilesystemCapability) -> Result<(), SecurityError> {
        match capability {
            FilesystemCapability::AbsoluteRead | FilesystemCapability::AbsoluteWrite => Err(SecurityError::new(
                "security.denied",
                "absolute filesystem access is denied in workspace security mode",
            )),
            FilesystemCapability::WorkspaceRead
            | FilesystemCapability::WorkspaceWrite
            | FilesystemCapability::ProcessExecute => Ok(()),
        }
    }
}

pub fn build_security_policy(mode: SecurityMode) -> std::sync::Arc<dyn SecurityPolicy> {
    match mode {
        SecurityMode::Disabled => std::sync::Arc::new(DisabledSecurityPolicy),
        SecurityMode::Workspace => std::sync::Arc::new(WorkspaceSecurityPolicy),
    }
}
