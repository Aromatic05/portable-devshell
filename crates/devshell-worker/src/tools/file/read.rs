use std::sync::Arc;

use schemars::schema_for;

use crate::tools::file::state::TextFile;
use crate::tools::file::types::{FileReadInput, FileReadOutput, ReturnedRange};
use crate::tools::file::{FileToolState, resolve_existing};
use crate::tools::{ToolAccess, ToolCall, ToolCatalogEntry, ToolError, ToolHandler, ToolName};

pub struct FileReadTool { name: ToolName, state: Arc<FileToolState> }
impl FileReadTool { pub fn new(state: Arc<FileToolState>) -> Self { Self { name: ToolName::parse("file_read").unwrap(), state } } }
impl ToolHandler for FileReadTool {
    fn name(&self) -> &ToolName { &self.name }
    fn catalog_entry(&self) -> ToolCatalogEntry { ToolCatalogEntry { name: self.name.as_str(), description: "Read UTF-8 text files with anchored line numbers.".to_string(), input_schema: serde_json::to_value(schema_for!(FileReadInput)).unwrap(), output_schema: serde_json::to_value(schema_for!(FileReadOutput)).unwrap(), access: ToolAccess::Read } }
    fn call(&self, call: ToolCall) -> Result<serde_json::Value, ToolError> {
        let input: FileReadInput = serde_json::from_value(call.params.clone()).map_err(|error| ToolError::new("tool.invalidArguments", error.to_string()))?;
        let (requested, path) = resolve_existing(&call, &input.path, false)?;
        if !path.is_file() { return Err(ToolError::new("file.notFile", "path is not a file")); }
        let text = TextFile::read(&path)?;
        let ranges = validate_ranges(input.ranges.as_deref(), text.lines.len())?;
        let default_read = input.ranges.is_none();
        let ranges = if default_read && !text.lines.is_empty() { vec![(1, text.lines.len().min(200))] } else { ranges };
        let mut content = String::new(); let mut returned = Vec::new(); let mut seen = Vec::new();
        for (start, end) in ranges {
            if start > end { continue; }
            if !content.is_empty() { content.push('\n'); }
            for line_no in start..=end { content.push_str(&format!("{line_no}:{}", text.lines[line_no - 1])); if line_no != end { content.push('\n'); } seen.push(line_no); }
            returned.push(ReturnedRange { start_line: start, end_line: end });
        }
        let snapshot_id = self.state.snapshots.lock().unwrap().remember(&path, &text, seen);
        serde_json::to_value(FileReadOutput { path: requested.raw, snapshot_id, revision: text.revision, content, returned_ranges: returned, total_lines: text.lines.len(), total_bytes: text.total_bytes, truncated: default_read && text.lines.len() > 200, next_start_line: if default_read && text.lines.len() > 200 { Some(201) } else { None } }).map_err(|error| ToolError::new("tool.internalError", error.to_string()))
    }
}
fn validate_ranges(ranges: Option<&[crate::tools::file::types::LineRange]>, total: usize) -> Result<Vec<(usize, usize)>, ToolError> {
    let Some(ranges) = ranges else { return Ok(Vec::new()) };
    if ranges.len() > 16 { return Err(ToolError::new("file.invalidRange", "at most 16 ranges are allowed")); }
    let mut result = Vec::new(); let mut previous_end = 0;
    for range in ranges { if range.start_line == 0 || range.line_count == 0 || range.start_line <= previous_end { return Err(ToolError::new("file.invalidRange", "ranges must be positive, sorted, and non-overlapping")); } let end = range.start_line.saturating_add(range.line_count - 1).min(total); if range.start_line <= total { result.push((range.start_line, end)); previous_end = end; } }
    Ok(result)
}
