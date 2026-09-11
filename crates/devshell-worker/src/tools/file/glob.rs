use std::sync::Arc;

use crate::tools::file::FileToolState;
use crate::tools::file::discover::{DiscoveredEntry, DiscoveryCursor};
use crate::tools::file::types::{
    FileEntryType, FileGlobEntry, FileGlobInput, FileGlobOutput, GlobType,
};
use crate::tools::{ToolCall, ToolCapability, ToolCatalogEntry, ToolError, ToolHandler, ToolName};

const PAGE_SIZE: usize = 200;

#[derive(Clone)]
pub(crate) struct GlobContinuation {
    discovery: DiscoveryCursor,
    pending: Option<DiscoveredEntry>,
    kind: GlobType,
}

pub struct FileGlobTool {
    name: ToolName,
    state: Arc<FileToolState>,
}
impl FileGlobTool {
    pub fn new(state: Arc<FileToolState>) -> Self {
        Self {
            name: ToolName::parse("file_glob").unwrap(),
            state,
        }
    }
}
impl ToolHandler for FileGlobTool {
    fn name(&self) -> &ToolName {
        &self.name
    }
    fn catalog_entry(&self) -> ToolCatalogEntry {
        crate::tools::contract::catalog_entry::<FileGlobInput, FileGlobOutput>(
            &self.name,
            "Find files and directories by exact path or glob pattern. Start with patterns; continue result pages with cursor alone. When cursor is present, omit patterns, type, hidden, and gitignore. Use ./ for workspace-relative paths and / for absolute paths.".to_string(),
            [ToolCapability::Read],
        )
    }
    fn call(&self, call: ToolCall) -> Result<serde_json::Value, ToolError> {
        call.check_cancelled()?;
        let input: FileGlobInput = call.parse_params()?;
        let (mut continuation, source_cursor) = if let Some(cursor) = input.cursor {
            if input.patterns.is_some()
                || input.entry_type.is_some()
                || input.hidden.is_some()
                || input.gitignore.is_some()
            {
                return Err(ToolError::new(
                    "tool.invalidArguments",
                    "cursor must be provided alone when continuing file_glob",
                ));
            }
            let continuation = self
                .state
                .glob_cursors
                .lock()
                .unwrap()
                .resolve(&call, &cursor)?;
            (continuation, Some(cursor))
        } else {
            let patterns = input.patterns.ok_or_else(|| {
                ToolError::new(
                    "tool.invalidArguments",
                    "patterns is required when starting file_glob",
                )
            })?;
            if patterns.is_empty() {
                return Err(ToolError::new(
                    "tool.invalidArguments",
                    "patterns cannot be empty",
                ));
            }
            (
                GlobContinuation {
                    discovery: DiscoveryCursor::new(
                        &call,
                        &patterns,
                        input.hidden.unwrap_or(true),
                        input.gitignore.unwrap_or(true),
                    )?,
                    pending: None,
                    kind: input.entry_type.unwrap_or(GlobType::Any),
                },
                None,
            )
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
            self.state.glob_cursors.lock().unwrap().issue(
                &call,
                continuation,
                source_cursor.clone(),
            )
        });
        crate::tools::contract::serialize(FileGlobOutput {
            entries,
            next_cursor,
        })
    }
}

fn next_matching(
    call: &ToolCall,
    continuation: &mut GlobContinuation,
) -> Result<Option<DiscoveredEntry>, ToolError> {
    if continuation.pending.is_some() {
        return Ok(continuation.pending.take());
    }
    while let Some(entry) = continuation.discovery.next(call)? {
        let matches = match continuation.kind {
            GlobType::Any => entry.entry_type != "other",
            GlobType::File => entry.entry_type == "file",
            GlobType::Directory => entry.entry_type == "directory",
        };
        if matches {
            return Ok(Some(entry));
        }
    }
    Ok(None)
}

fn render_entry(entry: DiscoveredEntry) -> FileGlobEntry {
    FileGlobEntry {
        path: entry.display,
        entry_type: match entry.entry_type {
            "file" => FileEntryType::File,
            "directory" => FileEntryType::Directory,
            "symlink" => FileEntryType::Symlink,
            _ => FileEntryType::Other,
        },
    }
}
