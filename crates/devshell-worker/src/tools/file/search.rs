use std::fs;
use std::path::Path;
use std::sync::Arc;

use regex::{Regex, RegexBuilder};
use schemars::schema_for;

use crate::tools::file::state::TextFile;
use crate::tools::file::types::{FileSearchFile, FileSearchInput, FileSearchOutput, SearchSyntax};
use crate::tools::file::{FileToolState, resolve_existing};
use crate::tools::{ToolAccess, ToolCall, ToolCatalogEntry, ToolError, ToolHandler, ToolName};

pub struct FileSearchTool { name: ToolName, state: Arc<FileToolState> }
impl FileSearchTool { pub fn new(state: Arc<FileToolState>) -> Self { Self { name: ToolName::parse("file_search").unwrap(), state } } }
impl ToolHandler for FileSearchTool {
    fn name(&self) -> &ToolName { &self.name }
    fn catalog_entry(&self) -> ToolCatalogEntry { ToolCatalogEntry { name: self.name.as_str(), description: "Search UTF-8 text files and return anchored match context.".to_string(), input_schema: serde_json::to_value(schema_for!(FileSearchInput)).unwrap(), output_schema: serde_json::to_value(schema_for!(FileSearchOutput)).unwrap(), access: ToolAccess::Read } }
    fn call(&self, call: ToolCall) -> Result<serde_json::Value, ToolError> {
        let input: FileSearchInput = serde_json::from_value(call.params.clone()).map_err(|error| ToolError::new("tool.invalidArguments", error.to_string()))?;
        let root_raw = input.path.unwrap_or_else(|| "./".to_string()); let (requested, root) = resolve_existing(&call, &root_raw, false)?; if !root.is_dir() { return Err(ToolError::new("file.notDirectory", "search root is not a directory")); }
        let case_sensitive = input.case_sensitive.unwrap_or(true); let expression = match input.syntax.unwrap_or(SearchSyntax::Regex) { SearchSyntax::Literal => regex::escape(&input.pattern), SearchSyntax::Regex => input.pattern }; let matcher = RegexBuilder::new(&expression).case_insensitive(!case_sensitive).build().map_err(|error| ToolError::new("file.invalidRegex", error.to_string()))?;
        let context = input.context.unwrap_or(0); if context > 20 { return Err(ToolError::new("file.invalidArguments", "context cannot exceed 20")); } let max_files = input.max_files.unwrap_or(20).min(100); let max_matches = input.max_matches_per_file.unwrap_or(20).min(200); let mut paths = Vec::new(); collect_files(&root, &mut paths)?; paths.sort(); let offset = input.cursor.as_deref().map(|value| value.parse::<usize>().map_err(|_| ToolError::new("file.invalidCursor", "invalid cursor"))).transpose()?.unwrap_or(0);
        let mut files = Vec::new(); for path in paths.into_iter().skip(offset) { if files.len() == max_files { break; } let Ok(text) = TextFile::read(&path) else { continue }; let matches = text.lines.iter().enumerate().filter_map(|(index, line)| matcher.is_match(line).then_some(index + 1)).take(max_matches).collect::<Vec<_>>(); if matches.is_empty() { continue; } let mut shown = std::collections::BTreeSet::new(); for line in &matches { for candidate in line.saturating_sub(context)..=(*line + context).min(text.lines.len()) { if candidate > 0 { shown.insert(candidate); } } } let mut content = String::new(); let mut previous = 0; for line in shown { if previous > 0 && line > previous + 1 { content.push_str("...\n"); } content.push(if matches.contains(&line) { '*' } else { ' ' }); content.push_str(&format!("{line}:{}\n", text.lines[line - 1])); previous = line; } content.pop(); let snapshot_id = self.state.snapshots.lock().unwrap().remember(&path, &text, shown_from_content(&content)); let relative = path.strip_prefix(&root).unwrap(); let display = if requested.raw == "./" { format!("./{}", relative.display()) } else { format!("{}/{}", requested.raw.trim_end_matches('/'), relative.display()) }; files.push(FileSearchFile { path: display.replace('\\', "/"), snapshot_id, revision: text.revision, content, match_count: matches.len() }); }
        serde_json::to_value(FileSearchOutput { files, next_cursor: None }).map_err(|error| ToolError::new("tool.internalError", error.to_string()))
    }
}
fn collect_files(current: &Path, files: &mut Vec<std::path::PathBuf>) -> Result<(), ToolError> { for entry in fs::read_dir(current).map_err(|error| ToolError::new("file.notDirectory", error.to_string()))? { let entry = entry.map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?; let path = entry.path(); let metadata = fs::symlink_metadata(&path).map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?; if metadata.is_file() { files.push(path); } else if metadata.is_dir() && !metadata.file_type().is_symlink() { collect_files(&path, files)?; } } Ok(()) }
fn shown_from_content(content: &str) -> Vec<usize> { content.lines().filter_map(|line| line.get(1..)?.split_once(':')?.0.parse().ok()).collect() }
