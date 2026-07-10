use std::fs;
use std::path::Path;
use std::sync::Arc;

use globset::{Glob, GlobSetBuilder};
use schemars::schema_for;

use crate::tools::file::types::{FileFindEntry, FileFindInput, FileFindOutput, FindType};
use crate::tools::file::{FileToolState, resolve_existing};
use crate::tools::{ToolAccess, ToolCall, ToolCatalogEntry, ToolError, ToolHandler, ToolName};

pub struct FileFindTool {
    name: ToolName,
    _state: Arc<FileToolState>,
}
impl FileFindTool {
    pub fn new(state: Arc<FileToolState>) -> Self {
        Self {
            name: ToolName::parse("file_find").unwrap(),
            _state: state,
        }
    }
}
impl ToolHandler for FileFindTool {
    fn name(&self) -> &ToolName {
        &self.name
    }
    fn catalog_entry(&self) -> ToolCatalogEntry {
        ToolCatalogEntry {
            name: self.name.as_str(),
            description:
                "Find files and directories without following discovered directory symlinks."
                    .to_string(),
            input_schema: serde_json::to_value(schema_for!(FileFindInput)).unwrap(),
            output_schema: serde_json::to_value(schema_for!(FileFindOutput)).unwrap(),
            access: ToolAccess::Read,
        }
    }
    fn call(&self, call: ToolCall) -> Result<serde_json::Value, ToolError> {
        let input: FileFindInput = serde_json::from_value(call.params.clone())
            .map_err(|error| ToolError::new("tool.invalidArguments", error.to_string()))?;
        let root_raw = input.path.unwrap_or_else(|| "./".to_string());
        let (requested, root) = resolve_existing(&call, &root_raw, false)?;
        if !root.is_dir() {
            return Err(ToolError::new(
                "file.notDirectory",
                "find root is not a directory",
            ));
        }
        let patterns = input.patterns.unwrap_or_else(|| vec!["**/*".to_string()]);
        if patterns.len() > 32 {
            return Err(ToolError::new(
                "file.invalidPattern",
                "at most 32 patterns are allowed",
            ));
        }
        let mut builder = GlobSetBuilder::new();
        for pattern in patterns {
            builder.add(
                Glob::new(&pattern)
                    .map_err(|error| ToolError::new("file.invalidPattern", error.to_string()))?,
            );
        }
        let glob = builder
            .build()
            .map_err(|error| ToolError::new("file.invalidPattern", error.to_string()))?;
        let hidden = input.include_hidden.unwrap_or(false);
        let kind = input.entry_type.unwrap_or(FindType::Any);
        let limit = input.limit.unwrap_or(200).min(1000);
        let mut entries = Vec::new();
        walk(
            &root,
            &root,
            &requested.raw,
            hidden,
            &kind,
            &glob,
            &mut entries,
        )?;
        entries.sort_by(|left, right| left.path.cmp(&right.path));
        let offset = decode_cursor(input.cursor.as_deref())?;
        let next = if entries.len() > offset + limit {
            Some((offset + limit).to_string())
        } else {
            None
        };
        entries = entries.into_iter().skip(offset).take(limit).collect();
        serde_json::to_value(FileFindOutput {
            entries,
            next_cursor: next,
        })
        .map_err(|error| ToolError::new("tool.internalError", error.to_string()))
    }
}
fn walk(
    root: &Path,
    current: &Path,
    display_root: &str,
    hidden: bool,
    kind: &FindType,
    glob: &globset::GlobSet,
    entries: &mut Vec<FileFindEntry>,
) -> Result<(), ToolError> {
    for entry in fs::read_dir(current)
        .map_err(|error| ToolError::new("file.notDirectory", error.to_string()))?
    {
        let entry = entry.map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
        let name = entry.file_name();
        if !hidden && name.to_string_lossy().starts_with('.') {
            continue;
        }
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
        let relative = path.strip_prefix(root).unwrap();
        let relative_text = relative.to_string_lossy().replace('\\', "/");
        let display = if display_root == "./" {
            format!("./{relative_text}")
        } else {
            format!("{}/{}", display_root.trim_end_matches('/'), relative_text)
        };
        let entry_type = if metadata.file_type().is_symlink() {
            "symlink"
        } else if metadata.is_dir() {
            "directory"
        } else if metadata.is_file() {
            "file"
        } else {
            continue;
        };
        if glob.is_match(&relative_text)
            && (kind == &FindType::Any
                || (kind == &FindType::File && entry_type == "file")
                || (kind == &FindType::Directory && entry_type == "directory"))
        {
            entries.push(FileFindEntry {
                path: display,
                entry_type: entry_type.to_string(),
            });
        }
        if metadata.is_dir() && !metadata.file_type().is_symlink() {
            walk(root, &path, display_root, hidden, kind, glob, entries)?;
        }
    }
    Ok(())
}
fn decode_cursor(cursor: Option<&str>) -> Result<usize, ToolError> {
    cursor
        .map(|value| {
            value
                .parse()
                .map_err(|_| ToolError::new("file.invalidCursor", "invalid cursor"))
        })
        .transpose()
        .map(|value| value.unwrap_or(0))
}
