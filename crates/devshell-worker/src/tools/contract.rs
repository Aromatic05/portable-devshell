use std::path::PathBuf;
use std::sync::Arc;

use crate::daemon::process_registry::ActiveProcessRegistry;

use crate::security::SecurityPolicy;
use crate::tools::{ToolError, ToolName};
use schemars::JsonSchema;
use serde::Serialize;

#[derive(Clone)]
pub struct ToolCall {
    pub workspace: PathBuf,
    pub params: serde_json::Value,
    pub session_id: String,
    pub policy: Arc<dyn SecurityPolicy>,
    pub process_registry: Arc<ActiveProcessRegistry>,
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
