use std::sync::Arc;

use schemars::schema_for;

use crate::tools::artifact::store::ArtifactStore;
use crate::tools::artifact::types::{ArtifactReadInput, ArtifactReadOutput};
use crate::tools::{ToolAccess, ToolCall, ToolCatalogEntry, ToolError, ToolHandler, ToolName};

pub struct ArtifactReadTool {
    name: ToolName,
    store: Arc<ArtifactStore>,
}

impl ArtifactReadTool {
    pub fn new(store: Arc<ArtifactStore>) -> Self {
        Self {
            name: ToolName::parse("artifact_read").unwrap(),
            store,
        }
    }
}

impl ToolHandler for ArtifactReadTool {
    fn name(&self) -> &ToolName {
        &self.name
    }

    fn catalog_entry(&self) -> ToolCatalogEntry {
        ToolCatalogEntry {
            group: self.name.group().to_string(),
            name: self.name.as_str(),
            description: "Read a paged stdout or stderr artifact by opaque handle. Use base64 encoding for lossless binary output.".to_string(),
            input_schema: serde_json::to_value(schema_for!(ArtifactReadInput)).unwrap(),
            output_schema: serde_json::to_value(schema_for!(ArtifactReadOutput)).unwrap(),
            access: ToolAccess::Read,
        }
    }

    fn call(&self, call: ToolCall) -> Result<serde_json::Value, ToolError> {
        let input: ArtifactReadInput = serde_json::from_value(call.params)
            .map_err(|error| ToolError::new("tool.invalidArguments", error.to_string()))?;
        serde_json::to_value(self.store.read(input)?)
            .map_err(|error| ToolError::new("tool.internalError", error.to_string()))
    }
}
