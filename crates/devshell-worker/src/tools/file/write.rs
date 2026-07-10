use std::fs;
use std::io::Write;
use std::sync::Arc;

use schemars::schema_for;
use tempfile::NamedTempFile;

use crate::security::path::parse_requested_path;
use crate::tools::file::state::TextFile;
use crate::tools::file::types::{FileWriteInput, FileWriteMode, FileWriteOutput};
use crate::tools::file::{FileToolState, authorize, resolve_create};
use crate::tools::{ToolAccess, ToolCall, ToolCatalogEntry, ToolError, ToolHandler, ToolName};

pub struct FileWriteTool {
    name: ToolName,
    state: Arc<FileToolState>,
}
impl FileWriteTool {
    pub fn new(state: Arc<FileToolState>) -> Self {
        Self {
            name: ToolName::parse("file_write").unwrap(),
            state,
        }
    }
}
impl ToolHandler for FileWriteTool {
    fn name(&self) -> &ToolName {
        &self.name
    }
    fn catalog_entry(&self) -> ToolCatalogEntry {
        ToolCatalogEntry {
            name: self.name.as_str(),
            description: "Create or atomically overwrite a UTF-8 text file.".to_string(),
            input_schema: serde_json::to_value(schema_for!(FileWriteInput)).unwrap(),
            output_schema: serde_json::to_value(schema_for!(FileWriteOutput)).unwrap(),
            access: ToolAccess::Write,
        }
    }
    fn call(&self, call: ToolCall) -> Result<serde_json::Value, ToolError> {
        let input: FileWriteInput = serde_json::from_value(call.params.clone())
            .map_err(|error| ToolError::new("tool.invalidArguments", error.to_string()))?;
        if input.content.contains('\0') {
            return Err(ToolError::new(
                "file.notText",
                "content cannot contain NUL bytes",
            ));
        }
        let requested_path = parse_requested_path(&input.path)?;
        authorize(&call, requested_path.namespace, true)?;
        let existing_entry = requested_path.path(&call.workspace).symlink_metadata().is_ok();
        if input.mode == FileWriteMode::Create && existing_entry {
            return Err(ToolError::new(
                "file.alreadyExists",
                "create requires a missing target",
            ));
        }
        let (requested, path) = resolve_create(&call, &input.path)?;
        let write_lock = self.state.write_lock(&path);
        let _write_guard = write_lock.lock().unwrap();
        let existing = path.symlink_metadata().is_ok();
        if input.mode == FileWriteMode::Overwrite && existing {
            let expected = input.expected_revision.as_deref().ok_or_else(|| {
                ToolError::new(
                    "file.invalidArguments",
                    "overwrite requires expectedRevision for an existing file",
                )
            })?;
            let current = TextFile::read(&path)?;
            if current.revision != expected {
                return Err(ToolError::retryable(
                    "file.revisionMismatch",
                    "file changed since the expected revision",
                ));
            }
        }
        let parent = path
            .parent()
            .ok_or_else(|| ToolError::new("file.writeFailed", "target has no parent"))?;
        let metadata = if existing {
            Some(
                fs::metadata(&path)
                    .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?,
            )
        } else {
            None
        };
        let mut temp = NamedTempFile::new_in(parent)
            .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
        temp.write_all(input.content.as_bytes())
            .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
        temp.flush()
            .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
        if let Some(metadata) = metadata {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                temp.as_file()
                    .set_permissions(fs::Permissions::from_mode(metadata.permissions().mode()))
                    .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
            }
        }
        let (_, verified_target) = resolve_create(&call, &input.path)?;
        if verified_target != path {
            return Err(ToolError::new(
                "file.writeFailed",
                "target changed while preparing the write",
            ));
        }
        if existing {
            let expected = input.expected_revision.as_deref().unwrap();
            let current = TextFile::read(&path)?;
            if current.revision != expected {
                return Err(ToolError::retryable(
                    "file.revisionMismatch",
                    "file changed while preparing the write",
                ));
            }
        }
        temp.persist(&path)
            .map_err(|error| ToolError::new("file.writeFailed", error.error.to_string()))?;
        let text = TextFile::read(&path)?;
        let snapshot_id =
            self.state
                .snapshots
                .lock()
                .unwrap()
                .remember(&path, &text, 1..=text.lines.len());
        serde_json::to_value(FileWriteOutput {
            path: requested.raw,
            created: !existing,
            snapshot_id,
            revision: text.revision,
            bytes_written: input.content.len(),
            total_lines: text.lines.len(),
        })
        .map_err(|error| ToolError::new("tool.internalError", error.to_string()))
    }
}
