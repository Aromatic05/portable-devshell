#[cfg(unix)]
use std::fs;
use std::io::Write;
use std::sync::Arc;

use schemars::schema_for;

use crate::security::path::parse_requested_path;
use crate::tools::file::publish::{self, PublishMode};
use crate::tools::file::state::TextFile;
use crate::tools::file::types::{FileWriteInput, FileWriteOutput};
use crate::tools::file::{FileToolState, authorize, resolve_create};
use crate::tools::{ToolCall, ToolCapability, ToolCatalogEntry, ToolError, ToolHandler, ToolName};

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
            group: self.name.group().to_string(),
            name: self.name.as_str(),
            description: "Create a new UTF-8 text file, or fully rewrite an existing file when expectedRevision is provided.".to_string(),
            input_schema: serde_json::to_value(schema_for!(FileWriteInput)).unwrap(),
            output_schema: serde_json::to_value(schema_for!(FileWriteOutput)).unwrap(),
            required_capabilities: vec![ToolCapability::Write],
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
        let existing_entry = requested_path
            .path(&call.workspace)
            .symlink_metadata()
            .is_ok();
        match (&input.expected_revision, existing_entry) {
            (None, true) => {
                return Err(ToolError::new(
                    "file.alreadyExists",
                    "creation requires a missing target",
                ));
            }
            (Some(_), false) => {
                return Err(ToolError::new(
                    "file.notFound",
                    "update requires an existing target",
                ));
            }
            _ => {}
        }
        let (requested, path) = resolve_create(&call, &input.path)?;
        let write_lock = self.state.write_lock(&path);
        let _write_guard = write_lock.lock().unwrap();
        let existing = path.symlink_metadata().is_ok();
        if let Some(expected) = input.expected_revision.as_deref() {
            let current = TextFile::read(&path)?;
            if current.revision != expected {
                return Err(ToolError::retryable(
                    "file.revisionMismatch",
                    "file changed since the expected revision",
                ));
            }
        }
        #[cfg(unix)]
        let metadata = if existing {
            Some(
                fs::metadata(&path)
                    .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?,
            )
        } else {
            None
        };
        let mut temp = publish::new_temp(&path)?;
        temp.write_all(input.content.as_bytes())
            .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
        temp.flush()
            .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
        #[cfg(unix)]
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
        if let Some(expected) = input.expected_revision.as_deref() {
            let current = TextFile::read(&path)?;
            if current.revision != expected {
                return Err(ToolError::retryable(
                    "file.revisionMismatch",
                    "file changed while preparing the write",
                ));
            }
        }
        let publish_mode = if input.expected_revision.is_some() {
            PublishMode::Replace
        } else {
            PublishMode::NoClobber
        };
        publish::publish(temp, &path, publish_mode)?;
        let text = TextFile::read(&path)?;
        let snapshot =
            self.state
                .snapshots
                .lock()
                .unwrap()
                .remember(&path, &text, 1..=text.lines.len());
        serde_json::to_value(FileWriteOutput {
            path: requested.raw,
            created: !existing,
            snapshot_id: snapshot.id,
            snapshot_tag: snapshot.tag,
            revision: text.revision,
            bytes_written: input.content.len(),
            total_lines: text.lines.len(),
        })
        .map_err(|error| ToolError::new("tool.internalError", error.to_string()))
    }
}
