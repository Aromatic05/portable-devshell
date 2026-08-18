use std::collections::{BTreeMap, HashSet, VecDeque};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::sync::Arc;

use regex::RegexBuilder;

use crate::security::path::ResolvedPath;
use crate::tools::file::FileToolState;
use crate::tools::file::discover::DiscoveryCursor;
use crate::tools::file::resolve_existing;
use crate::tools::file::state::{FULL_SNAPSHOT_LIMIT, TextFile, TextMetadata};
use crate::tools::file::types::{FileSearchFile, FileSearchInput, FileSearchOutput, SearchSyntax};
use crate::tools::{ToolCall, ToolCapability, ToolCatalogEntry, ToolError, ToolHandler, ToolName};

const FILES_PER_PAGE: usize = 20;
const MATCHES_PER_FILE: usize = 20;
const SINGLE_FILE_MATCHES: usize = 200;
const MAX_RENDERED_LINE_BYTES: usize = 4096;
const MAX_SERIALIZED_OUTPUT_BYTES: usize = 1024 * 1024;

pub struct FileSearchTool {
    name: ToolName,
    state: Arc<FileToolState>,
}

#[derive(Clone)]
struct MatchedFile {
    output: FileSearchFile,
    resolved: ResolvedPath,
    metadata: TextMetadata,
    seen: Vec<usize>,
    ordinal: u64,
}

#[derive(Clone)]
struct PendingFile {
    path: String,
    resolved: ResolvedPath,
}

#[derive(Clone)]
struct SearchGroup {
    discovery: DiscoveryCursor,
    exhausted: bool,
}

#[derive(Clone)]
pub(crate) struct SearchContinuation {
    groups: Vec<SearchGroup>,
    next_group: usize,
    seen_candidates: HashSet<PathBuf>,
    pending: Option<PendingFile>,
    per_file: usize,
    matcher: regex::Regex,
    context: Option<usize>,
    start_line: usize,
}

enum PreparedSearchSnapshot {
    Full {
        path: PathBuf,
        text: TextFile,
        seen: Vec<usize>,
        ordinal: u64,
    },
    Sparse {
        path: PathBuf,
        metadata: TextMetadata,
        seen: Vec<usize>,
        ordinal: u64,
    },
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
        crate::tools::contract::catalog_entry::<FileSearchInput, FileSearchOutput>(
            &self.name,
            "Search UTF-8 text in files, directories, or globs. Use ./ for workspace-relative paths and / for absolute paths. Returned source lines prepare those lines for file_edit. Continue result pages with cursor alone. A cursor remains retryable until a later nextCursor derived from it is actually used. A truncated file includes nextLine; rerun the same search against that exact file with startLine=nextLine to continue its matches.".to_string(),
            [ToolCapability::Read],
        )
    }
    fn call(&self, call: ToolCall) -> Result<serde_json::Value, ToolError> {
        call.check_cancelled()?;
        let input: FileSearchInput = call.parse_params()?;
        let (mut continuation, source_cursor) = match input {
            FileSearchInput::Continue(input) => {
                let continuation = self
                    .state
                    .search_cursors
                    .lock()
                    .unwrap()
                    .resolve(&call, &input.cursor)?;
                (continuation, Some(input.cursor))
            }
            FileSearchInput::Start(input) => {
                let paths = input.paths.unwrap_or_else(|| vec!["./".to_string()]);
                if paths.is_empty() {
                    return Err(ToolError::new(
                        "tool.invalidArguments",
                        "paths must contain at least one path when provided",
                    ));
                }
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
                let single_exact_file = is_single_exact_file(&call, &paths)?;
                let start_line = input.start_line.unwrap_or(1);
                if start_line > 1 && !single_exact_file {
                    return Err(ToolError::new(
                        "tool.invalidArguments",
                        "startLine is only valid when paths contains one exact file",
                    ));
                }
                let groups = paths
                    .iter()
                    .map(|path| {
                        DiscoveryCursor::new(&call, std::slice::from_ref(path), hidden, gitignore)
                            .map(|discovery| SearchGroup {
                                discovery,
                                exhausted: false,
                            })
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                let per_file = if single_exact_file {
                    SINGLE_FILE_MATCHES
                } else {
                    MATCHES_PER_FILE
                };
                (
                    SearchContinuation {
                        groups,
                        next_group: 0,
                        seen_candidates: HashSet::new(),
                        pending: None,
                        per_file,
                        matcher,
                        context,
                        start_line,
                    },
                    None,
                )
            }
        };

        let mut page = Vec::<MatchedFile>::new();
        while page.len() < FILES_PER_PAGE {
            call.check_cancelled()?;
            let matched = next_page_file(&call, &mut continuation, &self.state)?;
            let Some(file) = matched else {
                break;
            };
            let candidate = page
                .iter()
                .map(|matched| matched.output.clone())
                .chain(std::iter::once(file.output.clone()))
                .collect();
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
                continuation.pending = Some(pending_file(file));
                break;
            }
            page.push(file);
        }

        if page.len() == FILES_PER_PAGE && continuation.pending.is_none() {
            continuation.pending =
                next_matched_file(&call, &mut continuation, &self.state)?.map(pending_file);
        }

        let has_more = continuation.pending.is_some()
            || continuation.groups.iter().any(|group| !group.exhausted);
        let mut returned = Vec::with_capacity(page.len());
        let mut prepared_snapshots = Vec::with_capacity(page.len());
        for matched in page {
            call.check_cancelled()?;
            if matched.metadata.total_bytes <= FULL_SNAPSHOT_LIMIT {
                let text = TextFile::read_file(
                    matched
                        .resolved
                        .open_file()
                        .map_err(|error| ToolError::new("file.notFound", error.to_string()))?,
                )?;
                if text.revision != matched.metadata.revision {
                    return Err(ToolError::retryable(
                        "file.revisionMismatch",
                        "file changed while search results were being prepared",
                    ));
                }
                prepared_snapshots.push(PreparedSearchSnapshot::Full {
                    path: matched.resolved.canonical.clone(),
                    text,
                    seen: matched.seen,
                    ordinal: matched.ordinal,
                });
            } else {
                let metadata = TextMetadata::inspect_file(
                    matched
                        .resolved
                        .open_file()
                        .map_err(|error| ToolError::new("file.notFound", error.to_string()))?,
                )?;
                if metadata.revision != matched.metadata.revision {
                    return Err(ToolError::retryable(
                        "file.revisionMismatch",
                        "file changed while search results were being prepared",
                    ));
                }
                prepared_snapshots.push(PreparedSearchSnapshot::Sparse {
                    path: matched.resolved.canonical.clone(),
                    metadata,
                    seen: matched.seen,
                    ordinal: matched.ordinal,
                });
            }
            returned.push(matched.output);
        }
        {
            let mut snapshots = self.state.context_snapshots.lock().unwrap();
            for snapshot in prepared_snapshots {
                match snapshot {
                    PreparedSearchSnapshot::Full {
                        path,
                        text,
                        seen,
                        ordinal,
                    } => snapshots.remember_full(&call.ctx_id, &path, &text, seen, ordinal),
                    PreparedSearchSnapshot::Sparse {
                        path,
                        metadata,
                        seen,
                        ordinal,
                    } => snapshots.remember_sparse(&call.ctx_id, &path, &metadata, seen, ordinal),
                }
            }
        }
        let next_cursor = has_more.then(|| {
            self.state.search_cursors.lock().unwrap().issue(
                &call,
                continuation,
                source_cursor.clone(),
            )
        });
        crate::tools::contract::serialize(FileSearchOutput {
            files: returned,
            next_cursor,
        })
    }
}

fn next_page_file(
    call: &ToolCall,
    continuation: &mut SearchContinuation,
    state: &FileToolState,
) -> Result<Option<MatchedFile>, ToolError> {
    if let Some(pending) = continuation.pending.take() {
        if let Some(matched) = refresh_pending_file(call, continuation, pending, state)? {
            return Ok(Some(matched));
        }
    }
    next_matched_file(call, continuation, state)
}

fn refresh_pending_file(
    call: &ToolCall,
    continuation: &SearchContinuation,
    pending: PendingFile,
    state: &FileToolState,
) -> Result<Option<MatchedFile>, ToolError> {
    let Ok((metadata, matches, shown, next_line)) = search_stream(
        pending
            .resolved
            .open_file()
            .map_err(|error| ToolError::new("file.notFound", error.to_string()))?,
        &continuation.matcher,
        continuation.per_file,
        continuation.context,
        continuation.start_line,
        &call.cancellation,
    ) else {
        return Ok(None);
    };
    if matches.is_empty() {
        return Ok(None);
    }
    let (body, seen) = format_streamed_content(&matches, &shown);
    Ok(Some(MatchedFile {
        output: FileSearchFile {
            path: pending.path,
            content: body,
            truncated: next_line.is_some().then_some(true),
            next_line,
        },
        resolved: pending.resolved,
        metadata,
        seen,
        ordinal: state.next_snapshot_ordinal(),
    }))
}

fn pending_file(file: MatchedFile) -> PendingFile {
    PendingFile {
        path: file.output.path,
        resolved: file.resolved,
    }
}

fn is_single_exact_file(call: &ToolCall, paths: &[String]) -> Result<bool, ToolError> {
    if paths.len() != 1 || paths[0].contains(['*', '?', '[']) {
        return Ok(false);
    }
    let (_, resolved) = resolve_existing(call, &paths[0], false)?;
    Ok(resolved
        .metadata()
        .map_err(|error| ToolError::new("file.readFailed", error.to_string()))?
        .is_file())
}

fn next_matched_file(
    call: &ToolCall,
    continuation: &mut SearchContinuation,
    state: &FileToolState,
) -> Result<Option<MatchedFile>, ToolError> {
    if continuation.groups.is_empty() {
        return Ok(None);
    }
    let matcher = continuation.matcher.clone();
    let context = continuation.context;
    let start_line = continuation.start_line;
    loop {
        let mut progressed = false;
        for _ in 0..continuation.groups.len() {
            let index = continuation.next_group % continuation.groups.len();
            continuation.next_group = (index + 1) % continuation.groups.len();
            if continuation.groups[index].exhausted {
                continue;
            }
            let candidate = loop {
                match continuation.groups[index].discovery.next(call)? {
                    Some(entry) if entry.entry_type == "file" => break Some(entry),
                    Some(_) => continue,
                    None => {
                        continuation.groups[index].exhausted = true;
                        break None;
                    }
                }
            };
            let Some(entry) = candidate else {
                continue;
            };
            progressed = true;
            if !continuation
                .seen_candidates
                .insert(entry.resolved.canonical.clone())
            {
                continue;
            }
            call.check_cancelled()?;
            let ordinal = state.next_snapshot_ordinal();
            let Ok((metadata, matches, shown, next_line)) = search_stream(
                entry
                    .resolved
                    .open_file()
                    .map_err(|error| ToolError::new("file.notFound", error.to_string()))?,
                &matcher,
                continuation.per_file,
                context,
                start_line,
                &call.cancellation,
            ) else {
                continue;
            };
            if matches.is_empty() {
                continue;
            }
            let (body, seen) = format_streamed_content(&matches, &shown);
            return Ok(Some(MatchedFile {
                output: FileSearchFile {
                    path: entry.display,
                    content: body,
                    truncated: next_line.is_some().then_some(true),
                    next_line,
                },
                resolved: entry.resolved,
                metadata,
                seen,
                ordinal,
            }));
        }
        if !progressed {
            return Ok(None);
        }
    }
}

type SearchStreamResult = (
    TextMetadata,
    Vec<usize>,
    BTreeMap<usize, String>,
    Option<usize>,
);

fn search_stream(
    file: File,
    matcher: &regex::Regex,
    limit: usize,
    context: Option<usize>,
    start_line: usize,
    cancellation: &crate::tools::ToolCancellation,
) -> Result<SearchStreamResult, ToolError> {
    let mut reader = BufReader::new(file);
    let (before, after) = context.map_or((1usize, 3usize), |value| (value, value));
    let mut previous = VecDeque::<(usize, String)>::new();
    let mut shown = BTreeMap::new();
    let mut matches = Vec::new();
    let mut next_line = None;
    let mut pending_after = 0usize;
    let mut buffer = Vec::new();
    let mut line_no = 0usize;
    let mut hasher = blake3::Hasher::new();
    let mut total_bytes = 0usize;
    let mut total_lines = 0usize;
    let mut first = true;
    loop {
        cancellation.check()?;
        buffer.clear();
        let count = reader
            .read_until(b'\n', &mut buffer)
            .map_err(|error| ToolError::new("file.readFailed", error.to_string()))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer);
        total_bytes += count;
        if buffer.contains(&0) {
            return Err(ToolError::new("file.notText", "file contains NUL bytes"));
        }
        line_no += 1;
        let had_newline = buffer.last() == Some(&b'\n');
        let mut content = buffer.as_slice();
        if first && content.starts_with(&[0xEF, 0xBB, 0xBF]) {
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
        if matches.len() < limit {
            let is_match = line_no >= start_line && matcher.is_match(&line);
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
        } else {
            if line_no >= start_line && matcher.is_match(&line) {
                next_line.get_or_insert(line_no);
                pending_after = 0;
            } else if pending_after > 0 {
                shown.insert(line_no, line);
                pending_after -= 1;
            }
        }
    }
    let metadata = TextMetadata {
        revision: hasher.finalize().to_hex().to_string(),
        total_bytes,
        total_lines,
    };
    Ok((metadata, matches, shown, next_line))
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
