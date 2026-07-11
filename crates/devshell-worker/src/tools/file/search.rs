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
const MAX_SERIALIZED_OUTPUT_BYTES: usize = 1024 * 1024;

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
                let Ok((metadata, full_text, matches, shown)) =
                    search_stream(&entry.path, &matcher, per_file, context)
                else {
                    continue;
                };
                if matches.is_empty() {
                    continue;
                }
                let (body, seen) = format_streamed_content(&matches, &shown);
                let snapshot = if let Some(text) = full_text {
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
        let total_files = files.len();
        let mut page = Vec::new();
        for file in files.into_iter().skip(offset).take(FILES_PER_PAGE) {
            let mut candidate = page.clone();
            candidate.push(file.clone());
            let probe = FileSearchOutput {
                files: candidate,
                next_cursor: Some("00000000-0000-0000-0000-000000000000".to_string()),
            };
            let serialized = serde_json::to_vec(&probe)
                .map_err(|error| ToolError::new("tool.internalError", error.to_string()))?;
            if serialized.len() > MAX_SERIALIZED_OUTPUT_BYTES {
                if page.is_empty() {
                    return Err(ToolError::new(
                        "file.outputTooLarge",
                        "one search result file exceeds the serialized output budget",
                    ));
                }
                break;
            }
            page.push(file);
        }
        let consumed = page.len();
        let next_cursor = (total_files > offset + consumed).then(|| {
            self.state
                .cursors
                .lock()
                .unwrap()
                .issue(&query, offset + consumed)
        });
        serde_json::to_value(FileSearchOutput {
            files: page,
            next_cursor,
        })
        .map_err(|error| ToolError::new("tool.internalError", error.to_string()))
    }
}

fn search_stream(
    path: &std::path::Path,
    matcher: &regex::Regex,
    limit: usize,
    context: Option<usize>,
) -> Result<
    (
        TextMetadata,
        Option<TextFile>,
        Vec<usize>,
        BTreeMap<usize, String>,
    ),
    ToolError,
> {
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
    let mut hasher = blake3::Hasher::new();
    let mut total_bytes = 0usize;
    let mut total_lines = 0usize;
    let mut bom = false;
    let mut first = true;
    let mut final_newline = false;
    let mut line_ending = "\n";
    let mut full_lines = Some(Vec::new());
    loop {
        buffer.clear();
        let count = reader
            .read_until(b'\n', &mut buffer)
            .map_err(|error| ToolError::new("file.readFailed", error.to_string()))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer);
        total_bytes += count;
        if total_bytes > FULL_SNAPSHOT_LIMIT {
            full_lines = None;
        }
        if buffer.contains(&0) {
            return Err(ToolError::new("file.notText", "file contains NUL bytes"));
        }
        line_no += 1;
        let had_newline = buffer.last() == Some(&b'\n');
        let mut content = buffer.as_slice();
        if first && content.starts_with(&[0xEF, 0xBB, 0xBF]) {
            bom = true;
            content = &content[3..];
        }
        first = false;
        let without_lf = content.strip_suffix(b"\n").unwrap_or(content);
        let without_eol = without_lf.strip_suffix(b"\r").unwrap_or(without_lf);
        let line = std::str::from_utf8(without_eol)
            .map_err(|_| ToolError::new("file.notText", "file is not valid UTF-8"))?
            .to_string();
        if had_newline || !without_eol.is_empty() {
            total_lines += 1;
        }
        if had_newline && total_lines == 1 {
            line_ending = if without_lf.len() != without_eol.len() {
                "\r\n"
            } else {
                "\n"
            };
        }
        final_newline = had_newline;
        if let Some(lines) = &mut full_lines {
            lines.push(line.clone());
        }

        if matches.len() < limit {
            let is_match = matcher.is_match(&line);
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
        } else if pending_after > 0 {
            shown.insert(line_no, line);
            pending_after -= 1;
        }
    }
    let revision = hasher.finalize().to_hex().to_string();
    let metadata = TextMetadata {
        bom,
        final_newline,
        line_ending,
        revision: revision.clone(),
        total_bytes,
        total_lines,
    };
    let full_text = full_lines.map(|lines| TextFile {
        bom,
        final_newline,
        line_ending,
        lines,
        revision,
        total_bytes,
    });
    Ok((metadata, full_text, matches, shown))
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
