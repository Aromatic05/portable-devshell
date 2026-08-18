use std::sync::Arc;

use serde_json::json;

use crate::tools::file::FileToolState;
use crate::tools::file::discover::{DiscoveredEntry, DiscoveryCursor};
use crate::tools::file::types::{FileFindEntry, FileFindInput, FileFindOutput, FindType};
use crate::tools::{ToolCall, ToolCapability, ToolCatalogEntry, ToolError, ToolHandler, ToolName};

const PAGE_SIZE: usize = 200;

#[derive(Clone)]
pub(crate) struct FindContinuation {
    discovery: DiscoveryCursor,
    pending: Option<DiscoveredEntry>,
}

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
        crate::tools::contract::catalog_entry::<FileFindInput, FileFindOutput>(
            &self.name,
            "Find files and directories by exact path or glob.".to_string(),
            [ToolCapability::Read],
        )
    }
    fn call(&self, call: ToolCall) -> Result<serde_json::Value, ToolError> {
        call.check_cancelled()?;
        let input: FileFindInput = call.parse_params()?;
        let hidden = input.hidden.unwrap_or(true);
        let gitignore = input.gitignore.unwrap_or(true);
        let kind = input.entry_type.unwrap_or(FindType::Any);
        let query =
            json!({ "paths": input.paths, "type": kind, "hidden": hidden, "gitignore": gitignore });
        let mut continuation = if let Some(cursor) = input.cursor.as_deref() {
            self.state
                .find_cursors
                .lock()
                .unwrap()
                .resolve(&call, cursor, &query)?
        } else {
            FindContinuation {
                discovery: DiscoveryCursor::new(
                    &call,
                    query["paths"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|value| value.as_str().unwrap().to_string())
                        .collect::<Vec<_>>()
                        .as_slice(),
                    hidden,
                    gitignore,
                )?,
                pending: None,
            }
        };

        let mut entries = Vec::with_capacity(PAGE_SIZE);
        while entries.len() < PAGE_SIZE {
            call.check_cancelled()?;
            let Some(entry) = next_matching(&call, &mut continuation, &kind)? else {
                break;
            };
            entries.push(render_entry(entry));
        }

        if entries.len() == PAGE_SIZE && continuation.pending.is_none() {
            continuation.pending = next_matching(&call, &mut continuation, &kind)?;
        }
        let next_cursor = continuation.pending.is_some().then(|| {
            self.state
                .find_cursors
                .lock()
                .unwrap()
                .issue(&call, &query, continuation)
        });
        crate::tools::contract::serialize(FileFindOutput {
            entries,
            next_cursor,
        })
    }
}

fn next_matching(
    call: &ToolCall,
    continuation: &mut FindContinuation,
    kind: &FindType,
) -> Result<Option<DiscoveredEntry>, ToolError> {
    if continuation.pending.is_some() {
        return Ok(continuation.pending.take());
    }
    while let Some(entry) = continuation.discovery.next(call)? {
        let matches = match kind {
            FindType::Any => entry.entry_type != "other",
            FindType::File => entry.entry_type == "file",
            FindType::Directory => entry.entry_type == "directory",
        };
        if matches {
            return Ok(Some(entry));
        }
    }
    Ok(None)
}

fn render_entry(entry: DiscoveredEntry) -> FileFindEntry {
    FileFindEntry {
        path: entry.display,
        entry_type: entry.entry_type.to_string(),
    }
}
