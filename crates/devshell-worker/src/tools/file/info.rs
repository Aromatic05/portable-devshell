use std::fs;
use std::time::UNIX_EPOCH;

use crate::security::path::parse_requested_path;
use crate::tools::file::types::{FileInfoEntry, FileInfoInput, FileInfoOutput};
use crate::tools::file::{authorize, resolve_info};
use crate::tools::{ToolCall, ToolCapability, ToolCatalogEntry, ToolError, ToolHandler, ToolName};

pub struct FileInfoTool {
    name: ToolName,
}
impl FileInfoTool {
    pub fn new() -> Self {
        Self {
            name: ToolName::parse("file_info").unwrap(),
        }
    }
}
impl ToolHandler for FileInfoTool {
    fn name(&self) -> &ToolName {
        &self.name
    }
    fn catalog_entry(&self) -> ToolCatalogEntry {
        crate::tools::contract::catalog_entry::<FileInfoInput, FileInfoOutput>(
            &self.name,
            "Inspect file metadata without following the final symbolic link.".to_string(),
            [ToolCapability::Read],
        )
    }
    fn call(&self, call: ToolCall) -> Result<serde_json::Value, ToolError> {
        call.check_cancelled()?;
        let input: FileInfoInput = call.parse_params()?;
        if input.paths.is_empty() {
            return Err(ToolError::new(
                "tool.invalidArguments",
                "paths cannot be empty",
            ));
        }
        let mut entries = Vec::with_capacity(input.paths.len());
        for raw_path in input.paths {
            call.check_cancelled()?;
            let requested = parse_requested_path(&raw_path)?;
            authorize(&call, requested.namespace, false)?;
            let raw = requested.path(&call.workspace);
            let metadata = match fs::symlink_metadata(&raw) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    entries.push(FileInfoEntry {
                        path: raw_path,
                        exists: false,
                        entry_type: None,
                        size_bytes: None,
                        modified_at_ms: None,
                        mode: None,
                        target_type: None,
                    });
                    continue;
                }
                Err(error) => return Err(ToolError::new("file.writeFailed", error.to_string())),
            };
            let (requested, raw) = resolve_info(&call, &raw_path)?;
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
                fs::metadata(&raw).ok().map(|metadata| {
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
                .map(|value| value.as_millis());
            entries.push(FileInfoEntry {
                path: requested.raw,
                exists: true,
                entry_type: Some(entry_type.to_string()),
                size_bytes: Some(metadata.len()),
                modified_at_ms,
                mode,
                target_type,
            });
        }
        crate::tools::contract::serialize(FileInfoOutput { entries })
    }
}
