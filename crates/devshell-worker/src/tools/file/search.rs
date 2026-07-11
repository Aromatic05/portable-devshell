use std::collections::{BTreeSet, HashSet, VecDeque};
use std::sync::Arc;

use regex::RegexBuilder;
use schemars::schema_for;
use serde_json::json;

use crate::tools::file::FileToolState;
use crate::tools::file::discover::discover;
use crate::tools::file::state::TextFile;
use crate::tools::file::types::{FileSearchFile, FileSearchInput, FileSearchOutput, SearchSyntax};
use crate::tools::{ToolAccess, ToolCall, ToolCatalogEntry, ToolError, ToolHandler, ToolName};

const FILES_PER_PAGE: usize = 20;
const MATCHES_PER_FILE: usize = 20;
const SINGLE_FILE_MATCHES: usize = 200;
const MAX_RENDERED_LINE_BYTES: usize = 4096;

pub struct FileSearchTool {
    name: ToolName,
    state: Arc<FileToolState>,
}
impl FileSearchTool {
    pub fn new(state: Arc<FileToolState>) -> Self {
        Self {
            name: ToolName::parse("file_search").unwrap(),
            state,
        }
    }
}
impl ToolHandler for FileSearchTool {
    fn name(&self) -> &ToolName {
        &self.name
    }
    fn catalog_entry(&self) -> ToolCatalogEntry {
        ToolCatalogEntry { name: self.name.as_str(), description: "Search text within exact paths, directories, and globs, returning copyable snapshot headers and edit anchors.".to_string(), input_schema: serde_json::to_value(schema_for!(FileSearchInput)).unwrap(), output_schema: serde_json::to_value(schema_for!(FileSearchOutput)).unwrap(), access: ToolAccess::Read }
    }
    fn call(&self, call: ToolCall) -> Result<serde_json::Value, ToolError> {
        let input: FileSearchInput = serde_json::from_value(call.params.clone())
            .map_err(|error| ToolError::new("tool.invalidArguments", error.to_string()))?;
        let paths = input.paths.unwrap_or_else(|| vec!["./".to_string()]);
        let syntax = input.syntax.unwrap_or(SearchSyntax::Regex);
        let case_sensitive = input.case_sensitive.unwrap_or(true);
        let expression = match syntax {
            SearchSyntax::Literal => regex::escape(&input.pattern),
            SearchSyntax::Regex => input.pattern,
        };
        let matcher = RegexBuilder::new(&expression)
            .case_insensitive(!case_sensitive)
            .build()
            .map_err(|error| ToolError::new("file.invalidRegex", error.to_string()))?;
        let hidden = input.hidden.unwrap_or(true);
        let gitignore = input.gitignore.unwrap_or(true);
        let context = input.context;
        if context.is_some_and(|value| value > 20) {
            return Err(ToolError::new(
                "tool.invalidArguments",
                "context cannot exceed 20",
            ));
        }
        let query = json!({ "pattern": expression, "paths": paths, "caseSensitive": case_sensitive, "hidden": hidden, "gitignore": gitignore, "context": context });
        let offset = input.cursor.as_deref().map_or(Ok(0), |cursor| {
            self.state.cursors.lock().unwrap().resolve(cursor, &query)
        })?;
        let discovered = discover_round_robin(&call, &paths, hidden, gitignore)?;
        let file_count = discovered.len();
        let per_file = if file_count == 1 {
            SINGLE_FILE_MATCHES
        } else {
            MATCHES_PER_FILE
        };
        let mut files = Vec::new();
        for entry in discovered {
            let Ok(text) = TextFile::read(&entry.path) else {
                continue;
            };
            let matches = text
                .lines
                .iter()
                .enumerate()
                .filter_map(|(index, line)| matcher.is_match(line).then_some(index + 1))
                .take(per_file)
                .collect::<Vec<_>>();
            if matches.is_empty() {
                continue;
            }
            let shown = shown_lines(&matches, text.lines.len(), context);
            let (body, seen) = format_content(&text.lines, &matches, &shown);
            let snapshot = self
                .state
                .snapshots
                .lock()
                .unwrap()
                .remember(&entry.path, &text, seen);
            let content = format!("[{}#{}]\n{}", entry.display, snapshot.tag, body);
            files.push(FileSearchFile {
                path: entry.display,
                snapshot_id: snapshot.id,
                snapshot_tag: snapshot.tag,
                revision: text.revision,
                content,
                match_count: matches.len(),
            });
        }
        let next_cursor = (files.len() > offset + FILES_PER_PAGE).then(|| {
            self.state
                .cursors
                .lock()
                .unwrap()
                .issue(&query, offset + FILES_PER_PAGE)
        });
        let files = files
            .into_iter()
            .skip(offset)
            .take(FILES_PER_PAGE)
            .collect();
        serde_json::to_value(FileSearchOutput { files, next_cursor })
            .map_err(|error| ToolError::new("tool.internalError", error.to_string()))
    }
}

fn discover_round_robin(
    call: &ToolCall,
    paths: &[String],
    hidden: bool,
    gitignore: bool,
) -> Result<Vec<crate::tools::file::discover::DiscoveredEntry>, ToolError> {
    let mut groups = paths
        .iter()
        .map(|path| {
            discover(call, std::slice::from_ref(path), hidden, gitignore).map(|entries| {
                entries
                    .into_iter()
                    .filter(|entry| entry.entry_type == "file")
                    .collect::<VecDeque<_>>()
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    loop {
        let mut progressed = false;
        for group in &mut groups {
            while let Some(entry) = group.pop_front() {
                if seen.insert(entry.display.clone()) {
                    result.push(entry);
                    progressed = true;
                    break;
                }
            }
        }
        if !progressed {
            break;
        }
    }
    Ok(result)
}

fn shown_lines(matches: &[usize], total: usize, context: Option<usize>) -> Vec<usize> {
    let (before, after) = context.map_or((1, 3), |value| (value, value));
    let mut shown = BTreeSet::new();
    for line in matches {
        for candidate in line.saturating_sub(before)..=(*line + after).min(total) {
            if candidate > 0 {
                shown.insert(candidate);
            }
        }
    }
    shown.into_iter().collect()
}
fn format_content(lines: &[String], matches: &[usize], shown: &[usize]) -> (String, Vec<usize>) {
    let mut output = Vec::new();
    let mut seen = Vec::new();
    let mut previous = 0;
    for line in shown {
        if previous > 0 && *line > previous + 1 {
            output.push("...".to_string());
        }
        let raw = &lines[*line - 1];
        let (rendered, full) = truncate(raw);
        output.push(format!(
            "{}{line}:{rendered}",
            if matches.contains(line) { '*' } else { ' ' }
        ));
        if full {
            seen.push(*line);
        }
        previous = *line;
    }
    (output.join("\n"), seen)
}
fn truncate(value: &str) -> (String, bool) {
    if value.len() <= MAX_RENDERED_LINE_BYTES {
        return (value.to_string(), true);
    }
    let mut end = MAX_RENDERED_LINE_BYTES;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    (format!("{}…", &value[..end]), false)
}
