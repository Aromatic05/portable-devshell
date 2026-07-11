use std::sync::Arc;

use schemars::schema_for;
use serde_json::json;

use crate::tools::file::FileToolState;
use crate::tools::file::discover::discover;
use crate::tools::file::types::{FileFindEntry, FileFindInput, FileFindOutput, FindType};
use crate::tools::{ToolAccess, ToolCall, ToolCatalogEntry, ToolError, ToolHandler, ToolName};

const PAGE_SIZE: usize = 200;

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
        ToolCatalogEntry { name: self.name.as_str(), description: "Find exact paths, directories, and globs. Hidden development files are included by default; .git is always excluded.".to_string(), input_schema: serde_json::to_value(schema_for!(FileFindInput)).unwrap(), output_schema: serde_json::to_value(schema_for!(FileFindOutput)).unwrap(), access: ToolAccess::Read }
    }
    fn call(&self, call: ToolCall) -> Result<serde_json::Value, ToolError> {
        let input: FileFindInput = serde_json::from_value(call.params.clone())
            .map_err(|error| ToolError::new("tool.invalidArguments", error.to_string()))?;
        let hidden = input.hidden.unwrap_or(true);
        let gitignore = input.gitignore.unwrap_or(true);
        let kind = input.entry_type.unwrap_or(FindType::Any);
        let query =
            json!({ "paths": input.paths, "type": kind, "hidden": hidden, "gitignore": gitignore });
        let offset = input.cursor.as_deref().map_or(Ok(0), |cursor| {
            self.state.cursors.lock().unwrap().resolve(cursor, &query)
        })?;
        let entries = discover(
            &call,
            query["paths"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_string())
                .collect::<Vec<_>>()
                .as_slice(),
            hidden,
            gitignore,
        )?
        .into_iter()
        .filter(|entry| match kind {
            FindType::Any => entry.entry_type != "other",
            FindType::File => entry.entry_type == "file",
            FindType::Directory => entry.entry_type == "directory",
        })
        .map(|entry| FileFindEntry {
            path: entry.display,
            entry_type: entry.entry_type.to_string(),
        })
        .collect::<Vec<_>>();
        let next_cursor = (entries.len() > offset + PAGE_SIZE).then(|| {
            self.state
                .cursors
                .lock()
                .unwrap()
                .issue(&query, offset + PAGE_SIZE)
        });
        let entries = entries
            .into_iter()
            .skip(offset)
            .take(PAGE_SIZE)
            .collect::<Vec<_>>();
        let content = render_tree(&entries);
        serde_json::to_value(FileFindOutput {
            entries,
            content,
            next_cursor,
        })
        .map_err(|error| ToolError::new("tool.internalError", error.to_string()))
    }
}
fn render_tree(entries: &[FileFindEntry]) -> String {
    entries
        .iter()
        .map(|entry| {
            format!(
                "{}{}",
                entry.path,
                if entry.entry_type == "directory" {
                    "/"
                } else {
                    ""
                }
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}
