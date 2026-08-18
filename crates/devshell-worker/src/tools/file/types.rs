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

#[derive(Clone, Copy, Debug, JsonSchema, PartialEq, Eq, Serialize)]
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
    /// Content selector using N, N-M, N+count, or sorted non-overlapping comma-separated ranges. Append :raw to disable editing-context expansion; a single N still opens the default window, so use N-N:raw for exactly one line. Without :raw, each range includes one preceding line and up to three following lines. Cannot be combined with view=outline.
    #[schemars(length(min = 1))]
    pub selector: Option<String>,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileReadOutput {
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view: Option<FileReadView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_selector: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parse_status: Option<FileParseStatus>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileChangeSetInput {
    /// Ordered edit document using the *** Begin Edit / *** End Edit format described by this tool.
    #[schemars(length(min = 1))]
    pub changes: String,
    /// Result detail. Defaults to summary.
    pub result_detail: Option<FileChangeResultDetail>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FileChangeResultDetail {
    #[default]
    Summary,
    Diff,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeOperationOutput {
    pub action: FileChangeAction,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub moved_from: Option<String>,
    pub status: FileChangeStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub added_lines: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed_lines: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<FileChangeError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeSetOutput {
    pub operations: Vec<FileChangeOperationOutput>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum FileFindInput {
    Start(FileFindStartInput),
    Continue(FileCursorInput),
}
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileFindStartInput {
    #[schemars(length(min = 1))]
    pub paths: Vec<String>,
    #[serde(rename = "type")]
    /// Entry type filter. Defaults to any.
    pub entry_type: Option<FindType>,
    /// Include hidden entries. Defaults to true.
    pub hidden: Option<bool>,
    /// Respect ignore files. Defaults to true.
    pub gitignore: Option<bool>,
}
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileCursorInput {
    #[schemars(length(min = 1))]
    pub cursor: String,
}
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}
#[derive(Clone, Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileFindEntry {
    pub path: String,
    #[serde(rename = "type")]
    pub entry_type: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum FileSearchInput {
    Start(FileSearchStartInput),
    Continue(FileCursorInput),
}
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileSearchStartInput {
    #[schemars(length(min = 1))]
    pub pattern: String,
    /// Paths to search. Defaults to ["./"].
    #[schemars(length(min = 1))]
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
    /// First source line eligible to match. Only valid for one exact file and defaults to 1.
    #[schemars(range(min = 1))]
    pub start_line: Option<usize>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    /// Present and true when additional matches existed in this file but were not rendered.
    pub truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    /// First omitted matching line. Search this exact file again with startLine to continue.
    pub next_line: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileInfoInput {
    #[schemars(length(min = 1))]
    pub paths: Vec<String>,
    /// Include size, modification time, and mode. Defaults to false.
    pub details: Option<bool>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exists: Option<bool>,
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
