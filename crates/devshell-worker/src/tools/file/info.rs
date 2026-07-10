use std::fs;
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use schemars::schema_for;

use crate::tools::file::types::{FileInfoInput, FileInfoOutput};
use crate::tools::file::{FileToolState, resolve_existing};
use crate::tools::{ToolAccess, ToolCall, ToolCatalogEntry, ToolError, ToolHandler, ToolName};

pub struct FileInfoTool {
    name: ToolName,
    _state: Arc<FileToolState>,
}
impl FileInfoTool {
    pub fn new(state: Arc<FileToolState>) -> Self {
        Self {
            name: ToolName::parse("file_info").unwrap(),
            _state: state,
        }
    }
}
impl ToolHandler for FileInfoTool {
    fn name(&self) -> &ToolName {
        &self.name
    }
    fn catalog_entry(&self) -> ToolCatalogEntry {
        ToolCatalogEntry {
            name: self.name.as_str(),
            description: "Inspect a filesystem entry without following its final symlink."
                .to_string(),
            input_schema: serde_json::to_value(schema_for!(FileInfoInput)).unwrap(),
            output_schema: serde_json::to_value(schema_for!(FileInfoOutput)).unwrap(),
            access: ToolAccess::Read,
        }
    }
    fn call(&self, call: ToolCall) -> Result<serde_json::Value, ToolError> {
        let input: FileInfoInput = serde_json::from_value(call.params.clone())
            .map_err(|error| ToolError::new("tool.invalidArguments", error.to_string()))?;
        let (requested, canonical) = resolve_existing(&call, &input.path, false)?;
        let raw = requested.path(&call.workspace);
        let metadata = fs::symlink_metadata(&raw)
            .map_err(|error| ToolError::new("file.notFound", error.to_string()))?;
        let entry_type = if metadata.file_type().is_symlink() {
            "symlink"
        } else if metadata.is_file() {
            "file"
        } else if metadata.is_dir() {
            "directory"
        } else {
            "other"
        };
        let target_type = if entry_type == "symlink" {
            fs::metadata(&canonical).ok().map(|metadata| {
                if metadata.is_file() {
                    "file".to_string()
                } else if metadata.is_dir() {
                    "directory".to_string()
                } else {
                    "other".to_string()
                }
            })
        } else {
            None
        };
        #[cfg(unix)]
        let mode = {
            use std::os::unix::fs::MetadataExt;
            Some(metadata.mode())
        };
        #[cfg(not(unix))]
        let mode = None;
        let modified_at_ms = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |value| value.as_millis());
        serde_json::to_value(FileInfoOutput {
            path: requested.raw,
            entry_type: entry_type.to_string(),
            size_bytes: metadata.len(),
            modified_at_ms,
            mode,
            target_type,
        })
        .map_err(|error| ToolError::new("tool.internalError", error.to_string()))
    }
}
