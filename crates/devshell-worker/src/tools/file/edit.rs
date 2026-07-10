use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::sync::Arc;

use schemars::schema_for;
use tempfile::NamedTempFile;

use crate::tools::file::state::TextFile;
use crate::tools::file::types::{
    FileEditInput, FileEditOperation, FileEditOutput, InsertAt, ReturnedRange,
};
use crate::tools::file::{FileToolState, resolve_existing};
use crate::tools::{ToolAccess, ToolCall, ToolCatalogEntry, ToolError, ToolHandler, ToolName};

pub struct FileEditTool {
    name: ToolName,
    state: Arc<FileToolState>,
}
impl FileEditTool {
    pub fn new(state: Arc<FileToolState>) -> Self {
        Self {
            name: ToolName::parse("file_edit").unwrap(),
            state,
        }
    }
}
impl ToolHandler for FileEditTool {
    fn name(&self) -> &ToolName {
        &self.name
    }
    fn catalog_entry(&self) -> ToolCatalogEntry {
        ToolCatalogEntry {
            name: self.name.as_str(),
            description: "Apply snapshot-anchored text line edits atomically.".to_string(),
            input_schema: serde_json::to_value(schema_for!(FileEditInput)).unwrap(),
            output_schema: serde_json::to_value(schema_for!(FileEditOutput)).unwrap(),
            access: ToolAccess::Write,
        }
    }
    fn call(&self, call: ToolCall) -> Result<serde_json::Value, ToolError> {
        let input: FileEditInput = serde_json::from_value(call.params.clone())
            .map_err(|error| ToolError::new("tool.invalidArguments", error.to_string()))?;
        if input.operations.is_empty() {
            return Err(ToolError::new(
                "file.emptyOperation",
                "operations cannot be empty",
            ));
        }
        let (requested, path) = resolve_existing(&call, &input.path, true)?;
        if !path.is_file() {
            return Err(ToolError::new("file.notFile", "path is not a file"));
        }
        let snapshot = self
            .state
            .snapshots
            .lock()
            .unwrap()
            .get(&input.snapshot_id)?;
        if snapshot.canonical_path != path.display().to_string() {
            return Err(ToolError::new(
                "file.snapshotPathMismatch",
                "snapshot belongs to a different file",
            ));
        }
        if snapshot.full_text.is_none() {
            return edit_sparse(&self.state, input, requested.raw, path, snapshot);
        }
        let mut text = TextFile::read(&path)?;
        if text.revision != snapshot.revision {
            return Err(ToolError::retryable(
                "file.revisionMismatch",
                "file changed since this snapshot",
            ));
        }
        validate_operations(&input.operations, &snapshot.seen_lines, text.lines.len())?;
        let mut added = 0;
        let mut removed = 0;
        let mut first = usize::MAX;
        for operation in input.operations.iter().rev() {
            match operation {
                FileEditOperation::Replace {
                    start_line,
                    end_line,
                    lines,
                } => {
                    let replacement = edit_lines(lines, *end_line == snapshot.total_lines)?;
                    first = first.min(*start_line);
                    removed += end_line - start_line + 1;
                    added += replacement.len();
                    text.lines.splice(start_line - 1..*end_line, replacement);
                }
                FileEditOperation::Delete {
                    start_line,
                    end_line,
                } => {
                    first = first.min(*start_line);
                    removed += end_line - start_line + 1;
                    text.lines.drain(start_line - 1..*end_line);
                }
                FileEditOperation::Insert { at, line, lines } => {
                    let replacement = edit_lines(
                        lines,
                        is_eof_insert(at, *line, snapshot.total_lines),
                    )?;
                    let index = match at {
                        InsertAt::Head => 0,
                        InsertAt::Tail => text.lines.len(),
                        InsertAt::Before => line.unwrap() - 1,
                        InsertAt::After => line.unwrap(),
                    };
                    first = first.min(index + 1);
                    added += replacement.len();
                    text.lines.splice(index..index, replacement);
                }
            }
        }
        text.final_newline = final_newline_after(
            &input.operations,
            snapshot.total_lines,
            text.final_newline,
        )?;
        atomic_write(&path, &text.encoded())?;
        let text = TextFile::read(&path)?;
        let count = text.lines.len().min(200);
        let seen = 1..=count;
        let snapshot_id = self
            .state
            .snapshots
            .lock()
            .unwrap()
            .remember(&path, &text, seen.clone());
        let content = (1..=count)
            .map(|line| format!("{line}:{}", text.lines[line - 1]))
            .collect::<Vec<_>>()
            .join("\n");
        let ranges = if count == 0 {
            Vec::new()
        } else {
            vec![ReturnedRange {
                start_line: 1,
                end_line: count,
            }]
        };
        serde_json::to_value(FileEditOutput {
            path: requested.raw,
            snapshot_id,
            revision: text.revision,
            added_lines: added,
            removed_lines: removed,
            first_changed_line: first,
            content,
            returned_ranges: ranges,
            total_lines: text.lines.len(),
            total_bytes: text.total_bytes,
            truncated: text.lines.len() > count,
        })
        .map_err(|error| ToolError::new("tool.internalError", error.to_string()))
    }
}

fn edit_sparse(
    state: &FileToolState,
    input: FileEditInput,
    display_path: String,
    path: std::path::PathBuf,
    snapshot: crate::tools::file::state::FileSnapshot,
) -> Result<serde_json::Value, ToolError> {
    let metadata = TextFile::inspect(&path)?;
    if metadata.revision != snapshot.revision {
        return Err(ToolError::retryable(
            "file.revisionMismatch",
            "file changed since this snapshot",
        ));
    }
    validate_operations(&input.operations, &snapshot.seen_lines, metadata.total_lines)?;

    let mut ranges = BTreeMap::new();
    let mut inserts = BTreeMap::new();
    let mut added = 0;
    let mut removed = 0;
    let mut first = usize::MAX;
    for operation in &input.operations {
        match operation {
            FileEditOperation::Replace {
                start_line,
                end_line,
                lines,
            } => {
                let replacement = edit_lines(lines, *end_line == metadata.total_lines)?;
                first = first.min(*start_line);
                removed += end_line - start_line + 1;
                added += replacement.len();
                ranges.insert(*start_line, (*end_line, Some(replacement)));
            }
            FileEditOperation::Delete {
                start_line,
                end_line,
            } => {
                first = first.min(*start_line);
                removed += end_line - start_line + 1;
                ranges.insert(*start_line, (*end_line, None));
            }
            FileEditOperation::Insert { at, line, lines } => {
                let replacement = edit_lines(lines, is_eof_insert(at, *line, metadata.total_lines))?;
                let boundary = match at {
                    InsertAt::Head => 0,
                    InsertAt::Tail => metadata.total_lines,
                    InsertAt::Before => line.unwrap() - 1,
                    InsertAt::After => line.unwrap(),
                };
                first = first.min(boundary + 1);
                added += replacement.len();
                inserts.insert(boundary, replacement);
            }
        }
    }

    let final_newline = final_newline_after(
        &input.operations,
        metadata.total_lines,
        metadata.final_newline,
    )?;

    let parent = path
        .parent()
        .ok_or_else(|| ToolError::new("file.writeFailed", "target has no parent"))?;
    let source = fs::File::open(&path)
        .map_err(|error| ToolError::new("file.notFound", error.to_string()))?;
    let mut reader = BufReader::new(source);
    let mut temp = NamedTempFile::new_in(parent)
        .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
    if metadata.bom {
        temp.write_all(&[0xEF, 0xBB, 0xBF])
            .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
    }

    let mut wrote_line = false;
    let mut line_no = 1;
    let mut first_input_line = true;
    let mut buffer = Vec::new();
    while line_no <= metadata.total_lines {
        if let Some(lines) = inserts.get(&(line_no - 1)) {
            write_lines(&mut temp, lines, metadata.line_ending, &mut wrote_line)?;
        }
        if let Some((end_line, replacement)) = ranges.get(&line_no) {
            if let Some(lines) = replacement {
                write_lines(&mut temp, lines, metadata.line_ending, &mut wrote_line)?;
            }
            for _ in line_no..=*end_line {
                read_line(&mut reader, &mut buffer, &mut first_input_line)?;
            }
            line_no = end_line + 1;
            continue;
        }
        let line = read_line(&mut reader, &mut buffer, &mut first_input_line)?;
        write_line(&mut temp, line, metadata.line_ending, &mut wrote_line)?;
        line_no += 1;
    }
    if let Some(lines) = inserts.get(&metadata.total_lines) {
        write_lines(&mut temp, lines, metadata.line_ending, &mut wrote_line)?;
    }
    if final_newline && wrote_line {
        temp.write_all(metadata.line_ending.as_bytes())
            .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
    }
    temp.flush()
        .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
    temp.persist(&path)
        .map_err(|error| ToolError::new("file.writeFailed", error.error.to_string()))?;

    let metadata = TextFile::inspect(&path)?;
    let count = metadata.total_lines.min(200);
    let content = read_anchored_prefix(&path, count)?;
    let snapshot_id = state
        .snapshots
        .lock()
        .unwrap()
        .remember_sparse(&path, &metadata, 1..=count);
    let returned_ranges = if count == 0 {
        Vec::new()
    } else {
        vec![ReturnedRange {
            start_line: 1,
            end_line: count,
        }]
    };
    serde_json::to_value(FileEditOutput {
        path: display_path,
        snapshot_id,
        revision: metadata.revision,
        added_lines: added,
        removed_lines: removed,
        first_changed_line: first,
        content,
        returned_ranges,
        total_lines: metadata.total_lines,
        total_bytes: metadata.total_bytes,
        truncated: metadata.total_lines > count,
    })
    .map_err(|error| ToolError::new("tool.internalError", error.to_string()))
}

fn write_lines(
    output: &mut NamedTempFile,
    lines: &[String],
    line_ending: &str,
    wrote_line: &mut bool,
) -> Result<(), ToolError> {
    for line in lines {
        write_line(output, line, line_ending, wrote_line)?;
    }
    Ok(())
}

fn write_line(
    output: &mut NamedTempFile,
    line: &str,
    line_ending: &str,
    wrote_line: &mut bool,
) -> Result<(), ToolError> {
    if *wrote_line {
        output
            .write_all(line_ending.as_bytes())
            .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
    }
    output
        .write_all(line.as_bytes())
        .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
    *wrote_line = true;
    Ok(())
}

fn read_line<'a>(
    reader: &mut BufReader<fs::File>,
    buffer: &'a mut Vec<u8>,
    first_line: &mut bool,
) -> Result<&'a str, ToolError> {
    buffer.clear();
    let count = reader
        .read_until(b'\n', buffer)
        .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
    if count == 0 {
        return Err(ToolError::new("file.writeFailed", "file ended before its expected line count"));
    }
    let mut line = buffer.as_slice();
    line = line.strip_suffix(b"\n").unwrap_or(line);
    line = line.strip_suffix(b"\r").unwrap_or(line);
    if *first_line && line.starts_with(&[0xEF, 0xBB, 0xBF]) {
        line = &line[3..];
    }
    *first_line = false;
    std::str::from_utf8(line).map_err(|_| ToolError::new("file.notText", "file is not valid UTF-8"))
}

fn read_anchored_prefix(path: &std::path::Path, count: usize) -> Result<String, ToolError> {
    let source = fs::File::open(path)
        .map_err(|error| ToolError::new("file.notFound", error.to_string()))?;
    let mut reader = BufReader::new(source);
    let mut buffer = Vec::new();
    let mut first_line = true;
    let mut content = Vec::new();
    for line_no in 1..=count {
        let line = read_line(&mut reader, &mut buffer, &mut first_line)?;
        content.push(format!("{line_no}:{line}"));
    }
    Ok(content.join("\n"))
}
fn checked_lines(lines: &[String]) -> Result<(), ToolError> {
    if lines.is_empty() {
        return Err(ToolError::new(
            "file.emptyOperation",
            "lines cannot be empty",
        ));
    }
    if lines
        .iter()
        .any(|line| line.contains('\n') || line.contains('\r'))
    {
        return Err(ToolError::new(
            "file.invalidRange",
            "line payload cannot contain line breaks",
        ));
    }
    Ok(())
}

fn edit_lines(lines: &[String], eof: bool) -> Result<Vec<String>, ToolError> {
    checked_lines(lines)?;
    if !eof {
        return Ok(lines.to_vec());
    }
    let lines = if lines.last().is_some_and(String::is_empty) {
        &lines[..lines.len() - 1]
    } else {
        lines
    };
    if lines.is_empty() {
        return Err(ToolError::new(
            "file.emptyOperation",
            "EOF payload has no logical line content",
        ));
    }
    Ok(lines.to_vec())
}

fn is_eof_insert(at: &InsertAt, line: Option<usize>, total: usize) -> bool {
    matches!(at, InsertAt::Tail)
        || matches!(at, InsertAt::After) && line == Some(total)
        || total == 0 && matches!(at, InsertAt::Head)
}

fn final_newline_after(
    operations: &[FileEditOperation],
    total: usize,
    original: bool,
) -> Result<bool, ToolError> {
    let mut replacement = None;
    let mut tail_insert = None;
    for operation in operations {
        match operation {
            FileEditOperation::Replace {
                end_line, lines, ..
            } if *end_line == total => {
                checked_lines(lines)?;
                replacement = Some(lines.last().is_some_and(String::is_empty));
            }
            FileEditOperation::Insert { at, line, lines }
                if is_eof_insert(at, *line, total) =>
            {
                checked_lines(lines)?;
                tail_insert = Some(lines.last().is_some_and(String::is_empty));
            }
            _ => {}
        }
    }
    Ok(tail_insert.or(replacement).unwrap_or(original))
}
fn validate_operations(
    operations: &[FileEditOperation],
    seen: &std::collections::BTreeSet<usize>,
    total: usize,
) -> Result<(), ToolError> {
    let mut ranges = Vec::new();
    let mut boundaries = std::collections::BTreeSet::new();
    for operation in operations {
        match operation {
            FileEditOperation::Replace {
                start_line,
                end_line,
                lines,
            } => {
                edit_lines(lines, *end_line == total)?;
                validate_range(*start_line, *end_line, total, seen)?;
                ranges.push((*start_line, *end_line));
            }
            FileEditOperation::Delete {
                start_line,
                end_line,
            } => {
                validate_range(*start_line, *end_line, total, seen)?;
                ranges.push((*start_line, *end_line));
            }
            FileEditOperation::Insert { at, line, lines } => {
                let boundary = match at {
                    InsertAt::Head => 0,
                    InsertAt::Tail => total,
                    InsertAt::Before => {
                        line.ok_or_else(|| {
                            ToolError::new("file.invalidRange", "before requires line")
                        })? - 1
                    }
                    InsertAt::After => line.ok_or_else(|| {
                        ToolError::new("file.invalidRange", "after requires line")
                    })?,
                };
                if boundary > total
                    || matches!(at, InsertAt::Before | InsertAt::After)
                        && !seen.contains(&line.unwrap())
                {
                    return Err(ToolError::new(
                        "file.invalidRange",
                        "insert anchor is not in snapshot coverage",
                    ));
                }
                edit_lines(lines, is_eof_insert(at, *line, total))?;
                if !boundaries.insert(boundary) {
                    return Err(ToolError::new(
                        "file.operationConflict",
                        "multiple inserts use the same boundary",
                    ));
                }
            }
        }
    }
    ranges.sort();
    if ranges.windows(2).any(|pair| pair[0].1 >= pair[1].0) {
        return Err(ToolError::new(
            "file.operationConflict",
            "edit ranges overlap",
        ));
    }
    if boundaries.iter().any(|boundary| {
        ranges
            .iter()
            .any(|(start, end)| *start <= *boundary && *boundary < *end)
    }) {
        return Err(ToolError::new(
            "file.operationConflict",
            "an insert cannot occur inside a replace or delete range",
        ));
    }
    Ok(())
}

fn atomic_write(path: &std::path::Path, bytes: &[u8]) -> Result<(), ToolError> {
    let parent = path
        .parent()
        .ok_or_else(|| ToolError::new("file.writeFailed", "target has no parent"))?;
    let mut temp = NamedTempFile::new_in(parent)
        .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
    temp.write_all(bytes)
        .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
    temp.flush()
        .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
    temp.persist(path)
        .map_err(|error| ToolError::new("file.writeFailed", error.error.to_string()))?;
    Ok(())
}
fn validate_range(
    start: usize,
    end: usize,
    total: usize,
    seen: &std::collections::BTreeSet<usize>,
) -> Result<(), ToolError> {
    if start == 0 || end < start || end > total || !(start..=end).all(|line| seen.contains(&line)) {
        return Err(ToolError::new(
            "file.invalidRange",
            "edit range is invalid or unread",
        ));
    }
    Ok(())
}
