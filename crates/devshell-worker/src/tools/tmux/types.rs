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
    #[schemars(length(min = 1))]
    pub cwd: Option<String>,
    #[schemars(length(min = 1))]
    pub command: String,
    #[serde(default)]
    /// Wait mode. Defaults to nonblock.
    pub wait: Option<TmuxWaitMode>,
    #[serde(default)]
    /// Maximum time an explicit wait=block call waits for output or completion. Defaults to 30000 and never stops the task.
    #[schemars(range(min = 0, max = 300000))]
    pub time_ms: Option<u64>,
    #[serde(default)]
    /// Output lines to consume. Defaults to 80. Range: -400..=400.
    #[schemars(range(min = -400, max = 400))]
    pub line: Option<i64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum TmuxInputParams {
    Task(TmuxTaskInputParams),
    Pane(TmuxPaneInputParams),
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct TmuxTaskInputParams {
    /// Managed task id returned by tmux_run.
    #[schemars(length(min = 1))]
    pub task: String,
    #[schemars(length(min = 1))]
    pub input: String,
    #[serde(default)]
    /// Maximum time this call waits for new task transcript output. Defaults to 0.
    #[schemars(range(min = 0, max = 300000))]
    pub time_ms: Option<u64>,
    #[serde(default)]
    /// Task transcript lines to consume after sending input. Defaults to 80, range -400..=400.
    #[schemars(range(min = -400, max = 400))]
    pub line: Option<i64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct TmuxPaneInputParams {
    /// Persistent pane name or id returned by tmux_list or tmux_create.
    #[schemars(length(min = 1))]
    pub pane: String,
    #[schemars(length(min = 1))]
    pub input: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct TmuxReadParams {
    #[schemars(length(min = 1))]
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
#[serde(untagged)]
pub enum TmuxInspectParams {
    Single(TmuxInspectSingleParams),
    All(TmuxInspectAllParams),
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct TmuxInspectSingleParams {
    /// Pane name or id. Omit to inspect the built-in main pane.
    #[serde(default)]
    #[schemars(length(min = 1))]
    pub pane: Option<String>,
    #[serde(default)]
    /// History start offset. Defaults to -80 and must be less than end.
    #[schemars(range(max = -1))]
    pub start: Option<i64>,
    #[serde(default)]
    /// History end offset. Defaults to 0. At most 200 lines may be requested.
    #[schemars(range(max = 0))]
    pub end: Option<i64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct TmuxInspectAllParams {
    /// Set to all to inspect every current pane.
    pub panes: TmuxInspectAll,
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
    #[schemars(length(min = 1))]
    pub cwd: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum TmuxCloseParams {
    Task(TmuxTaskCloseParams),
    Pane(TmuxPaneCloseParams),
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct TmuxTaskCloseParams {
    /// Managed task id returned by tmux_run.
    #[schemars(length(min = 1))]
    pub task: String,
    #[serde(default)]
    /// Defaults to false. A running managed task requires force=true.
    pub force: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct TmuxPaneCloseParams {
    /// Persistent pane name or id returned by tmux_list or tmux_create.
    #[schemars(length(min = 1))]
    pub pane: String,
    #[serde(default)]
    /// Defaults to false. A pane with a running foreground program requires force=true.
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

#[cfg(test)]
mod tests {
    use schemars::schema_for;
    use serde_json::json;

    use super::{TmuxCloseParams, TmuxInputParams, TmuxInspectParams};

    #[test]
    fn target_inputs_are_schema_unions() {
        for schema in [
            serde_json::to_value(schema_for!(TmuxInputParams)).unwrap(),
            serde_json::to_value(schema_for!(TmuxCloseParams)).unwrap(),
            serde_json::to_value(schema_for!(TmuxInspectParams)).unwrap(),
        ] {
            assert_eq!(
                schema["anyOf"].as_array().map(Vec::len),
                Some(2),
                "{schema}"
            );
        }
    }

    #[test]
    fn target_inputs_reject_ambiguous_shapes() {
        assert!(
            serde_json::from_value::<TmuxInputParams>(
                json!({ "task": "task-1", "pane": "main", "input": "x" })
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<TmuxCloseParams>(
                json!({ "task": "task-1", "pane": "main", "force": true })
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<TmuxInspectParams>(json!({ "pane": "main", "panes": "all" }))
                .is_err()
        );
        assert!(serde_json::from_value::<TmuxInspectParams>(json!({})).is_ok());
    }
}
