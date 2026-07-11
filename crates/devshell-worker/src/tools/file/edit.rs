use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use regex::Regex;
use schemars::schema_for;
use tempfile::NamedTempFile;

use crate::tools::file::state::{
    FULL_SNAPSHOT_LIMIT, FileSnapshot, SnapshotContent, TextFile, TextMetadata,
};
use crate::tools::file::structure;
use crate::tools::file::types::{
    FileEditApplyPatchInput, FileEditFileOutput, FileEditMode, FileEditOperation, FileEditOutput,
    FileEditPatchEntry, FileEditPatchInput, FileEditPatchOperation, FileEditReplaceInput,
    FileEditResultOperation, FileEditTextInput, InsertAt, ReturnedRange,
};
use crate::tools::file::{FileToolState, resolve_create, resolve_existing};
use crate::tools::{ToolAccess, ToolCall, ToolCatalogEntry, ToolError, ToolHandler, ToolName};

pub struct FileEditTool {
    name: ToolName,
    state: Arc<FileToolState>,
    mode: FileEditMode,
}

impl FileEditTool {
    pub fn new(state: Arc<FileToolState>, mode: FileEditMode) -> Self {
        Self {
            name: ToolName::parse("file_edit").unwrap(),
            state,
            mode,
        }
    }
}

impl ToolHandler for FileEditTool {
    fn name(&self) -> &ToolName {
        &self.name
    }

    fn catalog_entry(&self) -> ToolCatalogEntry {
        let (description, input_schema) = match self.mode {
            FileEditMode::Text => (
                text_description(),
                serde_json::to_value(schema_for!(FileEditTextInput)).unwrap(),
            ),
            FileEditMode::Replace => (
                replace_description(),
                serde_json::to_value(schema_for!(FileEditReplaceInput)).unwrap(),
            ),
            FileEditMode::Patch => (
                patch_description(),
                serde_json::to_value(schema_for!(FileEditPatchInput)).unwrap(),
            ),
            FileEditMode::ApplyPatch => (
                apply_patch_description(),
                serde_json::to_value(schema_for!(FileEditApplyPatchInput)).unwrap(),
            ),
        };
        ToolCatalogEntry {
            name: self.name.as_str(),
            description,
            input_schema,
            output_schema: serde_json::to_value(schema_for!(FileEditOutput)).unwrap(),
            access: ToolAccess::Write,
        }
    }

    fn call(&self, call: ToolCall) -> Result<serde_json::Value, ToolError> {
        let request = match self.mode {
            FileEditMode::Text => EditRequest::Text(
                serde_json::from_value::<FileEditTextInput>(call.params.clone())
                    .map_err(invalid_arguments)?,
            ),
            FileEditMode::Replace => EditRequest::Replace(
                serde_json::from_value::<FileEditReplaceInput>(call.params.clone())
                    .map_err(invalid_arguments)?,
            ),
            FileEditMode::Patch => EditRequest::Patch(
                serde_json::from_value::<FileEditPatchInput>(call.params.clone())
                    .map_err(invalid_arguments)?,
            ),
            FileEditMode::ApplyPatch => EditRequest::ApplyPatch(
                serde_json::from_value::<FileEditApplyPatchInput>(call.params.clone())
                    .map_err(invalid_arguments)?,
            ),
        };

        let normalized = normalize_request(request)?;
        validate_request_paths(&normalized)?;
        let lock_paths = resolve_lock_paths(&call, &normalized)?;
        let locks = lock_paths
            .iter()
            .map(|path| self.state.write_lock(path))
            .collect::<Vec<_>>();
        let _guards = locks
            .iter()
            .map(|lock| lock.lock().unwrap())
            .collect::<Vec<_>>();

        let prepared = prepare_request(&call, &self.state, normalized)?;
        let output = commit_prepared(&call, &self.state, prepared);
        serde_json::to_value(output)
            .map_err(|error| ToolError::new("tool.internalError", error.to_string()))
    }
}

fn invalid_arguments(error: serde_json::Error) -> ToolError {
    ToolError::new("tool.invalidArguments", error.to_string())
}

fn text_description() -> String {
    concat!(
        "Apply snapshot-anchored text edits. Input contains one or more `[path#snapshotTag]` sections; copy the 8-hex tag from file_read/file_search. ",
        "All line numbers are one-based coordinates from the original snapshot. Canonical commands only: `SWAP N:` or `SWAP N-M:` followed by `+` body lines; `DEL N` or `DEL N-M`; ",
        "`INS.PRE N:`, `INS.POST N:`, `INS.HEAD:`, `INS.TAIL:` followed by `+` lines; Tree-sitter `SWAP.BLK N:`, `DEL.BLK N`, `INS.BLK.POST N:`. ",
        "`REM` deletes the whole file and must be the only command. `MV ./new/path` moves the final edited content; at most one MV per section, and the destination must not exist. ",
        "Every edited line and block must be fully covered by lines returned in the snapshot. All sections are parsed, permission-checked, conflict-checked, snapshot-checked, and rendered before any commit. Commits run in section order and are not transactional."
    )
    .to_string()
}

fn replace_description() -> String {
    concat!(
        "Replace uniquely identified text in one previously read file. Input: `{path, edits:[{oldText,newText,all?}]}`. ",
        "Each oldText must be non-empty. Without all=true it must occur exactly once in the current normalized file; with all=true every exact occurrence is replaced. ",
        "Edits are applied sequentially to the in-memory result, then written once. The target must have a current snapshot from file_read/file_search/file_write."
    )
    .to_string()
}

fn patch_description() -> String {
    concat!(
        "Apply JSON patch entries to one path. Input: `{path, edits:[{op?,rename?,diff?}]}`. op defaults to update. ",
        "For update, diff contains one or more `@@` or `@@ unique anchor` hunks; every hunk body line starts with space, `+`, or `-`, and context plus removed lines must match uniquely. ",
        "create uses diff as complete file content; delete takes no diff; update may include rename to move the final content to a missing destination. Entries execute sequentially in memory and commit after full preflight."
    )
    .to_string()
}

fn apply_patch_description() -> String {
    concat!(
        "Apply a Codex-style file patch envelope in `input`. It must begin with `*** Begin Patch` and end with `*** End Patch`. ",
        "Supported sections: `*** Add File: path` with `+` content lines; `*** Delete File: path`; `*** Update File: path`, optional `*** Move to: new/path`, then `@@ [anchor]` hunks using space/+/-. ",
        "Paths are relative to the workspace. All file operations are parsed and preflighted before sequential non-transactional commit."
    )
    .to_string()
}

enum EditRequest {
    Text(FileEditTextInput),
    Replace(FileEditReplaceInput),
    Patch(FileEditPatchInput),
    ApplyPatch(FileEditApplyPatchInput),
}

enum NormalizedRequest {
    Text(Vec<TextSection>),
    Replace(FileEditReplaceInput),
    Patch(Vec<PatchGroup>),
}

#[derive(Clone)]
struct TextSection {
    path: String,
    snapshot_reference: String,
    operations: Vec<FileEditOperation>,
    remove: bool,
    move_to: Option<String>,
}

#[derive(Clone)]
struct PatchGroup {
    actions: Vec<PatchAction>,
}

#[derive(Clone)]
struct PatchAction {
    path: String,
    op: FileEditPatchOperation,
    rename: Option<String>,
    diff: Option<String>,
    strict_create: bool,
}

struct PreparedChange {
    source_display: String,
    source_path: Option<PathBuf>,
    target_display: String,
    target_path: PathBuf,
    expected_revision: Option<String>,
    before: Option<TextFile>,
    after: Option<TextFile>,
    operation: FileEditResultOperation,
    first_changed_line: Option<usize>,
    added_lines: usize,
    removed_lines: usize,
    diff: String,
    stream_operations: Option<Vec<FileEditOperation>>,
    sparse_metadata: Option<TextMetadata>,
}

fn normalize_request(request: EditRequest) -> Result<NormalizedRequest, ToolError> {
    match request {
        EditRequest::Text(input) => Ok(NormalizedRequest::Text(parse_text_patch(&input.input)?)),
        EditRequest::Replace(input) => {
            if input.edits.is_empty() {
                return Err(ToolError::new(
                    "file.emptyOperation",
                    "replace edits cannot be empty",
                ));
            }
            Ok(NormalizedRequest::Replace(input))
        }
        EditRequest::Patch(input) => {
            if input.edits.is_empty() {
                return Err(ToolError::new(
                    "file.emptyOperation",
                    "patch edits cannot be empty",
                ));
            }
            let actions = input
                .edits
                .into_iter()
                .map(|entry| patch_entry(input.path.clone(), entry, false))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(NormalizedRequest::Patch(vec![PatchGroup { actions }]))
        }
        EditRequest::ApplyPatch(input) => Ok(NormalizedRequest::Patch(
            parse_apply_patch(&input.input)?
                .into_iter()
                .map(|action| PatchGroup {
                    actions: vec![action],
                })
                .collect(),
        )),
    }
}

fn patch_entry(
    path: String,
    entry: FileEditPatchEntry,
    strict_create: bool,
) -> Result<PatchAction, ToolError> {
    let op = entry.op.unwrap_or(FileEditPatchOperation::Update);
    match op {
        FileEditPatchOperation::Create => {
            if entry.rename.is_some() {
                return Err(ToolError::new(
                    "file.invalidPatch",
                    "create does not support rename",
                ));
            }
            if entry.diff.is_none() {
                return Err(ToolError::new(
                    "file.invalidPatch",
                    "create requires diff as complete file content",
                ));
            }
        }
        FileEditPatchOperation::Delete => {
            if entry.diff.is_some() || entry.rename.is_some() {
                return Err(ToolError::new(
                    "file.invalidPatch",
                    "delete does not accept diff or rename",
                ));
            }
        }
        FileEditPatchOperation::Update => {
            if entry.diff.as_deref().unwrap_or_default().is_empty() && entry.rename.is_none() {
                return Err(ToolError::new(
                    "file.invalidPatch",
                    "update requires diff or rename",
                ));
            }
        }
    }
    Ok(PatchAction {
        path,
        op,
        rename: entry.rename,
        diff: entry.diff,
        strict_create,
    })
}

fn validate_request_paths(request: &NormalizedRequest) -> Result<(), ToolError> {
    let mut sources = BTreeSet::new();
    let mut targets = BTreeSet::new();
    match request {
        NormalizedRequest::Text(sections) => {
            for section in sections {
                if !sources.insert(section.path.clone()) {
                    return Err(path_conflict("a source path appears more than once"));
                }
                if let Some(target) = &section.move_to {
                    if !targets.insert(target.clone()) {
                        return Err(path_conflict("a move target appears more than once"));
                    }
                }
            }
        }
        NormalizedRequest::Replace(input) => {
            sources.insert(input.path.clone());
        }
        NormalizedRequest::Patch(groups) => {
            for group in groups {
                let source = group
                    .actions
                    .first()
                    .ok_or_else(|| ToolError::new("file.emptyOperation", "patch group is empty"))?
                    .path
                    .clone();
                if !sources.insert(source) {
                    return Err(path_conflict("a source path appears more than once"));
                }
                for action in &group.actions {
                    if let Some(target) = &action.rename {
                        if !targets.insert(target.clone()) {
                            return Err(path_conflict("a rename target appears more than once"));
                        }
                    }
                }
            }
        }
    }
    if sources.iter().any(|source| targets.contains(source)) {
        return Err(path_conflict(
            "a move target conflicts with another source path",
        ));
    }
    Ok(())
}

fn path_conflict(message: &str) -> ToolError {
    ToolError::new("file.operationConflict", message)
}

fn resolve_lock_paths(
    call: &ToolCall,
    request: &NormalizedRequest,
) -> Result<Vec<PathBuf>, ToolError> {
    let mut paths = Vec::new();
    let mut canonical_sources = BTreeSet::new();
    let mut canonical_targets = BTreeSet::new();

    let mut add_source = |path: PathBuf| -> Result<(), ToolError> {
        if !canonical_sources.insert(path.clone()) {
            return Err(path_conflict(
                "multiple source paths resolve to the same canonical file",
            ));
        }
        paths.push(path);
        Ok(())
    };
    let mut pending_targets = Vec::new();

    match request {
        NormalizedRequest::Text(sections) => {
            for section in sections {
                add_source(resolve_existing(call, &section.path, true)?.1)?;
                if let Some(target) = &section.move_to {
                    let path = resolve_create(call, target)?.1;
                    reject_existing_target(&path)?;
                    pending_targets.push(path);
                }
            }
        }
        NormalizedRequest::Replace(input) => {
            add_source(resolve_existing(call, &input.path, true)?.1)?;
        }
        NormalizedRequest::Patch(groups) => {
            for group in groups {
                let first = group
                    .actions
                    .first()
                    .ok_or_else(|| ToolError::new("file.emptyOperation", "patch group is empty"))?;
                let source = match first.op {
                    FileEditPatchOperation::Create => resolve_create(call, &first.path)?.1,
                    FileEditPatchOperation::Delete | FileEditPatchOperation::Update => {
                        resolve_existing(call, &first.path, true)?.1
                    }
                };
                if first.op == FileEditPatchOperation::Create && first.strict_create {
                    reject_existing_target(&source)?;
                }
                add_source(source)?;
                for action in &group.actions {
                    if let Some(rename) = &action.rename {
                        let target = resolve_create(call, rename)?.1;
                        reject_existing_target(&target)?;
                        pending_targets.push(target);
                    }
                }
            }
        }
    }

    for target in pending_targets {
        if canonical_sources.contains(&target) {
            return Err(path_conflict(
                "a move target resolves to another source file",
            ));
        }
        if !canonical_targets.insert(target.clone()) {
            return Err(path_conflict(
                "multiple move targets resolve to the same canonical path",
            ));
        }
        paths.push(target);
    }

    paths.sort();
    paths.dedup();
    Ok(paths)
}

fn reject_existing_target(path: &Path) -> Result<(), ToolError> {
    if path.symlink_metadata().is_ok() {
        Err(ToolError::new(
            "file.alreadyExists",
            "destination already exists",
        ))
    } else {
        Ok(())
    }
}

fn prepare_request(
    call: &ToolCall,
    state: &FileToolState,
    request: NormalizedRequest,
) -> Result<Vec<PreparedChange>, ToolError> {
    match request {
        NormalizedRequest::Text(sections) => sections
            .into_iter()
            .map(|section| prepare_text_section(call, state, section))
            .collect(),
        NormalizedRequest::Replace(input) => Ok(vec![prepare_replace(call, state, input)?]),
        NormalizedRequest::Patch(groups) => groups
            .into_iter()
            .map(|group| prepare_patch_group(call, state, group))
            .collect(),
    }
}

fn prepare_text_section(
    call: &ToolCall,
    state: &FileToolState,
    section: TextSection,
) -> Result<PreparedChange, ToolError> {
    let (requested, source_path) = resolve_existing(call, &section.path, true)?;
    if !source_path.is_file() {
        return Err(ToolError::new("file.notFile", "path is not a file"));
    }
    let snapshot = state
        .snapshots
        .lock()
        .unwrap()
        .get(&section.snapshot_reference)?;
    ensure_snapshot_path(&snapshot, &source_path)?;
    let metadata = TextMetadata::inspect(&source_path)?;

    if section.remove {
        if metadata.revision != snapshot.revision {
            return Err(revision_mismatch("file changed since the snapshot"));
        }
        let before = (metadata.total_bytes <= FULL_SNAPSHOT_LIMIT)
            .then(|| TextFile::read(&source_path))
            .transpose()?;
        return Ok(PreparedChange {
            source_display: requested.raw.clone(),
            source_path: Some(source_path.clone()),
            target_display: requested.raw,
            target_path: source_path,
            expected_revision: Some(metadata.revision.clone()),
            before,
            after: None,
            operation: FileEditResultOperation::Delete,
            first_changed_line: None,
            added_lines: 0,
            removed_lines: metadata.total_lines,
            diff: "delete entire file".to_string(),
            stream_operations: None,
            sparse_metadata: Some(metadata),
        });
    }

    let target = if let Some(move_to) = &section.move_to {
        let (target_requested, target_path) = resolve_create(call, move_to)?;
        reject_existing_target(&target_path)?;
        (
            target_requested.raw,
            target_path,
            FileEditResultOperation::Move,
        )
    } else {
        (
            requested.raw.clone(),
            source_path.clone(),
            FileEditResultOperation::Update,
        )
    };

    if metadata.total_bytes > FULL_SNAPSHOT_LIMIT {
        if !matches!(snapshot.content, SnapshotContent::Sparse) {
            return Err(ToolError::new(
                "file.snapshotInvalid",
                "large file requires a sparse snapshot",
            ));
        }
        if metadata.revision != snapshot.revision {
            return Err(revision_mismatch(
                "sparse snapshot changed and cannot be recovered",
            ));
        }
        if section.operations.iter().any(|operation| {
            matches!(
                operation,
                FileEditOperation::ReplaceBlock { .. }
                    | FileEditOperation::DeleteBlock { .. }
                    | FileEditOperation::InsertBlockPost { .. }
            )
        }) {
            return Err(ToolError::new(
                "file.blockUnsupportedForLargeFile",
                "Tree-sitter block edits require a file small enough for structural parsing; use explicit line ranges",
            ));
        }
        validate_operations(
            &section.operations,
            &snapshot.seen_lines,
            snapshot.total_lines,
        )?;
        validate_geometry(&section.operations, metadata.total_lines)?;
        let (added, removed, first) = operation_counts(&section.operations, metadata.total_lines);
        return Ok(PreparedChange {
            source_display: requested.raw,
            source_path: Some(source_path),
            target_display: target.0,
            target_path: target.1,
            expected_revision: Some(metadata.revision.clone()),
            before: None,
            after: None,
            operation: target.2,
            first_changed_line: first,
            added_lines: added,
            removed_lines: removed,
            diff: format!(
                "streaming edit: +{added} -{removed}, first changed line {}",
                first.unwrap_or(1)
            ),
            stream_operations: Some(section.operations),
            sparse_metadata: Some(metadata),
        });
    }

    let current = TextFile::read(&source_path)?;
    let source = match &snapshot.content {
        SnapshotContent::Full(content) => content.clone(),
        SnapshotContent::Sparse => current.normalized(),
    };
    validate_block_coverage(
        &source_path,
        &source,
        &section.operations,
        &snapshot.seen_lines,
    )?;
    let operations = expand_block_operations(&source_path, &source, section.operations)?;
    validate_operations(&operations, &snapshot.seen_lines, snapshot.total_lines)?;
    let operations = if current.revision == snapshot.revision {
        operations
    } else {
        match &snapshot.content {
            SnapshotContent::Full(old) => remap_exact(&operations, old, &current.lines)?,
            SnapshotContent::Sparse => {
                return Err(revision_mismatch(
                    "sparse snapshot changed and cannot be recovered",
                ));
            }
        }
    };
    validate_geometry(&operations, current.lines.len())?;

    let before = current.clone();
    let mut after = current.clone();
    let (added, removed, first) = if operations.is_empty() {
        (0, 0, None)
    } else {
        let (added, removed, first) = apply_line_operations(&mut after, &operations)?;
        (added, removed, Some(first))
    };

    Ok(PreparedChange {
        source_display: requested.raw,
        source_path: Some(source_path),
        target_display: target.0,
        target_path: target.1,
        expected_revision: Some(before.revision.clone()),
        before: Some(before.clone()),
        after: Some(after.clone()),
        operation: target.2,
        first_changed_line: first,
        added_lines: added,
        removed_lines: removed,
        diff: compact_diff(&before.lines, &after.lines, first.unwrap_or(1)),
        stream_operations: None,
        sparse_metadata: None,
    })
}

fn operation_counts(
    operations: &[FileEditOperation],
    total_lines: usize,
) -> (usize, usize, Option<usize>) {
    let mut added = 0usize;
    let mut removed = 0usize;
    let mut first = None;
    for operation in operations {
        match operation {
            FileEditOperation::Replace {
                start_line,
                end_line,
                lines,
            } => {
                let sentinel =
                    *end_line == total_lines && lines.last().is_some_and(String::is_empty);
                added += lines.len().saturating_sub(usize::from(sentinel));
                removed += end_line - start_line + 1;
                first = Some(first.map_or(*start_line, |value: usize| value.min(*start_line)));
            }
            FileEditOperation::Delete {
                start_line,
                end_line,
            } => {
                removed += end_line - start_line + 1;
                first = Some(first.map_or(*start_line, |value: usize| value.min(*start_line)));
            }
            FileEditOperation::Insert { at, line, lines } => {
                let boundary = match at {
                    InsertAt::Head => 0,
                    InsertAt::Tail => total_lines,
                    InsertAt::Before => line.unwrap() - 1,
                    InsertAt::After => line.unwrap(),
                };
                let controls_eof = boundary == total_lines;
                let sentinel = controls_eof && lines.last().is_some_and(String::is_empty);
                added += lines.len().saturating_sub(usize::from(sentinel));
                let changed = boundary.saturating_add(1).max(1);
                first = Some(first.map_or(changed, |value: usize| value.min(changed)));
            }
            _ => {}
        }
    }
    (added, removed, first)
}

fn prepare_replace(
    call: &ToolCall,
    state: &FileToolState,
    input: FileEditReplaceInput,
) -> Result<PreparedChange, ToolError> {
    let (requested, path) = resolve_existing(call, &input.path, true)?;
    let snapshot = state.snapshots.lock().unwrap().latest_for_path(&path)?;
    let current = TextFile::read(&path)?;
    if snapshot.revision != current.revision {
        return Err(revision_mismatch(
            "file changed since it was last read or searched",
        ));
    }
    let before = current.clone();
    let mut normalized = current.normalized();
    for edit in input.edits {
        if edit.old_text.is_empty() {
            return Err(ToolError::new(
                "file.invalidReplacement",
                "oldText must not be empty",
            ));
        }
        let old = normalize_newlines(&edit.old_text);
        let new = normalize_newlines(&edit.new_text);
        normalized = replace_unique_text(&normalized, &old, &new, edit.all.unwrap_or(false))?;
    }
    let after = TextFile::from_normalized(&current, &normalized)?;
    let first = first_changed_line(&before.lines, &after.lines);
    let (added, removed) = line_delta(&before.lines, &after.lines);
    Ok(PreparedChange {
        source_display: requested.raw.clone(),
        source_path: Some(path.clone()),
        target_display: requested.raw,
        target_path: path,
        expected_revision: Some(before.revision.clone()),
        before: Some(before.clone()),
        after: Some(after.clone()),
        operation: FileEditResultOperation::Update,
        first_changed_line: first,
        added_lines: added,
        removed_lines: removed,
        diff: compact_diff(&before.lines, &after.lines, first.unwrap_or(1)),
        stream_operations: None,
        sparse_metadata: None,
    })
}

fn prepare_patch_group(
    call: &ToolCall,
    state: &FileToolState,
    group: PatchGroup,
) -> Result<PreparedChange, ToolError> {
    let first = group
        .actions
        .first()
        .ok_or_else(|| ToolError::new("file.emptyOperation", "patch group is empty"))?;
    let (requested, source_path) = match first.op {
        FileEditPatchOperation::Create => resolve_create(call, &first.path)?,
        FileEditPatchOperation::Delete | FileEditPatchOperation::Update => {
            resolve_existing(call, &first.path, true)?
        }
    };
    let source_existed = source_path.symlink_metadata().is_ok();
    let before = source_existed
        .then(|| TextFile::read(&source_path))
        .transpose()?;
    if source_existed {
        require_recent_snapshot(state, &source_path)?;
    }

    let mut current = before.clone();
    let mut target_display = requested.raw.clone();
    let mut target_path = source_path.clone();
    let mut moved = false;
    let mut declared_create = false;

    for (index, action) in group.actions.iter().enumerate() {
        if action.path != first.path {
            return Err(path_conflict(
                "all entries in a patch group must use the same path",
            ));
        }
        match action.op {
            FileEditPatchOperation::Create => {
                if index != 0 {
                    return Err(path_conflict("create may only be the first patch entry"));
                }
                if action.strict_create && source_existed {
                    return Err(ToolError::new(
                        "file.alreadyExists",
                        "apply_patch Add File cannot overwrite an existing path",
                    ));
                }
                let template = current.clone().unwrap_or(TextFile {
                    bom: false,
                    final_newline: false,
                    line_ending: "\n",
                    lines: Vec::new(),
                    revision: String::new(),
                    total_bytes: 0,
                });
                current = Some(TextFile::from_normalized(
                    &template,
                    action.diff.as_deref().unwrap_or_default(),
                )?);
                declared_create = true;
            }
            FileEditPatchOperation::Delete => {
                if index + 1 != group.actions.len() {
                    return Err(path_conflict("delete must be the final patch entry"));
                }
                if current.is_none() {
                    return Err(ToolError::new(
                        "file.notFound",
                        "delete target does not exist",
                    ));
                }
                current = None;
            }
            FileEditPatchOperation::Update => {
                let existing = current.as_ref().ok_or_else(|| {
                    ToolError::new("file.notFound", "update target does not exist")
                })?;
                let normalized = match action.diff.as_deref() {
                    Some(diff) if !diff.is_empty() => {
                        apply_context_patch(&existing.normalized(), diff)?
                    }
                    _ => existing.normalized(),
                };
                current = Some(TextFile::from_normalized(existing, &normalized)?);
                if let Some(rename) = &action.rename {
                    if moved {
                        return Err(path_conflict("a patch group may rename at most once"));
                    }
                    let (target_requested, resolved_target) = resolve_create(call, rename)?;
                    reject_existing_target(&resolved_target)?;
                    target_display = target_requested.raw;
                    target_path = resolved_target;
                    moved = true;
                }
            }
        }
    }

    let before_lines = before
        .as_ref()
        .map(|text| text.lines.clone())
        .unwrap_or_default();
    let after_lines = current
        .as_ref()
        .map(|text| text.lines.clone())
        .unwrap_or_default();
    let first_changed = first_changed_line(&before_lines, &after_lines);
    let (added, removed) = line_delta(&before_lines, &after_lines);
    let operation = if current.is_none() {
        FileEditResultOperation::Delete
    } else if moved {
        FileEditResultOperation::Move
    } else if declared_create {
        FileEditResultOperation::Create
    } else {
        FileEditResultOperation::Update
    };

    Ok(PreparedChange {
        source_display: requested.raw,
        source_path: source_existed.then_some(source_path),
        target_display,
        target_path,
        expected_revision: before.as_ref().map(|text| text.revision.clone()),
        before: before.clone(),
        after: current,
        operation,
        first_changed_line: first_changed,
        added_lines: added,
        removed_lines: removed,
        diff: compact_diff(&before_lines, &after_lines, first_changed.unwrap_or(1)),
        stream_operations: None,
        sparse_metadata: None,
    })
}

fn require_recent_snapshot(state: &FileToolState, path: &Path) -> Result<(), ToolError> {
    let snapshot = state.snapshots.lock().unwrap().latest_for_path(path)?;
    let current = TextFile::read(path)?;
    if snapshot.revision != current.revision {
        return Err(revision_mismatch(
            "file changed since it was last read or searched",
        ));
    }
    Ok(())
}

fn commit_prepared(
    call: &ToolCall,
    state: &FileToolState,
    changes: Vec<PreparedChange>,
) -> FileEditOutput {
    let mut files = Vec::new();
    let mut applied_files = Vec::new();
    for (index, change) in changes.iter().enumerate() {
        match commit_change(call, state, change) {
            Ok(output) => {
                applied_files.push(output.path.clone());
                files.push(output);
            }
            Err(error) => {
                return FileEditOutput {
                    files,
                    applied_files,
                    failed_file: Some(change.source_display.clone()),
                    skipped_files: changes[index + 1..]
                        .iter()
                        .map(|pending| pending.source_display.clone())
                        .collect(),
                    failure_message: Some(error.message),
                };
            }
        }
    }
    FileEditOutput {
        files,
        applied_files,
        failed_file: None,
        skipped_files: Vec::new(),
        failure_message: None,
    }
}

fn commit_change(
    call: &ToolCall,
    state: &FileToolState,
    change: &PreparedChange,
) -> Result<FileEditFileOutput, ToolError> {
    verify_expected_state(call, change)?;
    match change.operation {
        FileEditResultOperation::Delete => {
            let source = change.source_path.as_ref().unwrap();
            fs::remove_file(source)
                .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
            state.snapshots.lock().unwrap().remove_path(source);
            Ok(FileEditFileOutput {
                path: change.source_display.clone(),
                snapshot_id: None,
                snapshot_tag: None,
                revision: None,
                header: None,
                operation: FileEditResultOperation::Delete,
                moved_from: None,
                diff: change.diff.clone(),
                added_lines: change.added_lines,
                removed_lines: change.removed_lines,
                first_changed_line: None,
                total_lines: None,
                total_bytes: None,
                preview: None,
                preview_range: None,
                truncated: false,
            })
        }
        FileEditResultOperation::Move => {
            let source = change.source_path.as_ref().unwrap();
            reject_existing_target(&change.target_path)?;
            if let Some(operations) = &change.stream_operations {
                if operations.is_empty() {
                    fs::rename(source, &change.target_path)
                        .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
                } else {
                    stream_rewrite(
                        source,
                        &change.target_path,
                        operations,
                        change.sparse_metadata.as_ref().unwrap(),
                    )?;
                    fs::remove_file(source)
                        .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
                }
                let metadata = TextMetadata::inspect(&change.target_path)?;
                let mut snapshots = state.snapshots.lock().unwrap();
                snapshots.migrate_path(source, &change.target_path);
                let snapshot = snapshots.remember_sparse(
                    &change.target_path,
                    &metadata,
                    preview_seen(change.first_changed_line, metadata.total_lines),
                );
                drop(snapshots);
                return render_sparse_output(change, &metadata, snapshot.id, snapshot.tag);
            }
            let after = change.after.as_ref().unwrap();
            atomic_write(source, &after.encoded(), change.before.as_ref())?;
            fs::rename(source, &change.target_path)
                .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
            let text = TextFile::read(&change.target_path)?;
            let mut snapshots = state.snapshots.lock().unwrap();
            snapshots.migrate_path(source, &change.target_path);
            let snapshot = snapshots.remember(
                &change.target_path,
                &text,
                preview_seen(change.first_changed_line, text.lines.len()),
            );
            drop(snapshots);
            Ok(render_output(change, &text, snapshot.id, snapshot.tag))
        }
        FileEditResultOperation::Create | FileEditResultOperation::Update => {
            if let Some(operations) = &change.stream_operations {
                let source = change.source_path.as_ref().unwrap();
                stream_rewrite(
                    source,
                    &change.target_path,
                    operations,
                    change.sparse_metadata.as_ref().unwrap(),
                )?;
                let metadata = TextMetadata::inspect(&change.target_path)?;
                let snapshot = state.snapshots.lock().unwrap().remember_sparse(
                    &change.target_path,
                    &metadata,
                    preview_seen(change.first_changed_line, metadata.total_lines),
                );
                return render_sparse_output(change, &metadata, snapshot.id, snapshot.tag);
            }
            let after = change.after.as_ref().unwrap();
            atomic_write(
                &change.target_path,
                &after.encoded(),
                change.before.as_ref(),
            )?;
            let text = TextFile::read(&change.target_path)?;
            let snapshot = state.snapshots.lock().unwrap().remember(
                &change.target_path,
                &text,
                preview_seen(change.first_changed_line, text.lines.len()),
            );
            Ok(render_output(change, &text, snapshot.id, snapshot.tag))
        }
    }
}

fn render_sparse_output(
    change: &PreparedChange,
    metadata: &TextMetadata,
    snapshot_id: String,
    snapshot_tag: String,
) -> Result<FileEditFileOutput, ToolError> {
    let header = format!("[{}#{}]", change.target_display, snapshot_tag);
    let seen = preview_seen(change.first_changed_line, metadata.total_lines);
    let (preview, preview_range, truncated) =
        if let (Some(start), Some(end)) = (seen.first().copied(), seen.last().copied()) {
            let selected =
                TextMetadata::read_selected(&change.target_path, &[(start, end)], 256 * 1024)?;
            let body = selected
                .lines
                .iter()
                .map(|(line, text)| format!("{line}:{text}"))
                .collect::<Vec<_>>()
                .join("\n");
            (
                Some(if body.is_empty() {
                    header.clone()
                } else {
                    format!("{header}\n{body}")
                }),
                Some(ReturnedRange {
                    start_line: start,
                    end_line: selected
                        .lines
                        .last()
                        .map(|(line, _)| *line)
                        .unwrap_or(start),
                }),
                selected.next_line.is_some() || end < metadata.total_lines,
            )
        } else {
            (Some(header.clone()), None, false)
        };
    Ok(FileEditFileOutput {
        path: change.target_display.clone(),
        snapshot_id: Some(snapshot_id),
        snapshot_tag: Some(snapshot_tag),
        revision: Some(metadata.revision.clone()),
        header: Some(header),
        operation: change.operation,
        moved_from: matches!(change.operation, FileEditResultOperation::Move)
            .then(|| change.source_display.clone()),
        diff: change.diff.clone(),
        added_lines: change.added_lines,
        removed_lines: change.removed_lines,
        first_changed_line: change.first_changed_line,
        total_lines: Some(metadata.total_lines),
        total_bytes: Some(metadata.total_bytes),
        preview,
        preview_range,
        truncated,
    })
}

fn stream_rewrite(
    source: &Path,
    target: &Path,
    operations: &[FileEditOperation],
    metadata: &TextMetadata,
) -> Result<(), ToolError> {
    let parent = target
        .parent()
        .ok_or_else(|| ToolError::new("file.writeFailed", "target has no parent"))?;
    fs::create_dir_all(parent)
        .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
    let permissions = fs::metadata(source)
        .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?
        .permissions();
    let mut temp = NamedTempFile::new_in(parent)
        .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;

    let mut replacements = BTreeMap::<usize, (usize, Vec<String>)>::new();
    let mut insertions = BTreeMap::<usize, Vec<String>>::new();
    let mut final_newline = metadata.final_newline;
    let mut eof_controller = false;
    for operation in operations {
        match operation {
            FileEditOperation::Replace {
                start_line,
                end_line,
                lines,
            } => {
                let mut body = lines.clone();
                if *end_line == metadata.total_lines {
                    if eof_controller {
                        return Err(path_conflict(
                            "multiple operations control the end-of-file newline",
                        ));
                    }
                    eof_controller = true;
                    final_newline = body.last().is_some_and(String::is_empty);
                    if final_newline {
                        body.pop();
                    }
                }
                replacements.insert(*start_line, (*end_line, body));
            }
            FileEditOperation::Delete {
                start_line,
                end_line,
            } => {
                replacements.insert(*start_line, (*end_line, Vec::new()));
            }
            FileEditOperation::Insert { at, line, lines } => {
                let boundary = match at {
                    InsertAt::Head => 0,
                    InsertAt::Tail => metadata.total_lines,
                    InsertAt::Before => line.unwrap() - 1,
                    InsertAt::After => line.unwrap(),
                };
                let mut body = lines.clone();
                if boundary == metadata.total_lines {
                    if eof_controller {
                        return Err(path_conflict(
                            "multiple operations control the end-of-file newline",
                        ));
                    }
                    eof_controller = true;
                    final_newline = body.last().is_some_and(String::is_empty);
                    if final_newline {
                        body.pop();
                    }
                }
                insertions.insert(boundary, body);
            }
            _ => {
                return Err(ToolError::new(
                    "file.invalidPatch",
                    "large-file streaming edit received an unexpanded block operation",
                ));
            }
        }
    }

    if metadata.bom {
        temp.write_all(&[0xEF, 0xBB, 0xBF])
            .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
    }
    let separator = metadata.line_ending.as_bytes();
    let mut wrote_line = false;
    let mut write_line = |line: &str, temp: &mut NamedTempFile| -> Result<(), ToolError> {
        if wrote_line {
            temp.write_all(separator)
                .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
        }
        temp.write_all(line.as_bytes())
            .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
        wrote_line = true;
        Ok(())
    };

    let file = fs::File::open(source)
        .map_err(|error| ToolError::new("file.notFound", error.to_string()))?;
    let mut reader = BufReader::new(file);
    let mut buffer = Vec::new();
    let mut line_no = 0usize;
    let mut skip_until = 0usize;
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
        if let Some(lines) = insertions.get(&(line_no - 1)) {
            for line in lines {
                write_line(line, &mut temp)?;
            }
        }
        if line_no <= skip_until {
            continue;
        }
        if let Some((end, lines)) = replacements.get(&line_no) {
            for line in lines {
                write_line(line, &mut temp)?;
            }
            skip_until = *end;
            continue;
        }
        let mut content = buffer.as_slice();
        if line_no == 1 && content.starts_with(&[0xEF, 0xBB, 0xBF]) {
            content = &content[3..];
        }
        content = content.strip_suffix(b"\n").unwrap_or(content);
        content = content.strip_suffix(b"\r").unwrap_or(content);
        let line = std::str::from_utf8(content)
            .map_err(|_| ToolError::new("file.notText", "file is not valid UTF-8"))?;
        write_line(line, &mut temp)?;
    }
    if let Some(lines) = insertions.get(&metadata.total_lines) {
        for line in lines {
            write_line(line, &mut temp)?;
        }
    }
    if final_newline && wrote_line {
        temp.write_all(separator)
            .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
    }
    temp.flush()
        .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
    temp.as_file()
        .set_permissions(permissions)
        .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
    temp.persist(target)
        .map_err(|error| ToolError::new("file.writeFailed", error.error.to_string()))?;
    Ok(())
}

fn render_output(
    change: &PreparedChange,
    text: &TextFile,
    snapshot_id: String,
    snapshot_tag: String,
) -> FileEditFileOutput {
    let header = format!("[{}#{}]", change.target_display, snapshot_tag);
    let (preview, preview_range, truncated) =
        preview_text(text, change.first_changed_line, &header);
    FileEditFileOutput {
        path: change.target_display.clone(),
        snapshot_id: Some(snapshot_id),
        snapshot_tag: Some(snapshot_tag),
        revision: Some(text.revision.clone()),
        header: Some(header),
        operation: change.operation,
        moved_from: matches!(change.operation, FileEditResultOperation::Move)
            .then(|| change.source_display.clone()),
        diff: change.diff.clone(),
        added_lines: change.added_lines,
        removed_lines: change.removed_lines,
        first_changed_line: change.first_changed_line,
        total_lines: Some(text.lines.len()),
        total_bytes: Some(text.total_bytes),
        preview,
        preview_range,
        truncated,
    }
}

fn verify_expected_state(call: &ToolCall, change: &PreparedChange) -> Result<(), ToolError> {
    if let Some(source) = &change.source_path {
        let (_, verified) = resolve_existing(call, &change.source_display, true)?;
        if &verified != source {
            return Err(ToolError::new(
                "file.writeFailed",
                "source path changed during preflight",
            ));
        }
        if let Some(expected) = &change.expected_revision {
            let current = TextMetadata::inspect(source)?;
            if &current.revision != expected {
                return Err(revision_mismatch("file changed during preflight"));
            }
        }
    }
    if matches!(change.operation, FileEditResultOperation::Move) {
        reject_existing_target(&change.target_path)?;
    }
    Ok(())
}

fn atomic_write(path: &Path, bytes: &[u8], existing: Option<&TextFile>) -> Result<(), ToolError> {
    let parent = path
        .parent()
        .ok_or_else(|| ToolError::new("file.writeFailed", "target has no parent"))?;
    fs::create_dir_all(parent)
        .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
    let permissions = if existing.is_some() && path.exists() {
        Some(
            fs::metadata(path)
                .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?
                .permissions(),
        )
    } else {
        None
    };
    let mut temp = NamedTempFile::new_in(parent)
        .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
    temp.write_all(bytes)
        .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
    temp.flush()
        .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
    if let Some(permissions) = permissions {
        temp.as_file()
            .set_permissions(permissions)
            .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
    }
    temp.persist(path)
        .map_err(|error| ToolError::new("file.writeFailed", error.error.to_string()))?;
    Ok(())
}

fn preview_seen(first: Option<usize>, total: usize) -> Vec<usize> {
    let first = first.unwrap_or(1).max(1);
    let start = first.saturating_sub(3).max(1);
    let end = total.min(first.saturating_add(20));
    if start > end {
        Vec::new()
    } else {
        (start..=end).collect()
    }
}

fn preview_text(
    text: &TextFile,
    first: Option<usize>,
    header: &str,
) -> (Option<String>, Option<ReturnedRange>, bool) {
    let seen = preview_seen(first, text.lines.len());
    let Some(start) = seen.first().copied() else {
        return (Some(header.to_string()), None, false);
    };
    let end = *seen.last().unwrap();
    let body = seen
        .iter()
        .map(|line| format!("{line}:{}", text.lines[*line - 1]))
        .collect::<Vec<_>>()
        .join("\n");
    (
        Some(format!("{header}\n{body}")),
        Some(ReturnedRange {
            start_line: start,
            end_line: end,
        }),
        end < text.lines.len(),
    )
}

fn parse_text_patch(input: &str) -> Result<Vec<TextSection>, ToolError> {
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
                "expected [path#snapshotTag] header",
            ));
        }
        let inner = &header[1..header.len() - 1];
        let (path, snapshot_reference) = inner
            .rsplit_once('#')
            .ok_or_else(|| ToolError::new("file.invalidPatch", "header requires a snapshot tag"))?;
        index += 1;
        let mut operations = Vec::new();
        let mut remove = false;
        let mut move_to = None;
        while index < lines.len() && !lines[index].trim().starts_with('[') {
            if lines[index].trim().is_empty() {
                index += 1;
                continue;
            }
            let command = lines[index].trim().trim_end_matches(':').to_string();
            index += 1;
            if command == "REM" {
                if remove || !operations.is_empty() || move_to.is_some() {
                    return Err(path_conflict("REM must be the only section command"));
                }
                remove = true;
                continue;
            }
            if let Some(destination) = command.strip_prefix("MV ") {
                if remove || move_to.is_some() {
                    return Err(path_conflict("a section may contain at most one MV"));
                }
                move_to = Some(destination.trim().to_string());
                continue;
            }
            if remove {
                return Err(path_conflict("REM must be the only section command"));
            }
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
            operations.push(parse_text_command(&command, body)?);
        }
        if !remove && operations.is_empty() && move_to.is_none() {
            return Err(ToolError::new(
                "file.emptyOperation",
                "patch section has no operation",
            ));
        }
        sections.push(TextSection {
            path: path.to_string(),
            snapshot_reference: snapshot_reference.to_ascii_uppercase(),
            operations,
            remove,
            move_to,
        });
    }
    if sections.is_empty() {
        return Err(ToolError::new(
            "file.emptyOperation",
            "patch contains no sections",
        ));
    }
    Ok(sections)
}

fn parse_text_command(command: &str, body: Vec<String>) -> Result<FileEditOperation, ToolError> {
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
        format!("unknown text edit command: {command}"),
    ))
}

fn parse_range(value: &str) -> Result<(usize, usize), ToolError> {
    let value = value.trim();
    if value.contains(".=") || value.contains("..") || value.split_whitespace().count() > 1 {
        return Err(ToolError::new(
            "file.invalidPatch",
            "ranges must use only N or N-M",
        ));
    }
    if let Some((start, end)) = value.split_once('-') {
        Ok((parse_line(start)?, parse_line(end)?))
    } else {
        let line = parse_line(value)?;
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

fn parse_apply_patch(input: &str) -> Result<Vec<PatchAction>, ToolError> {
    let mut lines = input.trim().lines().collect::<Vec<_>>();
    if lines
        .first()
        .is_some_and(|line| matches!(line.trim(), "<<EOF" | "<<'EOF'" | "<<\"EOF\""))
        && lines.last().is_some_and(|line| line.trim() == "EOF")
    {
        lines = lines[1..lines.len() - 1].to_vec();
    }
    if lines.first().map(|line| line.trim()) != Some("*** Begin Patch") {
        return Err(ToolError::new(
            "file.invalidPatch",
            "first line must be *** Begin Patch",
        ));
    }
    if lines.last().map(|line| line.trim()) != Some("*** End Patch") {
        return Err(ToolError::new(
            "file.invalidPatch",
            "last line must be *** End Patch",
        ));
    }

    let mut actions = Vec::new();
    let mut index = 1;
    while index + 1 < lines.len() {
        if lines[index].trim().is_empty() {
            index += 1;
            continue;
        }
        let line = lines[index].trim();
        if let Some(path) = line.strip_prefix("*** Add File: ") {
            let path = normalize_apply_path(path)?;
            index += 1;
            let mut content = Vec::new();
            while index + 1 < lines.len() && lines[index].starts_with('+') {
                content.push(lines[index][1..].to_string());
                index += 1;
            }
            actions.push(PatchAction {
                path,
                op: FileEditPatchOperation::Create,
                rename: None,
                diff: Some(format!("{}\n", content.join("\n"))),
                strict_create: true,
            });
            continue;
        }
        if let Some(path) = line.strip_prefix("*** Delete File: ") {
            actions.push(PatchAction {
                path: normalize_apply_path(path)?,
                op: FileEditPatchOperation::Delete,
                rename: None,
                diff: None,
                strict_create: true,
            });
            index += 1;
            continue;
        }
        if let Some(path) = line.strip_prefix("*** Update File: ") {
            let path = normalize_apply_path(path)?;
            index += 1;
            let rename = if index + 1 < lines.len() {
                lines[index]
                    .trim()
                    .strip_prefix("*** Move to: ")
                    .map(normalize_apply_path)
                    .transpose()?
            } else {
                None
            };
            if rename.is_some() {
                index += 1;
            }
            let mut diff = Vec::new();
            while index + 1 < lines.len()
                && !lines[index].starts_with("*** Add File: ")
                && !lines[index].starts_with("*** Delete File: ")
                && !lines[index].starts_with("*** Update File: ")
            {
                diff.push(lines[index]);
                index += 1;
            }
            if diff.is_empty() && rename.is_none() {
                return Err(ToolError::new(
                    "file.invalidPatch",
                    "Update File requires hunks or Move to",
                ));
            }
            actions.push(PatchAction {
                path,
                op: FileEditPatchOperation::Update,
                rename,
                diff: Some(diff.join("\n")),
                strict_create: true,
            });
            continue;
        }
        return Err(ToolError::new(
            "file.invalidPatch",
            format!("invalid apply_patch section header: {line}"),
        ));
    }
    if actions.is_empty() {
        return Err(ToolError::new(
            "file.emptyOperation",
            "apply_patch contains no file operations",
        ));
    }
    Ok(actions)
}

fn normalize_apply_path(path: &str) -> Result<String, ToolError> {
    let path = path.trim();
    if path.starts_with('/') {
        return Err(ToolError::new(
            "file.invalidPath",
            "apply_patch paths must be relative",
        ));
    }
    Ok(if path.starts_with("./") {
        path.to_string()
    } else {
        format!("./{path}")
    })
}

#[derive(Clone)]
struct ContextHunk {
    anchor: Option<String>,
    lines: Vec<(char, String)>,
}

fn apply_context_patch(content: &str, diff: &str) -> Result<String, ToolError> {
    let hunks = parse_context_hunks(diff)?;
    let mut lines = split_lines(content);
    for hunk in hunks {
        let old = hunk
            .lines
            .iter()
            .filter_map(|(kind, line)| (*kind != '+').then_some(line.clone()))
            .collect::<Vec<_>>();
        if old.is_empty() {
            return Err(ToolError::new(
                "file.invalidPatch",
                "update hunk needs context or removed lines",
            ));
        }
        let start = find_unique_hunk(&lines, &old, hunk.anchor.as_deref())?;
        let mut source_index = start;
        let mut replacement = Vec::new();
        for (kind, line) in &hunk.lines {
            match kind {
                ' ' => {
                    replacement.push(lines[source_index].clone());
                    source_index += 1;
                }
                '-' => source_index += 1,
                '+' => replacement.push(line.clone()),
                _ => unreachable!(),
            }
        }
        lines.splice(start..start + old.len(), replacement);
    }
    Ok(join_lines(&lines, content.ends_with('\n')))
}

fn parse_context_hunks(diff: &str) -> Result<Vec<ContextHunk>, ToolError> {
    let mut hunks = Vec::new();
    let mut current: Option<ContextHunk> = None;
    for raw in diff.lines() {
        if raw == "*** End of File" {
            continue;
        }
        if let Some(header) = raw.strip_prefix("@@") {
            if let Some(hunk) = current.take() {
                validate_hunk(&hunk)?;
                hunks.push(hunk);
            }
            current = Some(ContextHunk {
                anchor: (!header.trim().is_empty()).then(|| header.trim().to_string()),
                lines: Vec::new(),
            });
            continue;
        }
        let Some(hunk) = current.as_mut() else {
            if raw.trim().is_empty() {
                continue;
            }
            return Err(ToolError::new(
                "file.invalidPatch",
                "patch body must begin with @@",
            ));
        };
        let mut chars = raw.chars();
        let kind = chars
            .next()
            .ok_or_else(|| ToolError::new("file.invalidPatch", "empty hunk line is invalid"))?;
        if !matches!(kind, ' ' | '+' | '-') {
            return Err(ToolError::new(
                "file.invalidPatch",
                "hunk lines must begin with space, +, or -",
            ));
        }
        hunk.lines.push((kind, chars.collect()));
    }
    if let Some(hunk) = current {
        validate_hunk(&hunk)?;
        hunks.push(hunk);
    }
    if hunks.is_empty() {
        return Err(ToolError::new(
            "file.invalidPatch",
            "patch contains no @@ hunks",
        ));
    }
    Ok(hunks)
}

fn validate_hunk(hunk: &ContextHunk) -> Result<(), ToolError> {
    if hunk.lines.is_empty() || !hunk.lines.iter().any(|(kind, _)| matches!(kind, '+' | '-')) {
        return Err(ToolError::new(
            "file.invalidPatch",
            "each hunk must contain at least one changed line",
        ));
    }
    Ok(())
}

fn find_unique_hunk(
    lines: &[String],
    needle: &[String],
    anchor: Option<&str>,
) -> Result<usize, ToolError> {
    let minimum_start = if let Some(anchor) = anchor {
        let positions = lines
            .iter()
            .enumerate()
            .filter_map(|(index, line)| line.contains(anchor).then_some(index))
            .collect::<Vec<_>>();
        match positions.as_slice() {
            [position] => *position,
            [] => {
                return Err(ToolError::new(
                    "file.patchNoMatch",
                    "patch anchor was not found",
                ));
            }
            _ => {
                return Err(ToolError::new(
                    "file.patchAmbiguous",
                    "patch anchor matches multiple lines; use a more specific anchor",
                ));
            }
        }
    } else {
        0
    };

    let exact = hunk_hits(lines, needle, minimum_start, false);
    let hits = if exact.is_empty() {
        hunk_hits(lines, needle, minimum_start, true)
    } else {
        exact
    };
    match hits.as_slice() {
        [start] => Ok(*start),
        [] => Err(ToolError::new(
            "file.patchNoMatch",
            "no exact or whitespace-normalized match found for patch hunk",
        )),
        _ => Err(ToolError::new(
            "file.patchAmbiguous",
            "patch hunk matches multiple locations; add more context or a unique anchor",
        )),
    }
}

fn hunk_hits(lines: &[String], needle: &[String], minimum_start: usize, trim: bool) -> Vec<usize> {
    if needle.len() > lines.len() {
        return Vec::new();
    }
    (minimum_start..=lines.len() - needle.len())
        .filter(|start| {
            lines[*start..*start + needle.len()]
                .iter()
                .zip(needle)
                .all(|(actual, expected)| {
                    if trim {
                        actual.trim() == expected.trim()
                    } else {
                        actual == expected
                    }
                })
        })
        .collect()
}

fn replace_unique_text(
    content: &str,
    old: &str,
    new: &str,
    all: bool,
) -> Result<String, ToolError> {
    let exact = content
        .match_indices(old)
        .map(|(start, value)| start..start + value.len())
        .collect::<Vec<_>>();
    let matches = if exact.is_empty() {
        let regex = whitespace_tolerant_regex(old)?;
        regex
            .find_iter(content)
            .map(|matched| matched.start()..matched.end())
            .collect::<Vec<_>>()
    } else {
        exact
    };
    if matches.is_empty() {
        return Err(ToolError::new(
            "file.textNotFound",
            "oldText was not found exactly or with whitespace-only normalization",
        ));
    }
    if !all && matches.len() != 1 {
        return Err(ToolError::new(
            "file.textNotUnique",
            "oldText matches more than once; add context or set all=true",
        ));
    }
    let selected = if all {
        matches
    } else {
        vec![matches[0].clone()]
    };
    let mut output = String::with_capacity(content.len());
    let mut cursor = 0;
    for range in selected {
        output.push_str(&content[cursor..range.start]);
        output.push_str(new);
        cursor = range.end;
    }
    output.push_str(&content[cursor..]);
    Ok(output)
}

fn whitespace_tolerant_regex(value: &str) -> Result<Regex, ToolError> {
    let mut pattern = String::new();
    let mut literal = String::new();
    let mut in_whitespace = false;
    for character in value.chars() {
        if character.is_whitespace() {
            if !literal.is_empty() {
                pattern.push_str(&regex::escape(&literal));
                literal.clear();
            }
            if !in_whitespace {
                pattern.push_str(r"\s+");
                in_whitespace = true;
            }
        } else {
            in_whitespace = false;
            literal.push(character);
        }
    }
    if !literal.is_empty() {
        pattern.push_str(&regex::escape(&literal));
    }
    Regex::new(&pattern)
        .map_err(|error| ToolError::new("file.invalidReplacement", error.to_string()))
}

fn normalize_newlines(value: &str) -> String {
    value.replace("\r\n", "\n").replace('\r', "\n")
}

fn split_lines(value: &str) -> Vec<String> {
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

fn join_lines(lines: &[String], final_newline: bool) -> String {
    let mut value = lines.join("\n");
    if final_newline && !lines.is_empty() {
        value.push('\n');
    }
    value
}

fn ensure_snapshot_path(snapshot: &FileSnapshot, path: &Path) -> Result<(), ToolError> {
    if snapshot.canonical_path != path.display().to_string() {
        Err(ToolError::new(
            "file.snapshotPathMismatch",
            "snapshot belongs to a different file",
        ))
    } else {
        Ok(())
    }
}

fn validate_block_coverage(
    path: &Path,
    source: &str,
    operations: &[FileEditOperation],
    seen: &BTreeSet<usize>,
) -> Result<(), ToolError> {
    for operation in operations {
        let start_line = match operation {
            FileEditOperation::ReplaceBlock { start_line, .. }
            | FileEditOperation::DeleteBlock { start_line }
            | FileEditOperation::InsertBlockPost { start_line, .. } => *start_line,
            _ => continue,
        };
        let (start, end) = structure::block_range(path, source, start_line)?.ok_or_else(|| {
            ToolError::new(
                "file.blockNotFound",
                "no supported Tree-sitter block starts at this line",
            )
        })?;
        if !(start..=end).all(|line| seen.contains(&line)) {
            return Err(ToolError::new(
                "file.invalidRange",
                "Tree-sitter block is not fully covered by snapshot lines",
            ));
        }
    }
    Ok(())
}

fn expand_block_operations(
    path: &Path,
    source: &str,
    operations: Vec<FileEditOperation>,
) -> Result<Vec<FileEditOperation>, ToolError> {
    operations
        .into_iter()
        .map(|operation| match operation {
            FileEditOperation::ReplaceBlock { start_line, lines } => {
                let (start_line, end_line) = structure::block_range(path, source, start_line)?
                    .ok_or_else(|| ToolError::new("file.blockNotFound", "block not found"))?;
                Ok(FileEditOperation::Replace {
                    start_line,
                    end_line,
                    lines,
                })
            }
            FileEditOperation::DeleteBlock { start_line } => {
                let (start_line, end_line) = structure::block_range(path, source, start_line)?
                    .ok_or_else(|| ToolError::new("file.blockNotFound", "block not found"))?;
                Ok(FileEditOperation::Delete {
                    start_line,
                    end_line,
                })
            }
            FileEditOperation::InsertBlockPost { start_line, lines } => {
                let (_, end_line) = structure::block_range(path, source, start_line)?
                    .ok_or_else(|| ToolError::new("file.blockNotFound", "block not found"))?;
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
    for operation in operations {
        match operation {
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
                    InsertAt::Before => line.unwrap() - 1,
                    InsertAt::After => line.unwrap(),
                };
                if boundary > total || !boundaries.insert(boundary) {
                    return Err(path_conflict("invalid or duplicate insert boundary"));
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
    if ranges.windows(2).any(|pair| pair[0].1 >= pair[1].0) {
        return Err(path_conflict("edit ranges overlap"));
    }
    if boundaries.iter().any(|boundary| {
        ranges
            .iter()
            .any(|(start, end)| *start <= *boundary && *boundary < *end)
    }) {
        return Err(path_conflict("insert occurs inside edited range"));
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
            "body lines cannot be empty",
        ));
    }
    if lines.iter().any(|line| line.contains(['\n', '\r'])) {
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
    let old_lines = split_lines(old);
    operations
        .iter()
        .map(|operation| match operation {
            FileEditOperation::Replace {
                start_line,
                end_line,
                lines,
            } => {
                let (start, end) = map_segment(&old_lines, current, *start_line, *end_line)?;
                Ok(FileEditOperation::Replace {
                    start_line: start,
                    end_line: end,
                    lines: lines.clone(),
                })
            }
            FileEditOperation::Delete {
                start_line,
                end_line,
            } => {
                let (start, end) = map_segment(&old_lines, current, *start_line, *end_line)?;
                Ok(FileEditOperation::Delete {
                    start_line: start,
                    end_line: end,
                })
            }
            FileEditOperation::Insert {
                at: InsertAt::Head,
                lines,
                ..
            } if old_lines.first() == current.first() => Ok(FileEditOperation::Insert {
                at: InsertAt::Head,
                line: None,
                lines: lines.clone(),
            }),
            FileEditOperation::Insert {
                at: InsertAt::Tail,
                lines,
                ..
            } if old_lines.last() == current.last() => Ok(FileEditOperation::Insert {
                at: InsertAt::Tail,
                line: None,
                lines: lines.clone(),
            }),
            FileEditOperation::Insert {
                at,
                line: Some(line),
                lines,
            } => {
                let (mapped, _) = map_segment(&old_lines, current, *line, *line)?;
                Ok(FileEditOperation::Insert {
                    at: at.clone(),
                    line: Some(mapped),
                    lines: lines.clone(),
                })
            }
            _ => Err(revision_mismatch(
                "snapshot patch cannot be mapped exactly to the current file",
            )),
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
        .filter(|index| current[*index..*index + needle.len()] == *needle)
        .collect::<Vec<_>>();
    if hits.len() != 1 {
        return Err(revision_mismatch(
            "snapshot patch cannot be mapped exactly to the current file",
        ));
    }
    Ok((hits[0] + 1, hits[0] + needle.len()))
}

fn revision_mismatch(message: &str) -> ToolError {
    ToolError::retryable("file.revisionMismatch", message)
}

fn apply_line_operations(
    text: &mut TextFile,
    operations: &[FileEditOperation],
) -> Result<(usize, usize, usize), ToolError> {
    let original_total = text.lines.len();
    let mut eof_newline = None;
    for operation in operations {
        let lines = match operation {
            FileEditOperation::Replace {
                end_line, lines, ..
            } if *end_line == original_total => Some(lines),
            FileEditOperation::Insert {
                at: InsertAt::Tail,
                lines,
                ..
            } => Some(lines),
            FileEditOperation::Insert {
                at: InsertAt::After,
                line: Some(line),
                lines,
            } if *line == original_total => Some(lines),
            _ => None,
        };
        if let Some(lines) = lines {
            if eof_newline.is_some() {
                return Err(path_conflict(
                    "multiple operations control the end-of-file newline",
                ));
            }
            eof_newline = Some(lines.last().is_some_and(String::is_empty));
        }
    }

    let mut added = 0;
    let mut removed = 0;
    let mut first = usize::MAX;
    for operation in operations.iter().rev() {
        match operation {
            FileEditOperation::Replace {
                start_line,
                end_line,
                lines,
            } => {
                let mut replacement = lines.clone();
                if *end_line == original_total && replacement.last().is_some_and(String::is_empty) {
                    replacement.pop();
                }
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
                let index = match at {
                    InsertAt::Head => 0,
                    InsertAt::Tail => text.lines.len(),
                    InsertAt::Before => line.unwrap() - 1,
                    InsertAt::After => line.unwrap(),
                };
                let controls_eof = matches!(at, InsertAt::Tail)
                    || matches!(at, InsertAt::After) && line == &Some(original_total);
                let mut insertion = lines.clone();
                if controls_eof && insertion.last().is_some_and(String::is_empty) {
                    insertion.pop();
                }
                first = first.min(index + 1);
                added += insertion.len();
                text.lines.splice(index..index, insertion);
            }
            _ => unreachable!(),
        }
    }
    if let Some(final_newline) = eof_newline {
        text.final_newline = final_newline && !text.lines.is_empty();
    }
    Ok((added, removed, first))
}

fn first_changed_line(before: &[String], after: &[String]) -> Option<usize> {
    let common = before
        .iter()
        .zip(after.iter())
        .take_while(|(left, right)| left == right)
        .count();
    (before != after).then_some(common + 1)
}

fn line_delta(before: &[String], after: &[String]) -> (usize, usize) {
    let prefix = before
        .iter()
        .zip(after)
        .take_while(|(left, right)| left == right)
        .count();
    let suffix = before[prefix..]
        .iter()
        .rev()
        .zip(after[prefix..].iter().rev())
        .take_while(|(left, right)| left == right)
        .count();
    (
        after.len().saturating_sub(prefix + suffix),
        before.len().saturating_sub(prefix + suffix),
    )
}

fn compact_diff(before: &[String], after: &[String], first: usize) -> String {
    let start = first.saturating_sub(2).max(1);
    let end = before.len().max(after.len()).min(first.saturating_add(20));
    let mut output = Vec::new();
    for line in start..=end {
        match (before.get(line - 1), after.get(line - 1)) {
            (Some(left), Some(right)) if left == right => output.push(format!(" {line}:{left}")),
            (Some(left), Some(right)) => {
                output.push(format!("-{line}:{left}"));
                output.push(format!("+{line}:{right}"));
            }
            (Some(left), None) => output.push(format!("-{line}:{left}")),
            (None, Some(right)) => output.push(format!("+{line}:{right}")),
            _ => {}
        }
    }
    output.join("\n")
}
