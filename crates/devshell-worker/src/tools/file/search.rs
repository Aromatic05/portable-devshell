use std::collections::{BTreeMap, HashSet, VecDeque};
use std::fs;
use std::io::{BufRead, BufReader};
use std::sync::Arc;

use regex::RegexBuilder;
use schemars::schema_for;
use serde_json::json;

use crate::tools::file::FileToolState;
use crate::tools::file::discover::discover;
use crate::tools::file::state::{FULL_SNAPSHOT_LIMIT, TextFile, TextMetadata};
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
        let mut discovered_groups = paths
            .iter()
            .map(|path| {
                discover(&call, std::slice::from_ref(path), hidden, gitignore).map(|entries| {
                    entries
                        .into_iter()
                        .filter(|entry| entry.entry_type == "file")
                        .collect::<Vec<_>>()
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut seen_candidates = HashSet::new();
        for group in &mut discovered_groups {
            group.retain(|entry| seen_candidates.insert(entry.path.clone()));
        }
        let file_count = discovered_groups.iter().map(Vec::len).sum::<usize>();
        let per_file = if file_count == 1 {
            SINGLE_FILE_MATCHES
        } else {
            MATCHES_PER_FILE
        };

        let mut matched_groups = Vec::with_capacity(discovered_groups.len());
        for group in discovered_groups {
            let mut matched = VecDeque::new();
            for entry in group {
                let Ok((metadata, matches, shown)) =
                    search_stream(&entry.path, &matcher, per_file, context)
                else {
                    continue;
                };
                if matches.is_empty() {
                    continue;
                }
                let (body, seen) = format_streamed_content(&matches, &shown);
                let snapshot = if metadata.total_bytes <= FULL_SNAPSHOT_LIMIT {
                    let Ok(text) = TextFile::read(&entry.path) else {
                        continue;
                    };
                    self.state
                        .snapshots
                        .lock()
                        .unwrap()
                        .remember(&entry.path, &text, seen)
                } else {
                    self.state.snapshots.lock().unwrap().remember_sparse(
                        &entry.path,
                        &metadata,
                        seen,
                    )
                };
                let content = format!("[{}#{}]\n{}", entry.display, snapshot.tag, body);
                matched.push_back(FileSearchFile {
                    path: entry.display,
                    snapshot_id: snapshot.id,
                    snapshot_tag: snapshot.tag,
                    revision: metadata.revision,
                    content,
                    match_count: matches.len(),
                });
            }
            matched_groups.push(matched);
        }

        let mut files = Vec::new();
        loop {
            let mut progressed = false;
            for group in &mut matched_groups {
                if let Some(file) = group.pop_front() {
                    files.push(file);
                    progressed = true;
                }
            }
            if !progressed {
                break;
            }
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

fn search_stream(
    path: &std::path::Path,
    matcher: &regex::Regex,
    limit: usize,
    context: Option<usize>,
) -> Result<(TextMetadata, Vec<usize>, BTreeMap<usize, String>), ToolError> {
    let metadata = TextMetadata::inspect(path)?;
    let file =
        fs::File::open(path).map_err(|error| ToolError::new("file.notFound", error.to_string()))?;
    let mut reader = BufReader::new(file);
    let (before, after) = context.map_or((1usize, 3usize), |value| (value, value));
    let mut previous = VecDeque::<(usize, String)>::new();
    let mut shown = BTreeMap::new();
    let mut matches = Vec::new();
    let mut pending_after = 0usize;
    let mut buffer = Vec::new();
    let mut line_no = 0usize;
    loop {
        buffer.clear();
        if reader
            .read_until(b'\n', &mut buffer)
            .map_err(|error| ToolError::new("file.readFailed", error.to_string()))?
            == 0
        {
            break;
        }
        line_no += 1;
        let mut content = buffer.as_slice();
        if line_no == 1 && content.starts_with(&[0xEF, 0xBB, 0xBF]) {
            content = &content[3..];
        }
        content = content.strip_suffix(b"\n").unwrap_or(content);
        content = content.strip_suffix(b"\r").unwrap_or(content);
        let line = std::str::from_utf8(content)
            .map_err(|_| ToolError::new("file.notText", "file is not valid UTF-8"))?
            .to_string();
        let is_match = matches.len() < limit && matcher.is_match(&line);
        if is_match {
            for (number, value) in &previous {
                shown.entry(*number).or_insert_with(|| value.clone());
            }
            shown.insert(line_no, line.clone());
            matches.push(line_no);
            pending_after = after;
        } else if pending_after > 0 {
            shown.insert(line_no, line.clone());
            pending_after -= 1;
        }
        previous.push_back((line_no, line));
        while previous.len() > before {
            previous.pop_front();
        }
        if matches.len() == limit && pending_after == 0 {
            break;
        }
    }
    Ok((metadata, matches, shown))
}

fn format_streamed_content(
    matches: &[usize],
    shown: &BTreeMap<usize, String>,
) -> (String, Vec<usize>) {
    let mut output = Vec::new();
    let mut seen = Vec::new();
    let mut previous = 0usize;
    for (line, raw) in shown {
        if previous > 0 && *line > previous + 1 {
            output.push("...".to_string());
        }
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
