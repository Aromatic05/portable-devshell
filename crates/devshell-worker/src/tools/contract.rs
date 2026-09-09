use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use crate::daemon::process_registry::ActiveProcessRegistry;
use crate::rpc::notification::WorkerNotificationQueue;

use crate::security::SecurityPolicy;
use crate::tools::{ToolError, ToolName};
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
