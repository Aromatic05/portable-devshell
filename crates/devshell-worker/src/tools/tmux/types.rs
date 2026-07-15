use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TmuxWaitMode {
    Block,
    Nonblock,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct TmuxRunParams {
    #[serde(default)]
    /// Managed pane name returned by tmux_list or tmux_create.
    pub pane: Option<String>,
    pub command: String,
    #[serde(default)]
    /// Wait mode. Defaults to block.
    pub wait: Option<TmuxWaitMode>,
    #[serde(default)]
    /// Maximum time this call waits for output or completion. Defaults to 30000 and does not stop the task.
    #[schemars(range(min = 0, max = 300000))]
    pub time_ms: Option<u64>,
    #[serde(default)]
    /// Output lines to consume. Defaults to 80.
    pub line: Option<i64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct TmuxInputParams {
    pub task: String,
    pub input: String,
    #[serde(default)]
    /// Maximum time this call waits for new output. Defaults to 1000.
    #[schemars(range(min = 0, max = 300000))]
    pub time_ms: Option<u64>,
    #[serde(default)]
    /// Output lines to consume. Defaults to 80.
    pub line: Option<i64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct TmuxReadParams {
    pub task: String,
    #[serde(default)]
    /// Maximum time this call waits for new output. Defaults to 0.
    #[schemars(range(min = 0, max = 300000))]
    pub time_ms: Option<u64>,
    #[serde(default)]
    /// Output lines to consume. Defaults to 80.
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
    /// Managed pane name returned by tmux_list or tmux_create.
    pub pane: Option<String>,
    #[serde(default)]
    pub panes: Option<TmuxInspectAll>,
    #[serde(default)]
    /// History start offset. Defaults to -80 and must be less than end.
    #[schemars(range(max = -1))]
    pub start: Option<i64>,
    #[serde(default)]
    /// History end offset. Defaults to 0. At most 200 lines may be requested.
    #[schemars(range(max = 0))]
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
    #[schemars(
        length(min = 1, max = 64),
        regex(pattern = r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
    )]
    pub name: String,
    #[serde(default)]
    /// Managed pane name returned by tmux_list or tmux_create.
    pub relative_to: Option<String>,
    #[serde(default)]
    pub position: Option<TmuxPanePosition>,
    #[serde(default)]
    #[schemars(range(min = 10, max = 90))]
    pub size_percent: Option<u8>,
    #[serde(default)]
    pub cwd: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct TmuxCloseParams {
    /// Managed pane name returned by tmux_list or tmux_create.
    pub pane: String,
    #[serde(default)]
    pub force: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TmuxTaskView {
    pub id: String,
    pub pane_id: String,
    pub status: String,
    pub started_at: u128,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<u128>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
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
    pub locked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owned_by_current_context: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task: Option<TmuxTaskView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TmuxCapacity {
    pub used: usize,
    pub max: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TmuxWarning {
    pub pane: Option<String>,
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TmuxTaskOperationOutput {
    pub kind: String,
    pub task: TmuxTaskView,
    pub pane: TmuxPaneView,
    pub output: Vec<String>,
    pub warnings: Vec<TmuxWarning>,
    pub observation_epoch: String,
    pub observation_reset: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TmuxPaneOperationOutput {
    pub kind: String,
    pub panes: Vec<TmuxPaneView>,
    pub warnings: Vec<TmuxWarning>,
    pub observation_epoch: String,
    pub observation_reset: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TmuxListOutput {
    pub kind: String,
    pub panes: Vec<TmuxPaneView>,
    pub capacity: TmuxCapacity,
    pub warnings: Vec<TmuxWarning>,
    pub observation_epoch: String,
    pub observation_reset: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TmuxCreateOutput {
    pub kind: String,
    pub pane: TmuxPaneView,
    pub capacity: TmuxCapacity,
    pub warnings: Vec<TmuxWarning>,
    pub observation_epoch: String,
    pub observation_reset: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TmuxCloseOutput {
    pub kind: String,
    pub closed_pane_id: String,
    pub capacity: TmuxCapacity,
    pub warnings: Vec<TmuxWarning>,
    pub observation_epoch: String,
    pub observation_reset: bool,
}
