use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TmuxWaitMode {
    Block,
    Nonblock,
    Interactive,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct TmuxSendParams {
    #[serde(default)]
    pub pane: Option<String>,
    pub input: String,
    #[serde(default)]
    pub wait: Option<TmuxWaitMode>,
    #[serde(default)]
    pub time_ms: Option<u64>,
    #[serde(default)]
    pub line: Option<i64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct TmuxCaptureParams {
    #[serde(default)]
    pub pane: Option<String>,
    #[serde(default)]
    pub line: Option<i64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum TmuxInspectAll {
    All,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct TmuxInspectParams {
    #[serde(default)]
    pub pane: Option<String>,
    #[serde(default)]
    pub panes: Option<TmuxInspectAll>,
    #[serde(default)]
    pub start: Option<i64>,
    #[serde(default)]
    pub end: Option<i64>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TmuxListParams {}

#[derive(Clone, Copy, Debug, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TmuxPanePosition {
    Right,
    Below,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct TmuxCreateParams {
    pub name: String,
    #[serde(default)]
    pub relative_to: Option<String>,
    #[serde(default)]
    pub position: Option<TmuxPanePosition>,
    #[serde(default)]
    pub size_percent: Option<u8>,
    #[serde(default)]
    pub cwd: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct TmuxCloseParams {
    pub pane: String,
    #[serde(default)]
    pub force: bool,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TmuxPaneView {
    pub id: String,
    pub name: String,
    pub tmux_pane_id: String,
    pub active: bool,
    pub status: String,
    pub cwd: String,
    pub command: String,
    pub created_at: u128,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines: Option<Vec<String>>,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TmuxCapacity {
    pub used: usize,
    pub max: usize,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TmuxWarning {
    pub pane: Option<String>,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TmuxPaneOperationOutput {
    pub kind: String,
    pub panes: Vec<TmuxPaneView>,
    pub warnings: Vec<TmuxWarning>,
    pub observation_epoch: String,
    pub observation_reset: bool,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TmuxListOutput {
    pub kind: String,
    pub panes: Vec<TmuxPaneView>,
    pub capacity: TmuxCapacity,
    pub warnings: Vec<TmuxWarning>,
    pub observation_epoch: String,
    pub observation_reset: bool,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TmuxCreateOutput {
    pub kind: String,
    pub pane: TmuxPaneView,
    pub capacity: TmuxCapacity,
    pub warnings: Vec<TmuxWarning>,
    pub observation_epoch: String,
    pub observation_reset: bool,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TmuxCloseOutput {
    pub kind: String,
    pub closed_pane_id: String,
    pub capacity: TmuxCapacity,
    pub warnings: Vec<TmuxWarning>,
    pub observation_epoch: String,
    pub observation_reset: bool,
}
