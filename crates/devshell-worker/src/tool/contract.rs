use std::fmt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

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
    pub process_registry: Arc<dyn ToolProcessRegistry>,
    pub cancellation: ToolCancellation,
    pub progress: ToolProgressEmitter,
}

/// A registered process group is released when its RAII guard is dropped.
pub trait ToolProcessGuard: Send {}

impl<T: Send> ToolProcessGuard for T {}

/// Process lifetime port supplied by the Worker runtime.
pub trait ToolProcessRegistry: Send + Sync {
    fn register(self: Arc<Self>, process_group: i32) -> Result<Box<dyn ToolProcessGuard>, String>;
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
    publish: Arc<dyn Fn(serde_json::Value) + Send + Sync>,
}

impl ToolProgressEmitter {
    pub fn new(publish: impl Fn(serde_json::Value) + Send + Sync + 'static) -> Self {
        Self {
            publish: Arc::new(publish),
        }
    }

    pub fn emit(&self, value: serde_json::Value) {
        (self.publish)(value);
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
    #[serde(rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<serde_json::Value>,
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
        meta: None,
        group: name.group().to_string(),
        name: name.as_str(),
        description: description.into(),
        input_schema: serde_json::to_value(schemars::schema_for!(I)).unwrap(),
        output_schema: serde_json::to_value(schemars::schema_for!(O)).unwrap(),
        required_capabilities: capabilities.into_iter().collect(),
    }
}

pub(crate) fn catalog_entry_with_meta<I: JsonSchema, O: JsonSchema>(
    name: &ToolName,
    description: impl Into<String>,
    capabilities: impl IntoIterator<Item = ToolCapability>,
    meta: serde_json::Value,
) -> ToolCatalogEntry {
    let mut entry = catalog_entry::<I, O>(name, description, capabilities);
    entry.meta = Some(meta);
    entry
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

impl From<crate::instance::sandbox::path::PathError> for ToolError {
    fn from(error: crate::instance::sandbox::path::PathError) -> Self {
        Self::new(error.code, error.message)
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
