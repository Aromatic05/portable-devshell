use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;

use schemars::schema_for;

use crate::tools::file::state::{SnapshotContent, TextFile};
use crate::tools::file::structure;
use crate::tools::file::types::{
    FileEditFileOutput, FileEditInput, FileEditOperation, FileEditOutput, InsertAt, ReturnedRange,
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
            description: concat!(
                "Apply compact snapshot-anchored text patches. Input is one or more sections beginning with the exact header returned by file_read/file_search: `[./path#snapshotId]`. ",
                "Commands use one-based line numbers from that snapshot; all commands in a section refer to the original snapshot coordinates, not coordinates produced by earlier commands. ",
                "Replacement and insertion bodies are consecutive lines prefixed with `+`. Supported commands: `SWAP N:` or `SWAP A-B:` followed by `+` lines; `DEL N` or `DEL A-B`; ",
                "`INS.PRE N:`, `INS.POST N:`, `INS.HEAD:`, and `INS.TAIL:` followed by `+` lines. Tree-sitter commands are `SWAP.BLK N:`, `DEL.BLK N`, and `INS.BLK.POST N:`; N must be the first line of a supported syntax block. ",
                "Every replaced/deleted block and every insertion anchor must be covered by snapshot lines actually returned to the caller; `.BLK` operations do not bypass this seen-lines rule. ",
                "A file may appear once per request. All sections are parsed, authorized, snapshot-checked, and range-checked before any file is written; writes then occur in section order and are not rolled back if a later filesystem write fails. ",
                "Example: `[./src/main.rs#SNAPSHOT]\nSWAP 10-12:\n+fn main() {\n+    run();\n+}\n\nINS.POST 20:\n+// inserted`."
            )
            .to_string(),
            input_schema: serde_json::to_value(schema_for!(FileEditInput)).unwrap(),
            output_schema: serde_json::to_value(schema_for!(FileEditOutput)).unwrap(),
            access: ToolAccess::Write,
        }
    }
    fn call(&self, call: ToolCall) -> Result<serde_json::Value, ToolError> {
        let input: FileEditInput = serde_json::from_value(call.params.clone())
            .map_err(|error| ToolError::new("tool.invalidArguments", error.to_string()))?;
        let sections = parse_patch(&input.input)?;
        let mut resolved = Vec::with_capacity(sections.len());
        for section in sections {
            let (requested, path) = resolve_existing(&call, &section.path, true)?;
            if !path.is_file() {
                return Err(ToolError::new("file.notFile", "path is not a file"));
            }
            resolved.push((section, requested.raw, path));
        }
        let mut lock_paths = resolved
            .iter()
            .map(|(_, _, path)| path.clone())
            .collect::<Vec<_>>();
        lock_paths.sort();
        lock_paths.dedup();
        let locks = lock_paths
            .iter()
            .map(|path| self.state.write_lock(path))
            .collect::<Vec<_>>();
        let _guards = locks
            .iter()
            .map(|lock| lock.lock().unwrap())
            .collect::<Vec<_>>();

        let mut prepared = Vec::with_capacity(resolved.len());
        for (section, display, path) in resolved {
            prepared.push(self.prepare(&call, section, display, path)?);
        }
        let mut files = Vec::with_capacity(prepared.len());
        for prepared in prepared {
            files.push(self.apply(&call, prepared)?);
        }
        serde_json::to_value(FileEditOutput { files })
            .map_err(|error| ToolError::new("tool.internalError", error.to_string()))
    }
}

impl FileEditTool {
    fn prepare(
        &self,
        _call: &ToolCall,
        section: PatchSection,
        display: String,
        path: PathBuf,
    ) -> Result<PreparedEdit, ToolError> {
        let snapshot = self
            .state
            .snapshots
            .lock()
            .unwrap()
            .get(&section.snapshot_id)?;
        if snapshot.canonical_path != path.display().to_string() {
            return Err(ToolError::new(
                "file.snapshotPathMismatch",
                "snapshot belongs to a different file",
            ));
        }
        let current = TextFile::read(&path)?;
        let source = match &snapshot.content {
            SnapshotContent::Full(content) => content.clone(),
            SnapshotContent::Sparse => current.normalized(),
        };
        let operations = expand_block_operations(&path, &source, section.operations)?;
        validate_operations(&operations, &snapshot.seen_lines, snapshot.total_lines)?;
        let operations = if current.revision == snapshot.revision {
            operations
        } else {
            match &snapshot.content {
                SnapshotContent::Full(old) => remap_exact(&operations, old, &current.lines)?,
                SnapshotContent::Sparse => {
                    return Err(ToolError::retryable(
                        "file.revisionMismatch",
                        "sparse snapshot changed and cannot be recovered",
                    ));
                }
            }
        };
        validate_geometry(&operations, current.lines.len())?;
        Ok(PreparedEdit {
            display,
            path,
            current_revision: current.revision.clone(),
            text: current,
            operations,
        })
    }

    fn apply(
        &self,
        call: &ToolCall,
        mut prepared: PreparedEdit,
    ) -> Result<FileEditFileOutput, ToolError> {
        let latest = TextFile::read(&prepared.path)?;
        if latest.revision != prepared.current_revision {
            return Err(ToolError::retryable(
                "file.revisionMismatch",
                "file changed while preparing the batch",
            ));
        }
        let before = prepared.text.lines.clone();
        let (added, removed, first) = apply_operations(&mut prepared.text, &prepared.operations)?;
        atomic_write(
            call,
            &prepared.display,
            &prepared.path,
            &prepared.text.encoded(),
        )?;
        let text = TextFile::read(&prepared.path)?;
        let preview_start = first.saturating_sub(3).max(1);
        let preview_end = text.lines.len().min(first.saturating_add(20));
        let seen = if preview_start <= preview_end {
            preview_start..=preview_end
        } else {
            1..=0
        };
        let snapshot_id =
            self.state
                .snapshots
                .lock()
                .unwrap()
                .remember(&prepared.path, &text, seen.clone());
        let header = format!("[{}#{}]", prepared.display, snapshot_id);
        let body = seen
            .clone()
            .map(|line| format!("{line}:{}", text.lines[line - 1]))
            .collect::<Vec<_>>()
            .join("\n");
        let content = if body.is_empty() {
            header.clone()
        } else {
            format!("{header}\n{body}")
        };
        let returned_ranges = if preview_start <= preview_end {
            vec![ReturnedRange {
                start_line: preview_start,
                end_line: preview_end,
            }]
        } else {
            Vec::new()
        };
        Ok(FileEditFileOutput {
            path: prepared.display,
            snapshot_id,
            revision: text.revision,
            header,
            diff: compact_diff(&before, &text.lines, first),
            diagnostics: Vec::new(),
            added_lines: added,
            removed_lines: removed,
            first_changed_line: first,
            content,
            returned_ranges,
            total_lines: text.lines.len(),
            total_bytes: text.total_bytes,
            truncated: preview_end < text.lines.len(),
        })
    }
}

struct PatchSection {
    path: String,
    snapshot_id: String,
    operations: Vec<FileEditOperation>,
}
struct PreparedEdit {
    display: String,
    path: PathBuf,
    current_revision: String,
    text: TextFile,
    operations: Vec<FileEditOperation>,
}

fn parse_patch(input: &str) -> Result<Vec<PatchSection>, ToolError> {
    let lines = input.lines().collect::<Vec<_>>();
    let mut sections = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        if lines[index].trim().is_empty() {
            index += 1;
            continue;
        }
        let header = lines[index].trim();
        if !header.starts_with('[') || !header.ends_with(']') {
            return Err(ToolError::new(
                "file.invalidPatch",
                "expected [path#snapshot] header",
            ));
        }
        let inner = &header[1..header.len() - 1];
        let (path, snapshot_id) = inner
            .rsplit_once('#')
            .ok_or_else(|| ToolError::new("file.invalidPatch", "header requires a snapshot id"))?;
        index += 1;
        let mut operations = Vec::new();
        while index < lines.len() && !lines[index].trim().starts_with('[') {
            if lines[index].trim().is_empty() {
                index += 1;
                continue;
            }
            let command = lines[index].trim().trim_end_matches(':').to_string();
            index += 1;
            let needs_body = command.starts_with("SWAP ")
                || command.starts_with("SWAP.BLK ")
                || command.starts_with("INS.");
            let mut body = Vec::new();
            if needs_body {
                while index < lines.len() && lines[index].starts_with('+') {
                    body.push(lines[index][1..].to_string());
                    index += 1;
                }
                if body.is_empty() {
                    return Err(ToolError::new(
                        "file.emptyOperation",
                        "patch operation requires + body lines",
                    ));
                }
            }
            operations.push(parse_command(&command, body)?);
        }
        if operations.is_empty() {
            return Err(ToolError::new(
                "file.emptyOperation",
                "patch section has no operations",
            ));
        }
        sections.push(PatchSection {
            path: path.to_string(),
            snapshot_id: snapshot_id.to_string(),
            operations,
        });
    }
    if sections.is_empty() {
        return Err(ToolError::new(
            "file.emptyOperation",
            "patch contains no sections",
        ));
    }
    let mut paths = BTreeSet::new();
    if sections
        .iter()
        .any(|section| !paths.insert(section.path.clone()))
    {
        return Err(ToolError::new(
            "file.operationConflict",
            "a file may appear only once per patch",
        ));
    }
    Ok(sections)
}

fn parse_command(command: &str, body: Vec<String>) -> Result<FileEditOperation, ToolError> {
    if let Some(value) = command.strip_prefix("SWAP.BLK ") {
        return Ok(FileEditOperation::ReplaceBlock {
            start_line: parse_line(value)?,
            lines: body,
        });
    }
    if let Some(value) = command.strip_prefix("DEL.BLK ") {
        return Ok(FileEditOperation::DeleteBlock {
            start_line: parse_line(value)?,
        });
    }
    if let Some(value) = command.strip_prefix("INS.BLK.POST ") {
        return Ok(FileEditOperation::InsertBlockPost {
            start_line: parse_line(value)?,
            lines: body,
        });
    }
    if let Some(value) = command.strip_prefix("SWAP ") {
        let (start_line, end_line) = parse_range(value)?;
        return Ok(FileEditOperation::Replace {
            start_line,
            end_line,
            lines: body,
        });
    }
    if let Some(value) = command.strip_prefix("DEL ") {
        let (start_line, end_line) = parse_range(value)?;
        return Ok(FileEditOperation::Delete {
            start_line,
            end_line,
        });
    }
    if command == "INS.HEAD" {
        return Ok(FileEditOperation::Insert {
            at: InsertAt::Head,
            line: None,
            lines: body,
        });
    }
    if command == "INS.TAIL" {
        return Ok(FileEditOperation::Insert {
            at: InsertAt::Tail,
            line: None,
            lines: body,
        });
    }
    if let Some(value) = command.strip_prefix("INS.PRE ") {
        return Ok(FileEditOperation::Insert {
            at: InsertAt::Before,
            line: Some(parse_line(value)?),
            lines: body,
        });
    }
    if let Some(value) = command.strip_prefix("INS.POST ") {
        return Ok(FileEditOperation::Insert {
            at: InsertAt::After,
            line: Some(parse_line(value)?),
            lines: body,
        });
    }
    Err(ToolError::new(
        "file.invalidPatch",
        format!("unknown patch command: {command}"),
    ))
}
fn parse_range(value: &str) -> Result<(usize, usize), ToolError> {
    let normalized = value.replace(".=", "-").replace('=', "-");
    if let Some((a, b)) = normalized.split_once('-') {
        Ok((parse_line(a)?, parse_line(b)?))
    } else {
        let line = parse_line(&normalized)?;
        Ok((line, line))
    }
}
fn parse_line(value: &str) -> Result<usize, ToolError> {
    let line = value
        .trim()
        .parse::<usize>()
        .map_err(|_| ToolError::new("file.invalidPatch", "invalid line number"))?;
    if line == 0 {
        Err(ToolError::new(
            "file.invalidPatch",
            "line numbers are one-based",
        ))
    } else {
        Ok(line)
    }
}

fn expand_block_operations(
    path: &std::path::Path,
    source: &str,
    operations: Vec<FileEditOperation>,
) -> Result<Vec<FileEditOperation>, ToolError> {
    operations
        .into_iter()
        .map(|operation| match operation {
            FileEditOperation::ReplaceBlock { start_line, lines } => {
                let (start_line, end_line) = structure::block_range(path, source, start_line)?
                    .ok_or_else(|| {
                        ToolError::new(
                            "file.blockNotFound",
                            "no supported Tree-sitter block starts at this line",
                        )
                    })?;
                Ok(FileEditOperation::Replace {
                    start_line,
                    end_line,
                    lines,
                })
            }
            FileEditOperation::DeleteBlock { start_line } => {
                let (start_line, end_line) = structure::block_range(path, source, start_line)?
                    .ok_or_else(|| {
                        ToolError::new(
                            "file.blockNotFound",
                            "no supported Tree-sitter block starts at this line",
                        )
                    })?;
                Ok(FileEditOperation::Delete {
                    start_line,
                    end_line,
                })
            }
            FileEditOperation::InsertBlockPost { start_line, lines } => {
                let (_, end_line) =
                    structure::block_range(path, source, start_line)?.ok_or_else(|| {
                        ToolError::new(
                            "file.blockNotFound",
                            "no supported Tree-sitter block starts at this line",
                        )
                    })?;
                Ok(FileEditOperation::Insert {
                    at: InsertAt::After,
                    line: Some(end_line),
                    lines,
                })
            }
            other => Ok(other),
        })
        .collect()
}

fn validate_operations(
    operations: &[FileEditOperation],
    seen: &BTreeSet<usize>,
    total: usize,
) -> Result<(), ToolError> {
    validate_geometry(operations, total)?;
    for operation in operations {
        match operation {
            FileEditOperation::Replace {
                start_line,
                end_line,
                ..
            }
            | FileEditOperation::Delete {
                start_line,
                end_line,
            } => {
                if !(*start_line..=*end_line).all(|line| seen.contains(&line)) {
                    return Err(ToolError::new(
                        "file.invalidRange",
                        "edit range is invalid or unread",
                    ));
                }
            }
            FileEditOperation::Insert { at, line, .. } => {
                if matches!(at, InsertAt::Before | InsertAt::After)
                    && !seen.contains(&line.unwrap())
                {
                    return Err(ToolError::new(
                        "file.invalidRange",
                        "insert anchor is not in snapshot coverage",
                    ));
                }
            }
            _ => unreachable!(),
        }
    }
    Ok(())
}
fn validate_geometry(operations: &[FileEditOperation], total: usize) -> Result<(), ToolError> {
    let mut ranges = Vec::new();
    let mut boundaries = BTreeSet::new();
    for op in operations {
        match op {
            FileEditOperation::Replace {
                start_line,
                end_line,
                lines,
            } => {
                checked_lines(lines)?;
                validate_range(*start_line, *end_line, total)?;
                ranges.push((*start_line, *end_line));
            }
            FileEditOperation::Delete {
                start_line,
                end_line,
            } => {
                validate_range(*start_line, *end_line, total)?;
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
                if boundary > total || !boundaries.insert(boundary) {
                    return Err(ToolError::new(
                        "file.operationConflict",
                        "invalid or duplicate insert boundary",
                    ));
                }
            }
            _ => {
                return Err(ToolError::new(
                    "file.invalidPatch",
                    "unexpanded block operation",
                ));
            }
        }
    }
    ranges.sort();
    if ranges.windows(2).any(|p| p[0].1 >= p[1].0) {
        return Err(ToolError::new(
            "file.operationConflict",
            "edit ranges overlap",
        ));
    }
    if boundaries
        .iter()
        .any(|b| ranges.iter().any(|(s, e)| *s <= *b && *b < *e))
    {
        return Err(ToolError::new(
            "file.operationConflict",
            "insert occurs inside edited range",
        ));
    }
    Ok(())
}
fn validate_range(start: usize, end: usize, total: usize) -> Result<(), ToolError> {
    if start == 0 || end < start || end > total {
        Err(ToolError::new("file.invalidRange", "invalid edit range"))
    } else {
        Ok(())
    }
}
fn checked_lines(lines: &[String]) -> Result<(), ToolError> {
    if lines.is_empty() {
        return Err(ToolError::new(
            "file.emptyOperation",
            "lines cannot be empty",
        ));
    }
    if lines.iter().any(|l| l.contains(['\n', '\r'])) {
        return Err(ToolError::new(
            "file.invalidPatch",
            "body line contains a line break",
        ));
    }
    Ok(())
}

fn remap_exact(
    operations: &[FileEditOperation],
    old: &str,
    current: &[String],
) -> Result<Vec<FileEditOperation>, ToolError> {
    let old_lines = split_normalized(old);
    operations
        .iter()
        .map(|op| match op {
            FileEditOperation::Replace {
                start_line,
                end_line,
                lines,
            } => {
                let (s, e) = map_segment(&old_lines, current, *start_line, *end_line)?;
                Ok(FileEditOperation::Replace {
                    start_line: s,
                    end_line: e,
                    lines: lines.clone(),
                })
            }
            FileEditOperation::Delete {
                start_line,
                end_line,
            } => {
                let (s, e) = map_segment(&old_lines, current, *start_line, *end_line)?;
                Ok(FileEditOperation::Delete {
                    start_line: s,
                    end_line: e,
                })
            }
            FileEditOperation::Insert {
                at: InsertAt::Head,
                lines,
                ..
            } => {
                if old_lines.first() != current.first() {
                    return Err(revision_mismatch());
                }
                Ok(FileEditOperation::Insert {
                    at: InsertAt::Head,
                    line: None,
                    lines: lines.clone(),
                })
            }
            FileEditOperation::Insert {
                at: InsertAt::Tail,
                lines,
                ..
            } => {
                if old_lines.last() != current.last() {
                    return Err(revision_mismatch());
                }
                Ok(FileEditOperation::Insert {
                    at: InsertAt::Tail,
                    line: None,
                    lines: lines.clone(),
                })
            }
            FileEditOperation::Insert {
                at,
                line: Some(line),
                lines,
            } => {
                let (s, _) = map_segment(&old_lines, current, *line, *line)?;
                Ok(FileEditOperation::Insert {
                    at: at.clone(),
                    line: Some(s),
                    lines: lines.clone(),
                })
            }
            _ => Err(revision_mismatch()),
        })
        .collect()
}
fn map_segment(
    old: &[String],
    current: &[String],
    start: usize,
    end: usize,
) -> Result<(usize, usize), ToolError> {
    let needle = &old[start - 1..end];
    let hits = (0..=current.len().saturating_sub(needle.len()))
        .filter(|i| current[*i..*i + needle.len()] == *needle)
        .collect::<Vec<_>>();
    if hits.len() != 1 {
        return Err(revision_mismatch());
    }
    Ok((hits[0] + 1, hits[0] + needle.len()))
}
fn revision_mismatch() -> ToolError {
    ToolError::retryable(
        "file.revisionMismatch",
        "snapshot patch cannot be mapped exactly to the current file",
    )
}
fn split_normalized(value: &str) -> Vec<String> {
    if value.is_empty() {
        Vec::new()
    } else {
        value
            .strip_suffix('\n')
            .unwrap_or(value)
            .split('\n')
            .map(ToOwned::to_owned)
            .collect()
    }
}

fn apply_operations(
    text: &mut TextFile,
    operations: &[FileEditOperation],
) -> Result<(usize, usize, usize), ToolError> {
    let mut added = 0;
    let mut removed = 0;
    let mut first = usize::MAX;
    for op in operations.iter().rev() {
        match op {
            FileEditOperation::Replace {
                start_line,
                end_line,
                lines,
            } => {
                first = first.min(*start_line);
                removed += end_line - start_line + 1;
                added += lines.len();
                text.lines.splice(start_line - 1..*end_line, lines.clone());
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
                let index = match at {
                    InsertAt::Head => 0,
                    InsertAt::Tail => text.lines.len(),
                    InsertAt::Before => line.unwrap() - 1,
                    InsertAt::After => line.unwrap(),
                };
                first = first.min(index + 1);
                added += lines.len();
                text.lines.splice(index..index, lines.clone());
            }
            _ => unreachable!(),
        }
    }
    Ok((added, removed, first))
}

fn atomic_write(
    call: &ToolCall,
    raw: &str,
    path: &std::path::Path,
    bytes: &[u8],
) -> Result<(), ToolError> {
    use std::io::Write;
    use tempfile::NamedTempFile;
    let (_, verified) = resolve_existing(call, raw, true)?;
    if verified != path {
        return Err(ToolError::new(
            "file.writeFailed",
            "target changed while preparing write",
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| ToolError::new("file.writeFailed", "target has no parent"))?;
    let mut temp = NamedTempFile::new_in(parent)
        .map_err(|e| ToolError::new("file.writeFailed", e.to_string()))?;
    temp.write_all(bytes)
        .map_err(|e| ToolError::new("file.writeFailed", e.to_string()))?;
    temp.flush()
        .map_err(|e| ToolError::new("file.writeFailed", e.to_string()))?;
    temp.persist(path)
        .map_err(|e| ToolError::new("file.writeFailed", e.error.to_string()))?;
    Ok(())
}
fn compact_diff(before: &[String], after: &[String], first: usize) -> String {
    let start = first.saturating_sub(2).max(1);
    let end = before.len().max(after.len()).min(first + 8);
    let mut out = Vec::new();
    for line in start..=end {
        match (before.get(line - 1), after.get(line - 1)) {
            (Some(a), Some(b)) if a == b => out.push(format!(" {line}:{a}")),
            (Some(a), Some(b)) => {
                out.push(format!("-{line}:{a}"));
                out.push(format!("+{line}:{b}"));
            }
            (Some(a), None) => out.push(format!("-{line}:{a}")),
            (None, Some(b)) => out.push(format!("+{line}:{b}")),
            _ => {}
        }
    }
    out.join("\n")
}
