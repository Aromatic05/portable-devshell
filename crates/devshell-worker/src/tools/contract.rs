use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::daemon::process_registry::ActiveProcessRegistry;

use crate::security::SecurityPolicy;
use crate::tools::{ToolError, ToolName};
use schemars::JsonSchema;
use serde::Serialize;

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
    pub policy: Arc<dyn SecurityPolicy>,
    pub process_registry: Arc<ActiveProcessRegistry>,
    pub cancellation: ToolCancellation,
}

impl ToolCall {
    pub fn check_cancelled(&self) -> Result<(), ToolError> {
        self.cancellation.check()
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

pub trait ToolHandler: Send + Sync {
    fn name(&self) -> &ToolName;
    fn catalog_entry(&self) -> ToolCatalogEntry;
    fn call(&self, call: ToolCall) -> Result<serde_json::Value, ToolError>;
}
