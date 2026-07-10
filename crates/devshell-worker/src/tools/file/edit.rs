use std::io::Write;
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
                    let replacement = checked_lines(lines)?;
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
                    let replacement = checked_lines(lines)?;
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
        text.final_newline = match input.operations.iter().find_map(|operation| match operation {
                FileEditOperation::Insert {
                    at: InsertAt::Tail,
                    lines,
                    ..
                }
                => Some(lines.last().is_some_and(String::is_empty)),
                FileEditOperation::Replace { end_line, lines, .. } if *end_line == snapshot.total_lines =>
                    Some(lines.last().is_some_and(String::is_empty)),
                _ => None,
            }) {
            Some(value) => value,
            None => text.final_newline,
        };
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
fn checked_lines(lines: &[String]) -> Result<Vec<String>, ToolError> {
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
    Ok(lines.to_vec())
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
                checked_lines(lines)?;
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
                checked_lines(lines)?;
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
