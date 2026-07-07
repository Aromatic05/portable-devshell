use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use crate::security::SecurityPolicy;
use crate::tools::{ToolError, ToolName};

#[derive(Clone)]
pub struct ToolCall {
    pub workspace: PathBuf,
    pub params: serde_json::Value,
    pub policy: Arc<dyn SecurityPolicy>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCatalogEntry {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
}

pub trait ToolHandler: Send + Sync {
    fn name(&self) -> &ToolName;
    fn catalog_entry(&self) -> ToolCatalogEntry;
    fn call(&self, call: ToolCall) -> Result<serde_json::Value, ToolError>;
}
