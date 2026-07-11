use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileReadInput {
    pub path: String,
    pub selector: Option<String>,
}
#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileReadOutput {
    pub path: String,
    pub snapshot_id: String,
    pub snapshot_tag: String,
    pub revision: String,
    pub content: String,
    pub returned_ranges: Vec<ReturnedRange>,
    pub total_lines: usize,
    pub total_bytes: usize,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_selector: Option<String>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed_file: Option<String>,
    pub skipped_files: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_message: Option<String>,
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
pub struct FileWriteInput {
    pub path: String,
    pub content: String,
    pub expected_revision: Option<String>,
}
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
    pub pattern: String,
    pub paths: Option<Vec<String>>,
    pub syntax: Option<SearchSyntax>,
    pub case_sensitive: Option<bool>,
    pub hidden: Option<bool>,
    pub gitignore: Option<bool>,
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
#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchFile {
    pub path: String,
    pub snapshot_id: String,
    pub snapshot_tag: String,
    pub revision: String,
    pub content: String,
    pub match_count: usize,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileInfoInput {
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
