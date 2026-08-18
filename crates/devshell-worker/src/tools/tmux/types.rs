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
    /// Initial task directory. Use ./ for a workspace-relative path or / for an absolute path.
    pub cwd: Option<String>,
    pub command: String,
    #[serde(default)]
    /// Wait mode. Defaults to nonblock.
    pub wait: Option<TmuxWaitMode>,
    #[serde(default)]
    /// Maximum time this call waits for output or completion. Defaults to 30000 and does not stop the task.
    #[schemars(range(min = 0, max = 300000))]
    pub time_ms: Option<u64>,
    #[serde(default)]
    /// Output lines to consume. Defaults to 80. Range: -400..=400.
    #[schemars(range(min = -400, max = 400))]
    pub line: Option<i64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct TmuxInputParams {
    #[serde(default)]
    /// Managed task id returned by tmux_run. Exactly one of task or pane is required.
    pub task: Option<String>,
    #[serde(default)]
    /// Persistent pane name or id returned by tmux_list or tmux_create. Exactly one of task or pane is required.
    pub pane: Option<String>,
    pub input: String,
    #[serde(default)]
    /// Maximum time this call waits for new task transcript output. Defaults to 0 and applies only to task targets.
    #[schemars(range(min = 0, max = 300000))]
    pub time_ms: Option<u64>,
    #[serde(default)]
    /// Task transcript lines to consume after sending input. Defaults to 80, range -400..=400, and applies only to task targets.
    #[schemars(range(min = -400, max = 400))]
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
    /// Output lines to consume. Defaults to 80. Range: -400..=400.
    #[schemars(range(min = -400, max = 400))]
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
    /// Managed pane name returned by tmux_list or tmux_create, or a running task pane returned by tmux_run.
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
    /// Initial pane directory. Use ./ for a workspace-relative path or / for an absolute path.
    pub cwd: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct TmuxCloseParams {
    #[serde(default)]
    /// Managed task id returned by tmux_run. Exactly one of task or pane is required.
    pub task: Option<String>,
    #[serde(default)]
    /// Persistent pane name or id returned by tmux_list or tmux_create. Exactly one of task or pane is required.
    pub pane: Option<String>,
    #[serde(default)]
    pub force: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TmuxTaskView {
    pub id: String,
    pub status: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TmuxPaneRef {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TmuxPaneSummary {
    pub id: String,
    pub name: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task: Option<TmuxTaskView>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TmuxTerminalSize {
    pub columns: usize,
    pub rows: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TmuxPaneDetail {
    pub id: String,
    pub name: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<TmuxTerminalSize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locked: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task: Option<TmuxTaskView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TmuxWarning {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane: Option<String>,
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TmuxTaskOperationOutput {
    pub task: TmuxTaskView,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane: Option<TmuxPaneRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warnings: Option<Vec<TmuxWarning>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TmuxInputOutput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task: Option<TmuxTaskView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane: Option<TmuxPaneRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warnings: Option<Vec<TmuxWarning>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TmuxPaneOperationOutput {
    pub panes: Vec<TmuxPaneDetail>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warnings: Option<Vec<TmuxWarning>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TmuxListOutput {
    pub panes: Vec<TmuxPaneSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warnings: Option<Vec<TmuxWarning>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TmuxCreateOutput {
    pub pane: TmuxPaneRef,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warnings: Option<Vec<TmuxWarning>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TmuxCloseOutput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub closed_task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub closed_pane_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warnings: Option<Vec<TmuxWarning>>,
}
