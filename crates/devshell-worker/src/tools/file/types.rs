use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileReadView {
    #[default]
    Auto,
    Content,
    Outline,
}

#[derive(Clone, Copy, Debug, JsonSchema, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileParseStatus {
    Complete,
    Partial,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileReadInput {
    #[schemars(length(min = 1))]
    pub path: String,
    #[serde(default)]
    pub view: FileReadView,
    /// Content selector using N, N-M, N+count, or sorted non-overlapping comma-separated ranges. Append :raw for exact lines; otherwise each range includes one preceding line and up to three following lines for editing context. Cannot be combined with view=outline.
    pub selector: Option<String>,
}
#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileReadOutput {
    pub path: String,
    pub view: FileReadView,
    pub content: String,
    pub returned_ranges: Vec<ReturnedRange>,
    pub total_lines: usize,
    pub total_bytes: usize,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_selector: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parse_status: Option<FileParseStatus>,
}
#[derive(Clone, Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReturnedRange {
    pub start_line: usize,
    pub end_line: usize,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FileEditMode {
    #[default]
    Text,
    Replace,
    Patch,
    ApplyPatch,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileEditTextInput {
    pub input: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileEditReplaceInput {
    pub path: String,
    pub edits: Vec<FileEditReplaceEntry>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileEditReplaceEntry {
    pub old_text: String,
    pub new_text: String,
    pub all: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileEditPatchInput {
    pub path: String,
    pub edits: Vec<FileEditPatchEntry>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileEditPatchEntry {
    pub op: Option<FileEditPatchOperation>,
    pub rename: Option<String>,
    pub diff: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileEditPatchOperation {
    Create,
    Delete,
    Update,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileEditApplyPatchInput {
    pub input: String,
}

#[derive(Clone, Debug)]
pub enum FileEditOperation {
    Replace {
        start_line: usize,
        end_line: usize,
        lines: Vec<String>,
    },
    Delete {
        start_line: usize,
        end_line: usize,
    },
    Insert {
        at: InsertAt,
        line: Option<usize>,
        lines: Vec<String>,
    },
    ReplaceBlock {
        start_line: usize,
        lines: Vec<String>,
    },
    DeleteBlock {
        start_line: usize,
    },
    InsertBlockPost {
        start_line: usize,
        lines: Vec<String>,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub enum InsertAt {
    Before,
    After,
    Head,
    Tail,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileEditOutput {
    pub files: Vec<FileEditFileOutput>,
    pub applied_files: Vec<String>,
}

#[derive(Clone, Copy, Debug, JsonSchema, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileEditResultOperation {
    Create,
    Update,
    Delete,
    Move,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileEditFileOutput {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_tag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
    pub operation: FileEditResultOperation,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub moved_from: Option<String>,
    pub diff: String,
    pub added_lines: usize,
    pub removed_lines: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_changed_line: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_lines: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_range: Option<ReturnedRange>,
    pub truncated: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileChangeSetInput {
    /// Ordered edit document using the *** Begin Edit / *** End Edit format described by this tool.
    pub changes: String,
}

#[derive(Clone, Copy, Debug, JsonSchema, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileChangeAction {
    Write,
    Patch,
    Rewrite,
    Delete,
    Move,
}

#[derive(Clone, Copy, Debug, JsonSchema, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileChangeStatus {
    Applied,
    Failed,
    NotExecuted,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeOperationOutput {
    pub index: usize,
    pub action: FileChangeAction,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub moved_from: Option<String>,
    pub status: FileChangeStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merged: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub added_lines: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed_lines: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_changed_line: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_lines: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_range: Option<ReturnedRange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<FileChangeError>,
    pub truncated: bool,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeSetOutput {
    pub complete: bool,
    pub operations: Vec<FileChangeOperationOutput>,
}

// Legacy file_write DTOs remain only so archived code and historical fixtures can compile.
#[allow(dead_code)]
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileWriteInput {
    pub path: String,
    pub content: String,
    pub expected_revision: Option<String>,
}
#[allow(dead_code)]
#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileWriteOutput {
    pub path: String,
    pub created: bool,
    pub snapshot_id: String,
    pub snapshot_tag: String,
    pub revision: String,
    pub bytes_written: usize,
    pub total_lines: usize,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileFindInput {
    #[schemars(length(min = 1))]
    pub paths: Vec<String>,
    #[serde(rename = "type")]
    pub entry_type: Option<FindType>,
    pub hidden: Option<bool>,
    pub gitignore: Option<bool>,
    pub cursor: Option<String>,
}
#[derive(Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FindType {
    File,
    Directory,
    Any,
}
#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileFindOutput {
    pub entries: Vec<FileFindEntry>,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}
#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileFindEntry {
    pub path: String,
    #[serde(rename = "type")]
    pub entry_type: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileSearchInput {
    #[schemars(length(min = 1))]
    pub pattern: String,
    /// Paths to search. Defaults to ["./"].
    pub paths: Option<Vec<String>>,
    /// Pattern syntax. Defaults to regex.
    pub syntax: Option<SearchSyntax>,
    /// Case-sensitive matching. Defaults to true.
    pub case_sensitive: Option<bool>,
    /// Include hidden files. Defaults to true.
    pub hidden: Option<bool>,
    /// Respect ignore files. Defaults to true.
    pub gitignore: Option<bool>,
    #[schemars(range(min = 0, max = 20))]
    pub context: Option<usize>,
    pub cursor: Option<String>,
}
#[derive(Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchSyntax {
    Literal,
    Regex,
}
#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchOutput {
    pub files: Vec<FileSearchFile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}
#[derive(Clone, Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchFile {
    pub path: String,
    pub content: String,
    pub match_count: usize,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileInfoInput {
    #[schemars(length(min = 1))]
    pub paths: Vec<String>,
}
#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileInfoOutput {
    pub entries: Vec<FileInfoEntry>,
}
#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileInfoEntry {
    pub path: String,
    pub exists: bool,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub entry_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_at_ms: Option<u128>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_type: Option<String>,
}
