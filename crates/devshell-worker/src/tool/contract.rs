use std::fmt;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use crate::capability::rpc::notification::WorkerNotificationQueue;
use crate::daemon::process::registry::ActiveProcessRegistry;

use crate::instance::sandbox::SecurityPolicy;
use schemars::JsonSchema;
use serde::{Serialize, de::DeserializeOwned};

#[derive(Clone, Default)]
pub struct ToolCancellation {
    cancelled: Arc<AtomicBool>,
}

impl ToolCancellation {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    pub fn check(&self) -> Result<(), ToolError> {
        if self.is_cancelled() {
            return Err(ToolError::new(
                "tool.cancelled",
                "Tool call was cancelled by the client.",
            ));
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct ToolCall {
    pub workspace: PathBuf,
    pub params: serde_json::Value,
    pub ctx_id: String,
    pub operation_id: String,
    pub source: Option<String>,
    pub policy: Arc<dyn SecurityPolicy>,
    pub process_registry: Arc<ActiveProcessRegistry>,
    pub cancellation: ToolCancellation,
    pub progress: ToolProgressEmitter,
}

impl ToolCall {
    pub fn check_cancelled(&self) -> Result<(), ToolError> {
        self.cancellation.check()
    }

    pub fn parse_params<T: DeserializeOwned>(&self) -> Result<T, ToolError> {
        serde_json::from_value(self.params.clone())
            .map_err(|error| ToolError::new("tool.invalidArguments", error.to_string()))
    }

    pub fn emit_progress(&self, value: serde_json::Value) {
        self.progress.emit(value);
    }

    pub fn progress(&self) -> ToolProgressEmitter {
        self.progress.clone()
    }
}

#[derive(Clone)]
pub struct ToolProgressEmitter {
    notifications: Arc<WorkerNotificationQueue>,
    operation_id: String,
    sequence: Arc<AtomicU64>,
}

impl ToolProgressEmitter {
    pub fn new(operation_id: String, notifications: Arc<WorkerNotificationQueue>) -> Self {
        Self {
            notifications,
            operation_id,
            sequence: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn emit(&self, value: serde_json::Value) {
        let sequence = self.sequence.fetch_add(1, Ordering::SeqCst) + 1;
        let notification = serde_json::json!({
            "type": "notification",
            "method": "tool.progress",
            "params": {
                "operationId": self.operation_id,
                "sequence": sequence,
                "value": value,
            }
        });
        let _ = self.notifications.push_lossy_json(&notification);
    }
}

#[derive(Clone, Copy, Debug, JsonSchema, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolCapability {
    Read,
    Write,
    Execute,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCatalogEntry {
    pub group: String,
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
    pub output_schema: serde_json::Value,
    pub required_capabilities: Vec<ToolCapability>,
}

pub(crate) fn catalog_entry<I: JsonSchema, O: JsonSchema>(
    name: &ToolName,
    description: impl Into<String>,
    capabilities: impl IntoIterator<Item = ToolCapability>,
) -> ToolCatalogEntry {
    ToolCatalogEntry {
        group: name.group().to_string(),
        name: name.as_str(),
        description: description.into(),
        input_schema: serde_json::to_value(schemars::schema_for!(I)).unwrap(),
        output_schema: serde_json::to_value(schemars::schema_for!(O)).unwrap(),
        required_capabilities: capabilities.into_iter().collect(),
    }
}

pub(crate) fn serialize(value: impl Serialize) -> Result<serde_json::Value, ToolError> {
    serde_json::to_value(value)
        .map_err(|error| ToolError::new("tool.internalError", error.to_string()))
}

pub trait ToolHandler: Send + Sync {
    fn name(&self) -> &ToolName;
    fn catalog_entry(&self) -> ToolCatalogEntry;
    fn call(&self, call: ToolCall) -> Result<serde_json::Value, ToolError>;
}

#[derive(Clone, Debug)]
pub struct ToolError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub details: Option<serde_json::Value>,
}

impl ToolError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable: false,
            details: None,
        }
    }

    pub fn retryable(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable: true,
            details: None,
        }
    }

    pub fn with_details(mut self, details: serde_json::Value) -> Self {
        self.details = Some(details);
        self
    }
}

impl From<crate::instance::sandbox::policy::SecurityError> for ToolError {
    fn from(error: crate::instance::sandbox::policy::SecurityError) -> Self {
        Self {
            code: error.code,
            message: error.message,
            retryable: false,
            details: error.details,
        }
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ToolName {
    group: String,
    operation: String,
}

impl ToolName {
    pub fn parse(raw: &str) -> Result<Self, String> {
        if raw.bytes().filter(|value| *value == b'_').count() != 1 {
            return Err(format!(
                "tool method `{raw}` must contain exactly one `_` separator"
            ));
        }
        let Some((group, operation)) = raw.split_once('_') else {
            return Err(format!("tool method `{raw}` must use group_operation form"));
        };

        if group.is_empty() || operation.is_empty() {
            return Err(format!(
                "tool method `{raw}` must use non-empty group and operation"
            ));
        }

        if !group
            .chars()
            .all(|value| value.is_ascii_lowercase() || value.is_ascii_digit())
        {
            return Err(format!(
                "tool group `{group}` must use lowercase ASCII letters or digits"
            ));
        }

        if !operation
            .chars()
            .all(|value| value.is_ascii_lowercase() || value.is_ascii_digit())
        {
            return Err(format!(
                "tool operation `{operation}` must use lowercase ASCII letters or digits"
            ));
        }

        Ok(Self {
            group: group.to_string(),
            operation: operation.to_string(),
        })
    }

    pub fn group(&self) -> &str {
        &self.group
    }

    pub fn as_str(&self) -> String {
        format!("{}_{}", self.group, self.operation)
    }
}

impl fmt::Display for ToolName {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::ToolName;

    #[test]
    fn tool_name_requires_exactly_one_namespace_separator() {
        assert_eq!(ToolName::parse("bash_run").unwrap().group(), "bash");
        assert!(ToolName::parse("bash").is_err());
        assert!(ToolName::parse("bash_run_extra").is_err());
    }
}
