use serde::{Deserialize, Serialize};
use schemars::JsonSchema;

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileReadInput { pub path: String, pub ranges: Option<Vec<LineRange>> }
#[derive(Clone, Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LineRange { pub start_line: usize, pub line_count: usize }
#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileReadOutput { pub path: String, pub snapshot_id: String, pub revision: String, pub content: String, pub returned_ranges: Vec<ReturnedRange>, pub total_lines: usize, pub total_bytes: usize, pub truncated: bool, pub next_start_line: Option<usize> }
#[derive(Clone, Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReturnedRange { pub start_line: usize, pub end_line: usize }

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileEditInput { pub path: String, pub snapshot_id: String, pub operations: Vec<FileEditOperation> }
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum FileEditOperation {
    Replace { start_line: usize, end_line: usize, lines: Vec<String> },
    Delete { start_line: usize, end_line: usize },
    Insert { at: InsertAt, line: Option<usize>, lines: Vec<String> },
}
#[derive(Debug, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum InsertAt { Before, After, Head, Tail }
#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileEditOutput { pub path: String, pub snapshot_id: String, pub revision: String, pub added_lines: usize, pub removed_lines: usize, pub first_changed_line: usize, pub content: String, pub returned_ranges: Vec<ReturnedRange>, pub total_lines: usize, pub total_bytes: usize, pub truncated: bool }

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileWriteInput { pub path: String, pub content: String, pub mode: FileWriteMode, pub expected_revision: Option<String> }
#[derive(Debug, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum FileWriteMode { Create, Overwrite }
#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileWriteOutput { pub path: String, pub created: bool, pub snapshot_id: String, pub revision: String, pub bytes_written: usize, pub total_lines: usize }

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileFindInput { pub path: Option<String>, pub patterns: Option<Vec<String>>, #[serde(rename = "type")] pub entry_type: Option<FindType>, pub include_hidden: Option<bool>, pub respect_gitignore: Option<bool>, pub limit: Option<usize>, pub cursor: Option<String> }
#[derive(Debug, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum FindType { File, Directory, Any }
#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileFindOutput { pub entries: Vec<FileFindEntry>, pub next_cursor: Option<String> }
#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileFindEntry { pub path: String, #[serde(rename = "type")] pub entry_type: String }

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileSearchInput { pub pattern: String, pub syntax: Option<SearchSyntax>, pub path: Option<String>, pub include: Option<Vec<String>>, pub exclude: Option<Vec<String>>, pub case_sensitive: Option<bool>, pub include_hidden: Option<bool>, pub respect_gitignore: Option<bool>, pub context: Option<usize>, pub max_files: Option<usize>, pub max_matches_per_file: Option<usize>, pub cursor: Option<String> }
#[derive(Debug, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum SearchSyntax { Literal, Regex }
#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchOutput { pub files: Vec<FileSearchFile>, pub next_cursor: Option<String> }
#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchFile { pub path: String, pub snapshot_id: String, pub revision: String, pub content: String, pub match_count: usize }

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileInfoInput { pub path: String }
#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileInfoOutput { pub path: String, #[serde(rename = "type")] pub entry_type: String, pub size_bytes: u64, pub modified_at_ms: u128, pub mode: Option<u32>, pub target_type: Option<String> }
