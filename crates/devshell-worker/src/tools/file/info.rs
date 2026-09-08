use crate::security::path::ResolvedEntry;
use crate::tools::file::resolve_info;
use crate::tools::file::types::{FileInfoEntry, FileInfoInput, FileInfoOutput};
use crate::tools::{ToolCall, ToolCapability, ToolCatalogEntry, ToolError, ToolHandler, ToolName};

const MAX_SERIALIZED_OUTPUT_BYTES: usize = 1024 * 1024;

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
        let details = input.details.unwrap_or(false);
        let mut entries = Vec::with_capacity(input.paths.len());
        let mut serialized_bytes = br#"{"entries":[]}"#.len();
        for raw_path in input.paths {
            call.check_cancelled()?;
            let (requested, resolved) = resolve_info(&call, &raw_path)?;
            let (target, metadata) = match resolved {
                ResolvedEntry::Existing { target, metadata } => (target, metadata),
                ResolvedEntry::Missing => {
                    push_entry(
                        &mut entries,
                        &mut serialized_bytes,
                        FileInfoEntry {
                            path: requested.raw,
                            exists: Some(false),
                            entry_type: None,
                            size_bytes: None,
                            modified_at_ms: None,
                            mode: None,
                            target_type: None,
                        },
                    )?;
                    continue;
                }
            };
            let entry_type = if metadata.is_symlink() {
                "symlink"
            } else if metadata.is_file() {
                "file"
            } else if metadata.is_dir() {
                "directory"
            } else {
                "other"
            };
            let target_type = if entry_type == "symlink" {
                target.metadata(true).ok().flatten().map(|metadata| {
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
            let mode = Some(metadata.mode());
            #[cfg(not(unix))]
            let mode = None;
            push_entry(
                &mut entries,
                &mut serialized_bytes,
                FileInfoEntry {
                    path: requested.raw,
                    exists: None,
                    entry_type: Some(entry_type.to_string()),
                    size_bytes: details.then_some(metadata.len()),
                    modified_at_ms: details.then_some(metadata.modified_at_millis()).flatten(),
                    mode: details.then_some(mode).flatten(),
                    target_type,
                },
            )?;
        }
        crate::tools::contract::serialize(FileInfoOutput { entries })
    }
}

fn push_entry(
    entries: &mut Vec<FileInfoEntry>,
    serialized_bytes: &mut usize,
    entry: FileInfoEntry,
) -> Result<(), ToolError> {
    let entry_bytes = serde_json::to_vec(&entry)
        .map_err(|error| ToolError::new("tool.internalError", error.to_string()))?
        .len()
        .saturating_add(usize::from(!entries.is_empty()));
    if serialized_bytes.saturating_add(entry_bytes) > MAX_SERIALIZED_OUTPUT_BYTES {
        return Err(ToolError::new(
            "file.outputTooLarge",
            "file_info batch exceeds the serialized output budget; split paths into smaller batches",
        ));
    }
    *serialized_bytes = serialized_bytes.saturating_add(entry_bytes);
    entries.push(entry);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{FileInfoEntry, MAX_SERIALIZED_OUTPUT_BYTES, push_entry};

    #[test]
    fn file_info_batch_reports_output_budget_before_transport_overflow() {
        let mut entries = Vec::new();
        let mut bytes = MAX_SERIALIZED_OUTPUT_BYTES - 8;
        let error = push_entry(
            &mut entries,
            &mut bytes,
            FileInfoEntry {
                path: "./some-file".to_string(),
                exists: Some(false),
                entry_type: None,
                size_bytes: None,
                modified_at_ms: None,
                mode: None,
                target_type: None,
            },
        )
        .unwrap_err();
        assert_eq!(error.code, "file.outputTooLarge");
        assert!(entries.is_empty());
    }
}
