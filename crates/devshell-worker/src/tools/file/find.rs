use std::sync::Arc;

use crate::tools::file::FileToolState;
use crate::tools::file::discover::{DiscoveredEntry, DiscoveryCursor};
use crate::tools::file::types::{FileFindEntry, FileFindInput, FileFindOutput, FindType};
use crate::tools::{ToolCall, ToolCapability, ToolCatalogEntry, ToolError, ToolHandler, ToolName};

const PAGE_SIZE: usize = 200;

#[derive(Clone)]
pub(crate) struct FindContinuation {
    discovery: DiscoveryCursor,
    pending: Option<DiscoveredEntry>,
    kind: FindType,
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
        let mut continuation = if let Some(cursor) = input.cursor.as_deref() {
            if input.paths.is_some()
                || input.entry_type.is_some()
                || input.hidden.is_some()
                || input.gitignore.is_some()
            {
                return Err(ToolError::new(
                    "tool.invalidArguments",
                    "cursor continuation must be used without paths, type, hidden, or gitignore",
                ));
            }
            self.state
                .find_cursors
                .lock()
                .unwrap()
                .resolve(&call, cursor)?
        } else {
            let paths = input.paths.ok_or_else(|| {
                ToolError::new("tool.invalidArguments", "paths are required without cursor")
            })?;
            let hidden = input.hidden.unwrap_or(true);
            let gitignore = input.gitignore.unwrap_or(true);
            let kind = input.entry_type.unwrap_or(FindType::Any);
            FindContinuation {
                discovery: DiscoveryCursor::new(&call, &paths, hidden, gitignore)?,
                pending: None,
                kind,
            }
        };

        let mut entries = Vec::with_capacity(PAGE_SIZE);
        while entries.len() < PAGE_SIZE {
            call.check_cancelled()?;
            let Some(entry) = next_matching(&call, &mut continuation)? else {
                break;
            };
            entries.push(render_entry(entry));
        }

        if entries.len() == PAGE_SIZE && continuation.pending.is_none() {
            continuation.pending = next_matching(&call, &mut continuation)?;
        }
        let next_cursor = continuation.pending.is_some().then(|| {
            self.state
                .find_cursors
                .lock()
                .unwrap()
                .issue(&call, continuation)
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
) -> Result<Option<DiscoveredEntry>, ToolError> {
    if continuation.pending.is_some() {
        return Ok(continuation.pending.take());
    }
    while let Some(entry) = continuation.discovery.next(call)? {
        let matches = match continuation.kind {
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
