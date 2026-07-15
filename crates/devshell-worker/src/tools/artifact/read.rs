use std::sync::Arc;

use crate::tools::artifact::store::ArtifactStore;
use crate::tools::artifact::types::{ArtifactReadInput, ArtifactReadOutput};
use crate::tools::{ToolCall, ToolCapability, ToolCatalogEntry, ToolError, ToolHandler, ToolName};

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
        crate::tools::contract::catalog_entry::<ArtifactReadInput, ArtifactReadOutput>(
            &self.name,
            "Read a paged stdout or stderr artifact by handle. Use base64 for lossless binary data.".to_string(),
            [ToolCapability::Read],
        )
    }

    fn call(&self, call: ToolCall) -> Result<serde_json::Value, ToolError> {
        call.check_cancelled()?;
        let input: ArtifactReadInput = call.parse_params()?;
        let output = self.store.read(input)?;
        call.check_cancelled()?;
        crate::tools::contract::serialize(output)
    }
}
