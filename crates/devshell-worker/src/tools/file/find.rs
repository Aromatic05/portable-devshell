use std::sync::Arc;

use globset::{Glob, GlobSetBuilder};
use ignore::WalkBuilder;
use schemars::schema_for;
use serde_json::json;

use crate::tools::file::types::{FileFindEntry, FileFindInput, FileFindOutput, FindType};
use crate::tools::file::{FileToolState, resolve_existing};
use crate::tools::{ToolAccess, ToolCall, ToolCatalogEntry, ToolError, ToolHandler, ToolName};

pub struct FileFindTool {
    name: ToolName,
    state: Arc<FileToolState>,
}

impl FileFindTool {
    pub fn new(state: Arc<FileToolState>) -> Self {
        Self {
            name: ToolName::parse("file_find").unwrap(),
            state,
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
        for pattern in &patterns {
            builder.add(
                Glob::new(pattern)
                    .map_err(|error| ToolError::new("file.invalidPattern", error.to_string()))?,
            );
        }
        let glob = builder
            .build()
            .map_err(|error| ToolError::new("file.invalidPattern", error.to_string()))?;
        let hidden = input.include_hidden.unwrap_or(false);
        let kind = input.entry_type.unwrap_or(FindType::Any);
        let respect_gitignore = input.respect_gitignore.unwrap_or(true);
        let limit = input.limit.unwrap_or(200);
        if limit > 1000 {
            return Err(ToolError::new(
                "tool.invalidArguments",
                "limit cannot exceed 1000",
            ));
        }
        let query = json!({
            "path": root_raw,
            "patterns": patterns,
            "type": kind,
            "includeHidden": hidden,
            "respectGitignore": respect_gitignore,
            "limit": limit,
        });
        let offset = match input.cursor.as_deref() {
            Some(cursor) => self.state.cursors.lock().unwrap().resolve(cursor, &query)?,
            None => 0,
        };
        let mut entries = Vec::new();
        let mut walker = WalkBuilder::new(&root);
        walker
            .follow_links(false)
            .hidden(!hidden)
            .git_ignore(respect_gitignore)
            .git_exclude(respect_gitignore)
            .git_global(false)
            .ignore(respect_gitignore)
            .require_git(false);
        for entry in walker.build() {
            let entry =
                entry.map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
            let path = entry.path();
            if path == root {
                continue;
            }
            let metadata = std::fs::symlink_metadata(path)
                .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
            let entry_type = if metadata.file_type().is_symlink() {
                "symlink"
            } else if metadata.is_dir() {
                "directory"
            } else if metadata.is_file() {
                "file"
            } else {
                continue;
            };
            let relative = path.strip_prefix(&root).unwrap();
            let relative_text = relative.to_string_lossy().replace('\\', "/");
            if !glob.is_match(&relative_text)
                || (kind != FindType::Any
                    && !(kind == FindType::File && entry_type == "file")
                    && !(kind == FindType::Directory && entry_type == "directory"))
            {
                continue;
            }
            let display = if requested.raw == "./" {
                format!("./{relative_text}")
            } else {
                format!("{}/{}", requested.raw.trim_end_matches('/'), relative_text)
            };
            entries.push(FileFindEntry {
                path: display,
                entry_type: entry_type.to_string(),
            });
        }
        entries.sort_by(|left, right| left.path.cmp(&right.path));
        let next_cursor = if entries.len() > offset.saturating_add(limit) {
            Some(
                self.state
                    .cursors
                    .lock()
                    .unwrap()
                    .issue(&query, offset + limit),
            )
        } else {
            None
        };
        let entries = entries.into_iter().skip(offset).take(limit).collect();
        serde_json::to_value(FileFindOutput {
            entries,
            next_cursor,
        })
        .map_err(|error| ToolError::new("tool.internalError", error.to_string()))
    }
}
