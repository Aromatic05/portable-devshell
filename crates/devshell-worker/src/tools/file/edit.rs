use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use schemars::schema_for;

use crate::security::path::parse_requested_path;
use crate::tools::file::context_patch;
use crate::tools::file::diff;
use crate::tools::file::publish::{self, PublishMode};
use crate::tools::file::state::{
    FULL_SNAPSHOT_LIMIT, SessionFileSnapshot, SnapshotContent, TextFile,
};
use crate::tools::file::types::{
    FileChangeAction, FileChangeError, FileChangeOperationOutput, FileChangeSetInput,
    FileChangeSetOutput, FileChangeStatus, ReturnedRange,
};
use crate::tools::file::{FileToolState, authorize, resolve_create};
use crate::tools::{ToolCall, ToolCapability, ToolCatalogEntry, ToolError, ToolHandler, ToolName};

const MAX_CHANGE_OPERATIONS: usize = 256;
const MAX_RENDERED_DETAIL_BYTES: usize = 64 * 1024;
const MAX_SERIALIZED_OUTPUT_BYTES: usize = 1024 * 1024;
const PREVIEW_CONTEXT_LINES: usize = 3;

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
            group: self.name.group().to_string(),
            name: self.name.as_str(),
            description: concat!(
                "Apply an ordered multi-file change set. Input is one `*** Begin Edit` / `*** End Edit` envelope containing `*** Write File:`, `*** Patch File:`, `*** Rewrite File:`, `*** Delete File:`, and `*** Move File:` sections. ",
                "Write and Rewrite bodies are literal UTF-8 text. Patch bodies use exact context hunks beginning with `@@`, `@@ BOF`, or `@@ EOF`, followed by space, `-`, and `+` lines. ",
                "Existing files must have been read or searched in the same MCP session; revisions and snapshots are resolved automatically. The envelope is statically preflighted before writing. Each child operation commits atomically in order; on the first runtime failure, prior operations remain applied and later operations are reported as notExecuted."
            )
            .to_string(),
            input_schema: serde_json::to_value(schema_for!(FileChangeSetInput)).unwrap(),
            output_schema: serde_json::to_value(schema_for!(FileChangeSetOutput)).unwrap(),
            required_capabilities: vec![ToolCapability::Write],
        }
    }

    fn call(&self, call: ToolCall) -> Result<serde_json::Value, ToolError> {
        call.check_cancelled()?;
        let input: FileChangeSetInput = serde_json::from_value(call.params.clone())
            .map_err(|error| ToolError::new("tool.invalidArguments", error.to_string()))?;
        let parsed = parse_change_set(&input.changes)?;
        call.check_cancelled()?;
        let prepared = self.preflight(&call, parsed)?;
        let mut output = self.execute(&call, prepared);
        enforce_output_budget(&mut output)?;
        serde_json::to_value(output)
            .map_err(|error| ToolError::new("tool.internalError", error.to_string()))
    }
}

#[derive(Clone, Debug)]
enum ParsedOperation {
    Write { path: String, content: String },
    Patch { path: String, patch: String },
    Rewrite { path: String, content: String },
    Delete { path: String },
    Move { source: String, target: String },
}

#[derive(Clone)]
enum PreparedOperation {
    Write {
        display: String,
        path: PathBuf,
        content: String,
    },
    Patch {
        display: String,
        path: PathBuf,
        patch: String,
        base: Option<SessionFileSnapshot>,
    },
    Rewrite {
        display: String,
        path: PathBuf,
        content: String,
        base: Option<SessionFileSnapshot>,
    },
    Delete {
        display: String,
        path: PathBuf,
        base: Option<SessionFileSnapshot>,
    },
    Move {
        source_display: String,
        source: PathBuf,
        target_display: String,
        target: PathBuf,
        base: Option<SessionFileSnapshot>,
    },
}

#[derive(Clone, Copy)]
struct VirtualEntry {
    exists: bool,
    known: bool,
}

impl FileEditTool {
    fn preflight(
        &self,
        call: &ToolCall,
        operations: Vec<ParsedOperation>,
    ) -> Result<Vec<PreparedOperation>, ToolError> {
        let mut virtual_entries = HashMap::<PathBuf, VirtualEntry>::new();
        let mut prepared = Vec::with_capacity(operations.len());

        for operation in operations {
            call.check_cancelled()?;
            match operation {
                ParsedOperation::Write { path, content } => {
                    ensure_text(&content)?;
                    let (display, resolved) = resolve_for_plan(call, &path)?;
                    require_existing_parent(&resolved)?;
                    let entry = virtual_entry(&mut virtual_entries, &resolved);
                    if entry.exists {
                        return Err(ToolError::new(
                            "file.alreadyExists",
                            format!("Write File target already exists: {path}"),
                        ));
                    }
                    virtual_entries.insert(
                        resolved.clone(),
                        VirtualEntry {
                            exists: true,
                            known: true,
                        },
                    );
                    prepared.push(PreparedOperation::Write {
                        display,
                        path: resolved,
                        content,
                    });
                }
                ParsedOperation::Patch { path, patch } => {
                    context_patch::validate(&patch)?;
                    let (display, resolved) = resolve_for_plan(call, &path)?;
                    let mut entry = virtual_entry(&mut virtual_entries, &resolved);
                    if !entry.exists {
                        return Err(ToolError::new(
                            "file.notFound",
                            format!("Patch File target does not exist: {path}"),
                        ));
                    }
                    let base = if entry.known {
                        None
                    } else {
                        Some(self.require_snapshot(call, &resolved)?)
                    };
                    entry.known = true;
                    virtual_entries.insert(resolved.clone(), entry);
                    prepared.push(PreparedOperation::Patch {
                        display,
                        path: resolved,
                        patch,
                        base,
                    });
                }
                ParsedOperation::Rewrite { path, content } => {
                    ensure_text(&content)?;
                    let (display, resolved) = resolve_for_plan(call, &path)?;
                    let mut entry = virtual_entry(&mut virtual_entries, &resolved);
                    if !entry.exists {
                        return Err(ToolError::new(
                            "file.notFound",
                            format!("Rewrite File target does not exist: {path}"),
                        ));
                    }
                    let base = if entry.known {
                        None
                    } else {
                        Some(self.require_snapshot(call, &resolved)?)
                    };
                    entry.known = true;
                    virtual_entries.insert(resolved.clone(), entry);
                    prepared.push(PreparedOperation::Rewrite {
                        display,
                        path: resolved,
                        content,
                        base,
                    });
                }
                ParsedOperation::Delete { path } => {
                    let (display, resolved) = resolve_for_plan(call, &path)?;
                    let entry = virtual_entry(&mut virtual_entries, &resolved);
                    if !entry.exists {
                        return Err(ToolError::new(
                            "file.notFound",
                            format!("Delete File target does not exist: {path}"),
                        ));
                    }
                    let base = if entry.known {
                        None
                    } else {
                        Some(self.require_snapshot(call, &resolved)?)
                    };
                    virtual_entries.insert(
                        resolved.clone(),
                        VirtualEntry {
                            exists: false,
                            known: false,
                        },
                    );
                    prepared.push(PreparedOperation::Delete {
                        display,
                        path: resolved,
                        base,
                    });
                }
                ParsedOperation::Move { source, target } => {
                    let (source_display, source_path) = resolve_for_plan(call, &source)?;
                    let (target_display, target_path) = resolve_for_plan(call, &target)?;
                    require_existing_parent(&target_path)?;
                    if source_path == target_path {
                        return Err(ToolError::new(
                            "file.pathConflict",
                            "Move File source and target resolve to the same path",
                        ));
                    }
                    let source_entry = virtual_entry(&mut virtual_entries, &source_path);
                    if !source_entry.exists {
                        return Err(ToolError::new(
                            "file.notFound",
                            format!("Move File source does not exist: {source}"),
                        ));
                    }
                    let target_entry = virtual_entry(&mut virtual_entries, &target_path);
                    if target_entry.exists {
                        return Err(ToolError::new(
                            "file.alreadyExists",
                            format!("Move File target already exists: {target}"),
                        ));
                    }
                    let base = if source_entry.known {
                        None
                    } else {
                        Some(self.require_snapshot(call, &source_path)?)
                    };
                    virtual_entries.insert(
                        source_path.clone(),
                        VirtualEntry {
                            exists: false,
                            known: false,
                        },
                    );
                    virtual_entries.insert(
                        target_path.clone(),
                        VirtualEntry {
                            exists: true,
                            known: true,
                        },
                    );
                    prepared.push(PreparedOperation::Move {
                        source_display,
                        source: source_path,
                        target_display,
                        target: target_path,
                        base,
                    });
                }
            }
        }

        Ok(prepared)
    }

    fn require_snapshot(
        &self,
        call: &ToolCall,
        path: &Path,
    ) -> Result<SessionFileSnapshot, ToolError> {
        self.state
            .session_snapshots
            .lock()
            .unwrap()
            .latest_for_path(&call.session_id, path)
    }

    fn execute(&self, call: &ToolCall, operations: Vec<PreparedOperation>) -> FileChangeSetOutput {
        let mut outputs = Vec::with_capacity(operations.len());
        let mut local_snapshots = HashMap::<PathBuf, SessionFileSnapshot>::new();
        let mut failed = false;

        for (offset, operation) in operations.into_iter().enumerate() {
            let index = offset + 1;
            if failed {
                outputs.push(not_executed(index, &operation));
                continue;
            }
            if let Err(error) = call.check_cancelled() {
                outputs.push(failed_output(index, &operation, error));
                failed = true;
                continue;
            }
            let bound = match bind_local_snapshot(operation.clone(), &local_snapshots) {
                Ok(bound) => bound,
                Err(error) => {
                    outputs.push(failed_output(index, &operation, error));
                    failed = true;
                    continue;
                }
            };
            match self.execute_one(call, index, bound, &mut local_snapshots) {
                Ok(output) => outputs.push(output),
                Err(error) => {
                    outputs.push(failed_output(index, &operation, error));
                    failed = true;
                }
            }
        }

        FileChangeSetOutput {
            complete: !failed,
            operations: outputs,
        }
    }

    fn execute_one(
        &self,
        call: &ToolCall,
        index: usize,
        operation: PreparedOperation,
        local_snapshots: &mut HashMap<PathBuf, SessionFileSnapshot>,
    ) -> Result<FileChangeOperationOutput, ToolError> {
        match operation {
            PreparedOperation::Write {
                display,
                path,
                content,
            } => self.execute_write(call, index, display, path, content, local_snapshots),
            PreparedOperation::Patch {
                display,
                path,
                patch,
                base,
            } => self.execute_patch(call, index, display, path, patch, base, local_snapshots),
            PreparedOperation::Rewrite {
                display,
                path,
                content,
                base,
            } => self.execute_rewrite(call, index, display, path, content, base, local_snapshots),
            PreparedOperation::Delete {
                display,
                path,
                base,
            } => self.execute_delete(call, index, display, path, base, local_snapshots),
            PreparedOperation::Move {
                source_display,
                source,
                target_display,
                target,
                base,
            } => self.execute_move(
                call,
                index,
                source_display,
                source,
                target_display,
                target,
                base,
                local_snapshots,
            ),
        }
    }

    fn execute_write(
        &self,
        call: &ToolCall,
        index: usize,
        display: String,
        path: PathBuf,
        content: String,
        local_snapshots: &mut HashMap<PathBuf, SessionFileSnapshot>,
    ) -> Result<FileChangeOperationOutput, ToolError> {
        let lock = self.state.write_lock(&path);
        let _guard = lock.lock().unwrap();
        if path.symlink_metadata().is_ok() {
            return Err(ToolError::new(
                "file.alreadyExists",
                "Write File target already exists",
            ));
        }
        let mut temp = publish::new_temp(&path)?;
        temp.write_all(content.as_bytes())
            .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
        temp.flush()
            .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
        publish::publish(temp, &path, PublishMode::NoClobber)?;
        let text = TextFile::read(&path)?;
        let snapshot = self.remember_complete(call, &path, &text);
        local_snapshots.insert(path.clone(), snapshot);
        Ok(applied_text_output(
            index,
            FileChangeAction::Write,
            display,
            false,
            "",
            &text.normalized(),
            &text,
        ))
    }

    #[allow(clippy::too_many_arguments)]
    fn execute_rewrite(
        &self,
        call: &ToolCall,
        index: usize,
        display: String,
        path: PathBuf,
        content: String,
        base: Option<SessionFileSnapshot>,
        local_snapshots: &mut HashMap<PathBuf, SessionFileSnapshot>,
    ) -> Result<FileChangeOperationOutput, ToolError> {
        let base = require_bound_base(base)?;
        let lock = self.state.write_lock(&path);
        let _guard = lock.lock().unwrap();
        let current = TextFile::read(&path)?;
        require_revision(&base, &current)?;
        let rewritten = TextFile::from_normalized(&current, &content)?;
        publish_text(&path, &rewritten, Some(&current))?;
        let snapshot = self.remember_complete(call, &path, &rewritten);
        local_snapshots.insert(path.clone(), snapshot);
        Ok(applied_text_output(
            index,
            FileChangeAction::Rewrite,
            display,
            false,
            &current.normalized(),
            &rewritten.normalized(),
            &rewritten,
        ))
    }

    #[allow(clippy::too_many_arguments)]
    fn execute_patch(
        &self,
        call: &ToolCall,
        index: usize,
        display: String,
        path: PathBuf,
        patch: String,
        base: Option<SessionFileSnapshot>,
        local_snapshots: &mut HashMap<PathBuf, SessionFileSnapshot>,
    ) -> Result<FileChangeOperationOutput, ToolError> {
        let base = require_bound_base(base)?;
        let lock = self.state.write_lock(&path);
        let _guard = lock.lock().unwrap();
        let current = TextFile::read(&path)?;
        let (original, may_merge) = match &base.content {
            SnapshotContent::Full(content) => (content.clone(), true),
            SnapshotContent::Sparse => {
                require_revision(&base, &current)?;
                (current.normalized(), false)
            }
        };
        let application = context_patch::apply(&original, &patch)?;
        require_coverage(&base, &application.required_lines)?;
        let (normalized, merged) = if current.revision == base.revision {
            (application.normalized.clone(), false)
        } else if may_merge {
            (
                diff::merge_changes(&original, &current.normalized(), &application.normalized)?,
                true,
            )
        } else {
            return Err(revision_mismatch());
        };
        let updated = TextFile::from_normalized(&current, &normalized)?;
        publish_text(&path, &updated, Some(&current))?;

        let seen = if merged {
            application.resulting_known_lines.clone()
        } else {
            application.remap_seen_lines(&base.seen_lines)
        };
        let snapshot = self.remember_with_seen(call, &path, &updated, seen);
        local_snapshots.insert(path.clone(), snapshot);
        let mut output = applied_text_output(
            index,
            FileChangeAction::Patch,
            display,
            merged,
            &current.normalized(),
            &updated.normalized(),
            &updated,
        );
        if !merged {
            output.first_changed_line = application.first_changed_line;
        }
        output.added_lines = Some(application.added_lines);
        output.removed_lines = Some(application.removed_lines);
        Ok(output)
    }

    fn execute_delete(
        &self,
        call: &ToolCall,
        index: usize,
        display: String,
        path: PathBuf,
        base: Option<SessionFileSnapshot>,
        local_snapshots: &mut HashMap<PathBuf, SessionFileSnapshot>,
    ) -> Result<FileChangeOperationOutput, ToolError> {
        let base = require_bound_base(base)?;
        let lock = self.state.write_lock(&path);
        let _guard = lock.lock().unwrap();
        let current = TextFile::read(&path)?;
        require_revision(&base, &current)?;
        fs::remove_file(&path)
            .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
        self.state
            .session_snapshots
            .lock()
            .unwrap()
            .remove_path(&call.session_id, &path);
        local_snapshots.remove(&path);
        let before = current.normalized();
        let diff = limit_detail(diff::render(&before, ""));
        Ok(FileChangeOperationOutput {
            index,
            action: FileChangeAction::Delete,
            path: display,
            moved_from: None,
            status: FileChangeStatus::Applied,
            merged: None,
            added_lines: Some(0),
            removed_lines: Some(current.lines.len()),
            first_changed_line: (!current.lines.is_empty()).then_some(1),
            total_lines: None,
            total_bytes: None,
            diff: Some(diff.0),
            preview: None,
            preview_range: None,
            error: None,
            truncated: diff.1,
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn execute_move(
        &self,
        call: &ToolCall,
        index: usize,
        source_display: String,
        source: PathBuf,
        target_display: String,
        target: PathBuf,
        base: Option<SessionFileSnapshot>,
        local_snapshots: &mut HashMap<PathBuf, SessionFileSnapshot>,
    ) -> Result<FileChangeOperationOutput, ToolError> {
        let base = require_bound_base(base)?;
        let (first, second) = if source <= target {
            (
                self.state.write_lock(&source),
                self.state.write_lock(&target),
            )
        } else {
            (
                self.state.write_lock(&target),
                self.state.write_lock(&source),
            )
        };
        let _first_guard = first.lock().unwrap();
        let _second_guard = second.lock().unwrap();
        let current = TextFile::read(&source)?;
        require_revision(&base, &current)?;
        if target.symlink_metadata().is_ok() {
            return Err(ToolError::new(
                "file.alreadyExists",
                "Move File target already exists",
            ));
        }
        atomic_move_no_replace(&source, &target)?;
        self.state.session_snapshots.lock().unwrap().migrate_path(
            &call.session_id,
            &source,
            &target,
        );
        let mut moved_snapshot = base;
        moved_snapshot.canonical_path = target.display().to_string();
        local_snapshots.remove(&source);
        local_snapshots.insert(target.clone(), moved_snapshot);
        Ok(FileChangeOperationOutput {
            index,
            action: FileChangeAction::Move,
            path: target_display,
            moved_from: Some(source_display),
            status: FileChangeStatus::Applied,
            merged: None,
            added_lines: Some(0),
            removed_lines: Some(0),
            first_changed_line: None,
            total_lines: Some(current.lines.len()),
            total_bytes: Some(current.total_bytes),
            diff: None,
            preview: None,
            preview_range: None,
            error: None,
            truncated: false,
        })
    }

    fn remember_complete(
        &self,
        call: &ToolCall,
        path: &Path,
        text: &TextFile,
    ) -> SessionFileSnapshot {
        self.remember_with_seen(call, path, text, 1..=text.lines.len())
    }

    fn remember_with_seen(
        &self,
        call: &ToolCall,
        path: &Path,
        text: &TextFile,
        seen: impl IntoIterator<Item = usize>,
    ) -> SessionFileSnapshot {
        let seen = seen.into_iter().collect::<BTreeSet<_>>();
        let ordinal = self.state.next_snapshot_ordinal();
        if text.total_bytes <= FULL_SNAPSHOT_LIMIT {
            self.state.session_snapshots.lock().unwrap().remember_full(
                &call.session_id,
                path,
                text,
                seen.iter().copied(),
                ordinal,
            );
        } else {
            let metadata = crate::tools::file::state::TextMetadata {
                bom: text.bom,
                final_newline: text.final_newline,
                line_ending: text.line_ending,
                revision: text.revision.clone(),
                total_bytes: text.total_bytes,
                total_lines: text.lines.len(),
            };
            self.state
                .session_snapshots
                .lock()
                .unwrap()
                .remember_sparse(
                    &call.session_id,
                    path,
                    &metadata,
                    seen.iter().copied(),
                    ordinal,
                );
        }
        session_snapshot(path, text, seen, ordinal)
    }
}

fn bind_local_snapshot(
    operation: PreparedOperation,
    local: &HashMap<PathBuf, SessionFileSnapshot>,
) -> Result<PreparedOperation, ToolError> {
    match operation {
        PreparedOperation::Patch {
            display,
            path,
            patch,
            base,
        } => Ok(PreparedOperation::Patch {
            display,
            base: Some(resolve_operation_base(base, local, &path)?),
            path,
            patch,
        }),
        PreparedOperation::Rewrite {
            display,
            path,
            content,
            base,
        } => Ok(PreparedOperation::Rewrite {
            display,
            base: Some(resolve_operation_base(base, local, &path)?),
            path,
            content,
        }),
        PreparedOperation::Delete {
            display,
            path,
            base,
        } => Ok(PreparedOperation::Delete {
            display,
            base: Some(resolve_operation_base(base, local, &path)?),
            path,
        }),
        PreparedOperation::Move {
            source_display,
            source,
            target_display,
            target,
            base,
        } => Ok(PreparedOperation::Move {
            source_display,
            base: Some(resolve_operation_base(base, local, &source)?),
            source,
            target_display,
            target,
        }),
        write @ PreparedOperation::Write { .. } => Ok(write),
    }
}

fn resolve_operation_base(
    base: Option<SessionFileSnapshot>,
    local: &HashMap<PathBuf, SessionFileSnapshot>,
    path: &Path,
) -> Result<SessionFileSnapshot, ToolError> {
    base.or_else(|| local.get(path).cloned()).ok_or_else(|| {
        ToolError::new(
            "tool.internalError",
            format!("change-set snapshot chain is missing {}", path.display()),
        )
    })
}

fn require_bound_base(base: Option<SessionFileSnapshot>) -> Result<SessionFileSnapshot, ToolError> {
    base.ok_or_else(|| {
        ToolError::new(
            "tool.internalError",
            "change-set operation reached execution without a bound snapshot",
        )
    })
}

fn session_snapshot(
    path: &Path,
    text: &TextFile,
    seen_lines: BTreeSet<usize>,
    ordinal: u64,
) -> SessionFileSnapshot {
    SessionFileSnapshot {
        canonical_path: path.display().to_string(),
        revision: text.revision.clone(),
        seen_lines,
        total_lines: text.lines.len(),
        content: if text.total_bytes <= FULL_SNAPSHOT_LIMIT {
            SnapshotContent::Full(text.normalized())
        } else {
            SnapshotContent::Sparse
        },
        ordinal,
        last_accessed_at_ms: 0,
    }
}

fn parse_change_set(input: &str) -> Result<Vec<ParsedOperation>, ToolError> {
    let normalized = input.replace("\r\n", "\n").replace('\r', "\n");
    let lines = normalized.split('\n').collect::<Vec<_>>();
    let first = lines
        .iter()
        .position(|line| !line.trim().is_empty())
        .ok_or_else(|| invalid_edit("change set is empty"))?;
    if lines[first] != "*** Begin Edit" {
        return Err(invalid_edit("change set must start with `*** Begin Edit`"));
    }
    let last = lines
        .iter()
        .rposition(|line| !line.trim().is_empty())
        .ok_or_else(|| invalid_edit("change set is empty"))?;
    if lines[last] != "*** End Edit" {
        return Err(invalid_edit("change set must end with `*** End Edit`"));
    }

    let mut operations = Vec::new();
    let mut index = first + 1;
    while index < last {
        if lines[index].trim().is_empty() {
            index += 1;
            continue;
        }
        if operations.len() >= MAX_CHANGE_OPERATIONS {
            return Err(ToolError::new(
                "file.tooManyOperations",
                format!("change set supports at most {MAX_CHANGE_OPERATIONS} operations"),
            ));
        }
        let line = lines[index];
        if let Some(path) = line.strip_prefix("*** Write File:") {
            let path = parse_path(path)?;
            let (body, next) = collect_body(&lines, index + 1, last);
            operations.push(ParsedOperation::Write {
                path,
                content: literal_body(body),
            });
            index = next;
            continue;
        }
        if let Some(path) = line.strip_prefix("*** Patch File:") {
            let path = parse_path(path)?;
            let (body, next) = collect_body(&lines, index + 1, last);
            let patch = body.join("\n");
            if patch.trim().is_empty() {
                return Err(invalid_edit("Patch File requires at least one hunk"));
            }
            operations.push(ParsedOperation::Patch { path, patch });
            index = next;
            continue;
        }
        if let Some(path) = line.strip_prefix("*** Rewrite File:") {
            let path = parse_path(path)?;
            let (body, next) = collect_body(&lines, index + 1, last);
            operations.push(ParsedOperation::Rewrite {
                path,
                content: literal_body(body),
            });
            index = next;
            continue;
        }
        if let Some(path) = line.strip_prefix("*** Delete File:") {
            let path = parse_path(path)?;
            index += 1;
            index = skip_blank_lines(&lines, index, last);
            if index < last && !is_operation_header(lines[index]) {
                return Err(invalid_edit("Delete File does not accept a body"));
            }
            operations.push(ParsedOperation::Delete { path });
            continue;
        }
        if let Some(source) = line.strip_prefix("*** Move File:") {
            let source = parse_path(source)?;
            index = skip_blank_lines(&lines, index + 1, last);
            let Some(target) = lines
                .get(index)
                .and_then(|line| line.strip_prefix("*** To:"))
            else {
                return Err(invalid_edit(
                    "Move File requires a following `*** To:` line",
                ));
            };
            let target = parse_path(target)?;
            index += 1;
            index = skip_blank_lines(&lines, index, last);
            if index < last && !is_operation_header(lines[index]) {
                return Err(invalid_edit("Move File does not accept a body"));
            }
            operations.push(ParsedOperation::Move { source, target });
            continue;
        }
        if line.starts_with("*** To:") {
            return Err(invalid_edit("`*** To:` is only valid after Move File"));
        }
        return Err(invalid_edit(format!("unexpected change-set line: {line}")));
    }

    if operations.is_empty() {
        return Err(ToolError::new(
            "file.emptyOperation",
            "change set contains no file operations",
        ));
    }
    Ok(operations)
}

fn collect_body<'a>(lines: &'a [&'a str], start: usize, end: usize) -> (Vec<&'a str>, usize) {
    let mut index = start;
    while index < end && !is_operation_header(lines[index]) {
        index += 1;
    }
    (lines[start..index].to_vec(), index)
}

fn literal_body(lines: Vec<&str>) -> String {
    if lines.is_empty() {
        return String::new();
    }
    let mut content = lines.join("\n");
    content.push('\n');
    content
}

fn is_operation_header(line: &str) -> bool {
    line.starts_with("*** Write File:")
        || line.starts_with("*** Patch File:")
        || line.starts_with("*** Rewrite File:")
        || line.starts_with("*** Delete File:")
        || line.starts_with("*** Move File:")
        || line == "*** End Edit"
}

fn skip_blank_lines(lines: &[&str], mut index: usize, end: usize) -> usize {
    while index < end && lines[index].trim().is_empty() {
        index += 1;
    }
    index
}

fn parse_path(raw: &str) -> Result<String, ToolError> {
    let path = raw.trim();
    if path.is_empty() || path.contains('\0') {
        return Err(ToolError::new(
            "file.invalidPath",
            "file path is empty or invalid",
        ));
    }
    Ok(path.to_string())
}

fn resolve_for_plan(call: &ToolCall, raw: &str) -> Result<(String, PathBuf), ToolError> {
    let requested = parse_requested_path(raw)?;
    authorize(call, requested.namespace, true)?;
    let (requested, resolved) = resolve_create(call, raw)?;
    Ok((requested.raw, resolved))
}

fn virtual_entry(entries: &mut HashMap<PathBuf, VirtualEntry>, path: &Path) -> VirtualEntry {
    *entries
        .entry(path.to_path_buf())
        .or_insert_with(|| VirtualEntry {
            exists: path.symlink_metadata().is_ok(),
            known: false,
        })
}

fn require_existing_parent(path: &Path) -> Result<(), ToolError> {
    let Some(parent) = path.parent() else {
        return Err(ToolError::new(
            "file.invalidPath",
            "target has no parent directory",
        ));
    };
    if parent.is_dir() {
        return Ok(());
    }
    Err(ToolError::new(
        "file.parentNotFound",
        format!(
            "target parent directory does not exist: {}",
            parent.display()
        ),
    ))
}

#[cfg(target_os = "linux")]
fn atomic_move_no_replace(source: &Path, target: &Path) -> Result<(), ToolError> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let source = CString::new(source.as_os_str().as_bytes())
        .map_err(|_| ToolError::new("file.invalidPath", "source path contains NUL"))?;
    let target = CString::new(target.as_os_str().as_bytes())
        .map_err(|_| ToolError::new("file.invalidPath", "target path contains NUL"))?;
    // libc exposes renameat2 only for glibc targets. Invoke the Linux syscall
    // directly so the same no-replace operation also works in static musl builds.
    let result = unsafe {
        nix::libc::syscall(
            nix::libc::SYS_renameat2,
            nix::libc::AT_FDCWD,
            source.as_ptr(),
            nix::libc::AT_FDCWD,
            target.as_ptr(),
            nix::libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        return Ok(());
    }
    Err(map_move_error(std::io::Error::last_os_error()))
}

#[cfg(target_os = "macos")]
fn atomic_move_no_replace(source: &Path, target: &Path) -> Result<(), ToolError> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let source = CString::new(source.as_os_str().as_bytes())
        .map_err(|_| ToolError::new("file.invalidPath", "source path contains NUL"))?;
    let target = CString::new(target.as_os_str().as_bytes())
        .map_err(|_| ToolError::new("file.invalidPath", "target path contains NUL"))?;
    let result =
        unsafe { nix::libc::renamex_np(source.as_ptr(), target.as_ptr(), nix::libc::RENAME_EXCL) };
    if result == 0 {
        return Ok(());
    }
    Err(map_move_error(std::io::Error::last_os_error()))
}

#[cfg(windows)]
fn atomic_move_no_replace(source: &Path, target: &Path) -> Result<(), ToolError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let target = target
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let result = unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), 0) };
    if result != 0 {
        return Ok(());
    }
    Err(map_move_error(std::io::Error::last_os_error()))
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn atomic_move_no_replace(_source: &Path, _target: &Path) -> Result<(), ToolError> {
    Err(ToolError::new(
        "file.atomicMoveUnsupported",
        "atomic no-clobber Move File is unsupported on this operating system",
    ))
}

fn map_move_error(error: std::io::Error) -> ToolError {
    match error.raw_os_error() {
        #[cfg(unix)]
        Some(code) if code == nix::libc::EEXIST => {
            ToolError::new("file.alreadyExists", "Move File target already exists")
        }
        #[cfg(unix)]
        Some(code) if code == nix::libc::EXDEV => ToolError::new(
            "file.crossDeviceMoveUnsupported",
            "Move File requires source and target on the same filesystem",
        ),
        #[cfg(windows)]
        Some(80 | 183) => ToolError::new("file.alreadyExists", "Move File target already exists"),
        #[cfg(windows)]
        Some(17) => ToolError::new(
            "file.crossDeviceMoveUnsupported",
            "Move File requires source and target on the same filesystem",
        ),
        _ => ToolError::new("file.writeFailed", error.to_string()),
    }
}

fn ensure_text(content: &str) -> Result<(), ToolError> {
    if content.contains('\0') {
        return Err(ToolError::new(
            "file.notText",
            "file content cannot contain NUL bytes",
        ));
    }
    Ok(())
}

fn require_revision(base: &SessionFileSnapshot, current: &TextFile) -> Result<(), ToolError> {
    if current.revision == base.revision {
        Ok(())
    } else {
        Err(revision_mismatch())
    }
}

fn require_coverage(
    base: &SessionFileSnapshot,
    required: &BTreeSet<usize>,
) -> Result<(), ToolError> {
    let missing = required
        .iter()
        .filter(|line| !base.seen_lines.contains(line))
        .copied()
        .collect::<Vec<_>>();
    if missing.is_empty() {
        return Ok(());
    }
    Err(ToolError::retryable(
        "file.unreadRange",
        "patch modifies or relies on source lines that were not read in this session",
    )
    .with_details(serde_json::json!({
        "missingLines": missing,
    })))
}

fn revision_mismatch() -> ToolError {
    ToolError::retryable(
        "file.revisionMismatch",
        "file changed after it was read in this session",
    )
}

fn publish_text(path: &Path, text: &TextFile, source: Option<&TextFile>) -> Result<(), ToolError> {
    let mut temp = publish::new_temp(path)?;
    temp.write_all(&text.encoded())
        .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
    temp.flush()
        .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
    #[cfg(unix)]
    if source.is_some() {
        use std::os::unix::fs::PermissionsExt;
        let metadata = fs::metadata(path)
            .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
        temp.as_file()
            .set_permissions(fs::Permissions::from_mode(metadata.permissions().mode()))
            .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
    }
    if let Some(source) = source {
        let current = TextFile::read(path)?;
        if current.revision != source.revision {
            return Err(ToolError::retryable(
                "file.revisionMismatch",
                "file changed while preparing the write",
            ));
        }
    }
    publish::publish(temp, path, PublishMode::Replace)
}

fn applied_text_output(
    index: usize,
    action: FileChangeAction,
    path: String,
    merged: bool,
    before: &str,
    after: &str,
    text: &TextFile,
) -> FileChangeOperationOutput {
    let (added_lines, removed_lines, first_changed_line) = line_delta(before, after);
    let diff = limit_detail(diff::render(before, after));
    let preview = preview(after, first_changed_line);
    FileChangeOperationOutput {
        index,
        action,
        path,
        moved_from: None,
        status: FileChangeStatus::Applied,
        merged: Some(merged),
        added_lines: Some(added_lines),
        removed_lines: Some(removed_lines),
        first_changed_line,
        total_lines: Some(text.lines.len()),
        total_bytes: Some(text.total_bytes),
        diff: Some(diff.0),
        preview: preview.as_ref().map(|value| value.0.clone()),
        preview_range: preview.map(|value| value.1),
        error: None,
        truncated: diff.1,
    }
}

fn line_delta(before: &str, after: &str) -> (usize, usize, Option<usize>) {
    let before_lines = normalized_lines(before);
    let after_lines = normalized_lines(after);
    let prefix = before_lines
        .iter()
        .zip(&after_lines)
        .take_while(|(left, right)| left == right)
        .count();
    if before_lines == after_lines {
        return (0, 0, None);
    }
    let suffix = before_lines
        .iter()
        .rev()
        .zip(after_lines.iter().rev())
        .take_while(|(left, right)| left == right)
        .count()
        .min(before_lines.len().saturating_sub(prefix))
        .min(after_lines.len().saturating_sub(prefix));
    (
        after_lines.len().saturating_sub(prefix + suffix),
        before_lines.len().saturating_sub(prefix + suffix),
        Some(prefix + 1),
    )
}

fn normalized_lines(value: &str) -> Vec<&str> {
    let body = value.strip_suffix('\n').unwrap_or(value);
    if value.is_empty() {
        Vec::new()
    } else {
        body.split('\n').collect()
    }
}

fn preview(value: &str, first_changed_line: Option<usize>) -> Option<(String, ReturnedRange)> {
    let lines = normalized_lines(value);
    if lines.is_empty() {
        return None;
    }
    let first = first_changed_line.unwrap_or(1);
    let start = first.saturating_sub(PREVIEW_CONTEXT_LINES).max(1);
    let end = (first + PREVIEW_CONTEXT_LINES).min(lines.len());
    let content = (start..=end)
        .map(|line| format!("{line}:{}", lines[line - 1]))
        .collect::<Vec<_>>()
        .join("\n");
    let detail = limit_detail(content);
    Some((
        detail.0,
        ReturnedRange {
            start_line: start,
            end_line: end,
        },
    ))
}

fn limit_detail(mut value: String) -> (String, bool) {
    if value.len() <= MAX_RENDERED_DETAIL_BYTES {
        return (value, false);
    }
    let mut end = MAX_RENDERED_DETAIL_BYTES;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value.truncate(end);
    value.push('…');
    (value, true)
}

fn enforce_output_budget(output: &mut FileChangeSetOutput) -> Result<(), ToolError> {
    let serialized_len = |value: &FileChangeSetOutput| {
        serde_json::to_vec(value)
            .map(|serialized| serialized.len())
            .map_err(|error| ToolError::new("tool.internalError", error.to_string()))
    };
    if serialized_len(output)? <= MAX_SERIALIZED_OUTPUT_BYTES {
        return Ok(());
    }
    for index in (0..output.operations.len()).rev() {
        {
            let operation = &mut output.operations[index];
            if operation.preview.take().is_some() {
                operation.preview_range = None;
                operation.truncated = true;
            }
        }
        if serialized_len(output)? <= MAX_SERIALIZED_OUTPUT_BYTES {
            return Ok(());
        }
        {
            let operation = &mut output.operations[index];
            if operation.diff.take().is_some() {
                operation.truncated = true;
            }
        }
        if serialized_len(output)? <= MAX_SERIALIZED_OUTPUT_BYTES {
            return Ok(());
        }
    }
    Ok(())
}

fn failed_output(
    index: usize,
    operation: &PreparedOperation,
    error: ToolError,
) -> FileChangeOperationOutput {
    let (action, path, moved_from) = operation_identity(operation);
    FileChangeOperationOutput {
        index,
        action,
        path,
        moved_from,
        status: FileChangeStatus::Failed,
        merged: None,
        added_lines: None,
        removed_lines: None,
        first_changed_line: None,
        total_lines: None,
        total_bytes: None,
        diff: None,
        preview: None,
        preview_range: None,
        error: Some(FileChangeError {
            code: error.code,
            message: error.message,
            retryable: error.retryable,
            details: error.details,
        }),
        truncated: false,
    }
}

fn not_executed(index: usize, operation: &PreparedOperation) -> FileChangeOperationOutput {
    let (action, path, moved_from) = operation_identity(operation);
    FileChangeOperationOutput {
        index,
        action,
        path,
        moved_from,
        status: FileChangeStatus::NotExecuted,
        merged: None,
        added_lines: None,
        removed_lines: None,
        first_changed_line: None,
        total_lines: None,
        total_bytes: None,
        diff: None,
        preview: None,
        preview_range: None,
        error: None,
        truncated: false,
    }
}

fn operation_identity(operation: &PreparedOperation) -> (FileChangeAction, String, Option<String>) {
    match operation {
        PreparedOperation::Write { display, .. } => {
            (FileChangeAction::Write, display.clone(), None)
        }
        PreparedOperation::Patch { display, .. } => {
            (FileChangeAction::Patch, display.clone(), None)
        }
        PreparedOperation::Rewrite { display, .. } => {
            (FileChangeAction::Rewrite, display.clone(), None)
        }
        PreparedOperation::Delete { display, .. } => {
            (FileChangeAction::Delete, display.clone(), None)
        }
        PreparedOperation::Move {
            source_display,
            target_display,
            ..
        } => (
            FileChangeAction::Move,
            target_display.clone(),
            Some(source_display.clone()),
        ),
    }
}

fn invalid_edit(message: impl Into<String>) -> ToolError {
    ToolError::new("file.invalidEdit", message.into())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::{ParsedOperation, atomic_move_no_replace, parse_change_set};

    #[test]
    fn parses_all_change_set_operations() {
        let operations = parse_change_set(concat!(
            "*** Begin Edit\n",
            "*** Write File: ./new.txt\n",
            "new\n",
            "*** Patch File: ./old.txt\n",
            "@@\n",
            "-old\n",
            "+updated\n",
            "*** Rewrite File: ./generated.txt\n",
            "generated\n",
            "*** Move File: ./from.txt\n",
            "*** To: ./to.txt\n",
            "*** Delete File: ./unused.txt\n",
            "*** End Edit"
        ))
        .unwrap();
        assert_eq!(operations.len(), 5);
        assert!(matches!(operations[0], ParsedOperation::Write { .. }));
        assert!(matches!(operations[1], ParsedOperation::Patch { .. }));
        assert!(matches!(operations[2], ParsedOperation::Rewrite { .. }));
        assert!(matches!(operations[3], ParsedOperation::Move { .. }));
        assert!(matches!(operations[4], ParsedOperation::Delete { .. }));
    }

    #[test]
    fn literal_body_preserves_trailing_blank_lines() {
        let operations = parse_change_set(concat!(
            "*** Begin Edit\n",
            "*** Write File: ./new.txt\n",
            "line\n",
            "\n",
            "*** End Edit"
        ))
        .unwrap();
        let ParsedOperation::Write { content, .. } = &operations[0] else {
            panic!("expected write");
        };
        assert_eq!(content, "line\n\n");
    }

    #[test]
    fn atomic_move_never_replaces_an_existing_target() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("source.txt");
        let target = directory.path().join("target.txt");
        fs::write(&source, "source").unwrap();
        fs::write(&target, "target").unwrap();

        let error = atomic_move_no_replace(&source, &target).unwrap_err();
        assert_eq!(error.code, "file.alreadyExists");
        assert_eq!(fs::read_to_string(&source).unwrap(), "source");
        assert_eq!(fs::read_to_string(&target).unwrap(), "target");
    }

    #[test]
    fn literal_body_can_contain_non_control_triple_stars() {
        let operations = parse_change_set(concat!(
            "*** Begin Edit\n",
            "*** Write File: ./new.txt\n",
            "value = \"***\"\n",
            "*** End Edit"
        ))
        .unwrap();
        let ParsedOperation::Write { content, .. } = &operations[0] else {
            panic!("expected write");
        };
        assert_eq!(content, "value = \"***\"\n");
    }
}
