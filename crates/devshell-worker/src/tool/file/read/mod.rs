pub mod structure;
mod view;

use std::{fs, sync::Arc};
use view::{ParsedSelector, parse_selector, remaining_selector};

use crate::capability::artifact::result_path::{ToolResultPath, parse_tool_result_path};
use crate::capability::artifact::store::ArtifactStore;
use crate::instance::sandbox::path::{ResolvedEntry, ResolvedMetadata, ResolvedPath};
use crate::tool::file::model::{
    FileEntryType, FileParseStatus, FileReadBatchEntry, FileReadBatchInput, FileReadBatchOutput,
    FileReadInput, FileReadMetadata, FileReadOutput, FileReadRequest, FileReadResolvedView,
    FileReadView,
};
use crate::tool::file::state::{FULL_SNAPSHOT_LIMIT, TextFile, TextMetadata};
use crate::tool::file::{FileToolState, normalize_file_path, resolve_existing, resolve_info};
use crate::tool::unix_time_millis;
use crate::tool::{ToolCall, ToolCapability, ToolCatalogEntry, ToolError, ToolHandler, ToolName};

const DEFAULT_LINE_COUNT: usize = 200;
const AUTO_CONTENT_MAX_LINES: usize = 300;
const AUTO_CONTENT_MAX_BYTES: usize = 64 * 1024;
const MAX_RANGES: usize = 16;
const MAX_CONTENT_BYTES: usize = 1024 * 1024;
const MAX_BATCH_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const TOOL_RESULT_READ_LEASE_MS: u128 = 60_000;

pub struct FileReadTool {
    name: ToolName,
    state: Arc<FileToolState>,
    artifacts: Arc<ArtifactStore>,
}
impl FileReadTool {
    pub fn new(state: Arc<FileToolState>, artifacts: Arc<ArtifactStore>) -> Self {
        Self {
            name: ToolName::parse("file_read").unwrap(),
            state,
            artifacts,
        }
    }
}
impl ToolHandler for FileReadTool {
    fn name(&self) -> &ToolName {
        &self.name
    }
    fn catalog_entry(&self) -> ToolCatalogEntry {
        crate::tool::contract::catalog_entry::<FileReadBatchInput, FileReadBatchOutput>(
            &self.name,
            "Read one or more paths as text content, structural outline, or filesystem metadata. Bare relative paths are normalized to the workspace namespace. Batch requests return successful items alongside per-item read errors. Content selectors support N, N-M, N+count, and comma-separated ranges; ranges are sorted, merged, and clamped to EOF when unambiguous. Workspace content reads establish edit coverage; virtual tool-result reads, outline reads, and metadata reads do not.".to_string(),
            [ToolCapability::Read],
        )
    }
    fn call(&self, call: ToolCall) -> Result<serde_json::Value, ToolError> {
        call.check_cancelled()?;
        let input: FileReadInput = call.parse_params()?;
        match input {
            FileReadInput::Legacy(input) => {
                let output = self.read_one(&call, &input)?;
                crate::tool::contract::serialize(output)
            }
            FileReadInput::Batch(input) => self.read_batch(&call, input),
        }
    }
}

impl FileReadTool {
    fn read_batch(
        &self,
        call: &ToolCall,
        input: FileReadBatchInput,
    ) -> Result<serde_json::Value, ToolError> {
        if input.files.is_empty() {
            return Err(ToolError::new(
                "tool.invalidArguments",
                "files cannot be empty",
            ));
        }
        let mut files = Vec::with_capacity(input.files.len());
        let mut serialized_bytes = br#"{"files":[]}"#.len();
        for input in input.files {
            call.check_cancelled()?;
            let path = batch_display_path(&input.path);
            let entry = match self.read_one(call, &input) {
                Ok(output) => FileReadBatchEntry::from_output(path, output),
                Err(error) if is_batch_item_error(&error) => {
                    FileReadBatchEntry::from_error(path, error)
                }
                Err(error) => return Err(error),
            };
            let entry_bytes = serde_json::to_vec(&entry)
                .map_err(|error| ToolError::new("tool.internalError", error.to_string()))?
                .len()
                .saturating_add(usize::from(!files.is_empty()));
            if serialized_bytes.saturating_add(entry_bytes) > MAX_BATCH_OUTPUT_BYTES {
                return Err(ToolError::new(
                    "file.outputTooLarge",
                    "file_read batch exceeds the serialized output budget; split files into smaller batches",
                ));
            }
            serialized_bytes = serialized_bytes.saturating_add(entry_bytes);
            files.push(entry);
        }
        crate::tool::contract::serialize(FileReadBatchOutput { files })
    }

    fn read_one(
        &self,
        call: &ToolCall,
        input: &FileReadRequest,
    ) -> Result<FileReadOutput, ToolError> {
        if let Some(result_path) = parse_tool_result_path(&input.path)? {
            return self.read_tool_result(call, input, result_path);
        }
        if matches!(input.view, FileReadView::Outline | FileReadView::Metadata)
            && input.selector.is_some()
        {
            return Err(ToolError::new(
                "tool.invalidArguments",
                "selector is only valid with view=content or view=auto",
            ));
        }
        if input.view == FileReadView::Metadata {
            return self.read_metadata(call, &input.path);
        }
        let ordinal = self.state.next_snapshot_ordinal();
        let (_, resolved) = resolve_existing(&call, &input.path, false)?;
        if !resolved
            .metadata()
            .map_err(|error| ToolError::new("file.readFailed", error.to_string()))?
            .is_file()
        {
            return Err(ToolError::new("file.notFile", "path is not a file"));
        }
        let metadata = TextMetadata::inspect_file(
            resolved
                .open_file()
                .map_err(|error| ToolError::new("file.readFailed", error.to_string()))?,
            &call.cancellation,
        )?;
        let resolved_view = resolve_view(&input, &resolved.canonical, &metadata);

        let output = match resolved_view {
            FileReadView::Outline => {
                self.read_outline(&call, &resolved, &resolved.canonical, &metadata, ordinal)?
            }
            FileReadView::Metadata => {
                unreachable!("metadata view is handled before text resolution")
            }
            FileReadView::Content | FileReadView::Auto => self.read_content(
                &call,
                &resolved,
                &resolved.canonical,
                &metadata,
                &input,
                ordinal,
            )?,
        };
        Ok(output)
    }

    fn read_tool_result(
        &self,
        call: &ToolCall,
        input: &FileReadRequest,
        result_path: ToolResultPath,
    ) -> Result<FileReadOutput, ToolError> {
        if matches!(input.view, FileReadView::Outline | FileReadView::Metadata) {
            return Err(ToolError::new(
                "tool.invalidArguments",
                "tool result paths support only view=auto or view=content",
            ));
        }
        let lease = self
            .artifacts
            .acquire_lease(
                &result_path.handle,
                unix_time_millis().saturating_add(TOOL_RESULT_READ_LEASE_MS),
            )
            .map_err(map_tool_result_error)?;
        let read = (|| {
            if lease.stream != result_path.stream {
                return Err(ToolError::new(
                    "file.notFound",
                    "tool result path is unavailable",
                ));
            }
            let metadata = TextMetadata::inspect_file(
                fs::File::open(&lease.data_path)
                    .map_err(|error| ToolError::new("file.readFailed", error.to_string()))?,
                &call.cancellation,
            )?;
            let mut selector = parse_selector(input.selector.as_deref(), metadata.total_lines)?;
            let selected = TextMetadata::read_selected_file(
                fs::File::open(&lease.data_path)
                    .map_err(|error| ToolError::new("file.readFailed", error.to_string()))?,
                &selector.ranges,
                MAX_CONTENT_BYTES,
                &call.cancellation,
            )?;
            if selected.metadata.revision != metadata.revision {
                return Err(ToolError::retryable(
                    "file.revisionMismatch",
                    "tool result changed while it was being read",
                ));
            }
            let mut content = String::new();
            for (offset, (line_no, line)) in selected.lines.iter().enumerate() {
                if offset % 256 == 0 {
                    call.check_cancelled()?;
                }
                if !content.is_empty() {
                    content.push('\n');
                }
                content.push_str(&format!("{line_no}:{line}"));
            }
            if let Some(next_line) = selected.next_line {
                selector.truncated = true;
                selector.next_selector = remaining_selector(
                    &selector.ranges,
                    next_line,
                    selector.next_selector.as_deref(),
                );
            }
            Ok(FileReadOutput {
                view: FileReadResolvedView::Content,
                content: Some(content),
                metadata: None,
                truncated: None,
                next_selector: selector.next_selector,
                language: None,
                parse_status: None,
            })
        })();
        let _ = self.artifacts.release_lease(&lease.lease_id);
        read
    }

    fn read_outline(
        &self,
        call: &ToolCall,
        resolved: &ResolvedPath,
        canonical_path: &std::path::Path,
        metadata: &TextMetadata,
        ordinal: u64,
    ) -> Result<FileReadOutput, ToolError> {
        if metadata.total_bytes > FULL_SNAPSHOT_LIMIT {
            return Err(ToolError::new(
                "file.outlineTooLarge",
                "outline view is limited to files that fit in a full snapshot",
            ));
        }
        let text = TextFile::read_file(
            resolved
                .open_file()
                .map_err(|error| ToolError::new("file.readFailed", error.to_string()))?,
            &call.cancellation,
        )?;
        call.check_cancelled()?;
        if text.revision != metadata.revision {
            return Err(ToolError::retryable(
                "file.revisionMismatch",
                "file changed while it was being read",
            ));
        }
        let outline = structure::outline(canonical_path, &text.normalized())?.ok_or_else(|| {
            ToolError::new(
                "file.outlineUnavailable",
                "no supported syntax outline is available for this file",
            )
        })?;
        call.check_cancelled()?;
        self.remember(
            call,
            canonical_path,
            &text,
            metadata,
            outline.seen_lines.clone(),
            ordinal,
        );
        Ok(FileReadOutput {
            view: FileReadResolvedView::Outline,
            content: Some(outline.content),
            metadata: None,
            truncated: outline.truncated.then_some(true),
            next_selector: None,
            language: Some(outline.language),
            parse_status: (outline.parse_status == FileParseStatus::Partial)
                .then_some(FileParseStatus::Partial),
        })
    }

    fn read_content(
        &self,
        call: &ToolCall,
        resolved: &ResolvedPath,
        canonical_path: &std::path::Path,
        metadata: &TextMetadata,
        input: &FileReadRequest,
        ordinal: u64,
    ) -> Result<FileReadOutput, ToolError> {
        let full_auto = input.view == FileReadView::Auto
            && input.selector.is_none()
            && metadata.total_lines <= AUTO_CONTENT_MAX_LINES
            && metadata.total_bytes <= AUTO_CONTENT_MAX_BYTES;
        let mut selector = if full_auto {
            ParsedSelector {
                ranges: if metadata.total_lines == 0 {
                    Vec::new()
                } else {
                    vec![(1, metadata.total_lines)]
                },
                truncated: false,
                next_selector: None,
            }
        } else {
            parse_selector(input.selector.as_deref(), metadata.total_lines)?
        };
        let selected = TextMetadata::read_selected_file(
            resolved
                .open_file()
                .map_err(|error| ToolError::new("file.readFailed", error.to_string()))?,
            &selector.ranges,
            MAX_CONTENT_BYTES,
            &call.cancellation,
        )?;
        call.check_cancelled()?;
        if selected.metadata.revision != metadata.revision {
            return Err(ToolError::retryable(
                "file.revisionMismatch",
                "file changed while it was being read",
            ));
        }
        let mut content = String::new();
        let mut seen = Vec::new();
        for (offset, (line_no, line)) in selected.lines.iter().enumerate() {
            if offset % 256 == 0 {
                call.check_cancelled()?;
            }
            if !content.is_empty() {
                content.push('\n');
            }
            content.push_str(&format!("{line_no}:{line}"));
            seen.push(*line_no);
        }
        if let Some(next_line) = selected.next_line {
            selector.truncated = true;
            selector.next_selector = remaining_selector(
                &selector.ranges,
                next_line,
                selector.next_selector.as_deref(),
            );
        }

        call.check_cancelled()?;
        if metadata.total_bytes <= FULL_SNAPSHOT_LIMIT {
            let text = TextFile::read_file(
                resolved
                    .open_file()
                    .map_err(|error| ToolError::new("file.readFailed", error.to_string()))?,
                &call.cancellation,
            )?;
            call.check_cancelled()?;
            if text.revision != metadata.revision {
                return Err(ToolError::retryable(
                    "file.revisionMismatch",
                    "file changed while it was being read",
                ));
            }
            self.state.context_snapshots.lock().unwrap().remember_full(
                &call.ctx_id,
                canonical_path,
                &text,
                seen.clone(),
                ordinal,
            );
        } else {
            self.state
                .context_snapshots
                .lock()
                .unwrap()
                .remember_sparse(
                    &call.ctx_id,
                    canonical_path,
                    metadata,
                    seen.clone(),
                    ordinal,
                );
        }

        Ok(FileReadOutput {
            view: FileReadResolvedView::Content,
            content: Some(content),
            metadata: None,
            truncated: None,
            next_selector: selector.next_selector,
            language: None,
            parse_status: None,
        })
    }

    fn read_metadata(&self, call: &ToolCall, path: &str) -> Result<FileReadOutput, ToolError> {
        let (_, resolved) = resolve_info(call, path)?;
        let metadata = match resolved {
            ResolvedEntry::Missing => FileReadMetadata {
                exists: false,
                entry_type: None,
                size_bytes: None,
                modified_at_ms: None,
                mode: None,
                target_type: None,
            },
            ResolvedEntry::Existing { target, metadata } => {
                let entry_type = metadata_type(&metadata);
                let target_type = if entry_type == FileEntryType::Symlink {
                    target
                        .metadata(true)
                        .ok()
                        .flatten()
                        .map(|metadata| metadata_type(&metadata))
                } else {
                    None
                };
                #[cfg(unix)]
                let mode = Some(metadata.mode());
                #[cfg(not(unix))]
                let mode = None;
                FileReadMetadata {
                    exists: true,
                    entry_type: Some(entry_type),
                    size_bytes: Some(metadata.len()),
                    modified_at_ms: metadata.modified_at_millis(),
                    mode,
                    target_type,
                }
            }
        };
        Ok(FileReadOutput {
            view: FileReadResolvedView::Metadata,
            content: None,
            metadata: Some(metadata),
            truncated: None,
            next_selector: None,
            language: None,
            parse_status: None,
        })
    }

    fn remember(
        &self,
        call: &ToolCall,
        path: &std::path::Path,
        text: &TextFile,
        metadata: &TextMetadata,
        seen: Vec<usize>,
        ordinal: u64,
    ) {
        if metadata.total_bytes <= FULL_SNAPSHOT_LIMIT {
            self.state.context_snapshots.lock().unwrap().remember_full(
                &call.ctx_id,
                path,
                text,
                seen,
                ordinal,
            );
        } else {
            self.state
                .context_snapshots
                .lock()
                .unwrap()
                .remember_sparse(&call.ctx_id, path, metadata, seen, ordinal);
        }
    }
}

fn batch_display_path(raw: &str) -> String {
    match parse_tool_result_path(raw) {
        Ok(Some(_)) => raw.to_string(),
        _ => normalize_file_path(raw).unwrap_or_else(|_| raw.to_string()),
    }
}

fn is_batch_item_error(error: &ToolError) -> bool {
    matches!(
        error.code.as_str(),
        "file.notFound"
            | "file.notFile"
            | "file.notText"
            | "file.readFailed"
            | "file.invalidRange"
            | "file.outlineUnavailable"
            | "file.revisionMismatch"
            | "file.lineTooLarge"
            | "tool.invalidArguments"
    )
}

fn map_tool_result_error(error: ToolError) -> ToolError {
    match error.code.as_str() {
        "artifact.notFound" | "artifact.expired" => {
            ToolError::new("file.notFound", "tool result is unavailable or expired")
        }
        _ => ToolError::new("file.readFailed", error.message),
    }
}

fn resolve_view(
    input: &FileReadRequest,
    path: &std::path::Path,
    metadata: &TextMetadata,
) -> FileReadView {
    if input.selector.is_some() {
        return FileReadView::Content;
    }
    match input.view {
        FileReadView::Content => FileReadView::Content,
        FileReadView::Metadata => FileReadView::Metadata,
        FileReadView::Outline => FileReadView::Outline,
        FileReadView::Auto => {
            if metadata.total_lines <= AUTO_CONTENT_MAX_LINES
                && metadata.total_bytes <= AUTO_CONTENT_MAX_BYTES
            {
                FileReadView::Content
            } else if metadata.total_bytes <= FULL_SNAPSHOT_LIMIT && structure::supports(path) {
                FileReadView::Outline
            } else {
                FileReadView::Content
            }
        }
    }
}

fn metadata_type(metadata: &ResolvedMetadata) -> FileEntryType {
    if metadata.is_symlink() {
        FileEntryType::Symlink
    } else if metadata.is_file() {
        FileEntryType::File
    } else if metadata.is_dir() {
        FileEntryType::Directory
    } else {
        FileEntryType::Other
    }
}
