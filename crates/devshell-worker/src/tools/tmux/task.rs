use std::collections::{HashMap, VecDeque};

use uuid::Uuid;

use crate::platform::unix_time_millis;
use crate::tools::ToolError;
use crate::tools::tmux::backend::BackendPane;
use crate::tools::tmux::output::{OutputWindow, refresh_window};
use crate::tools::tmux::types::{TmuxPaneView, TmuxTaskView, TmuxWarning};

const MAX_COMPLETED_TASKS: usize = 64;
const TASK_RETENTION_MS: u128 = 30 * 60 * 1_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskState {
    Pending,
    Running,
    Exited(i32),
    UnknownActive,
    Lost,
}

impl TaskState {
    pub fn is_active(&self) -> bool {
        matches!(self, Self::Pending | Self::Running | Self::UnknownActive)
    }

    pub fn text(&self) -> String {
        match self {
            Self::Pending | Self::Running => "running".to_string(),
            Self::Exited(code) => code.to_string(),
            Self::UnknownActive | Self::Lost => "unknown".to_string(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct TaskRecord {
    pub id: String,
    pub pane_id: String,
    pub pane_incarnation_id: String,
    pub owner_context_id: String,
    pub state: TaskState,
    pub window: OutputWindow,
    pub start_status_seq: Option<u64>,
    pub started_at_ms: u128,
    pub finished_at_ms: Option<u128>,
    pub last_pane: BackendPane,
    pub warnings: Vec<TmuxWarning>,
}

#[derive(Default)]
pub struct TaskRegistry {
    pub tasks: HashMap<String, TaskRecord>,
    order: VecDeque<String>,
}

impl TaskRegistry {
    pub fn insert(&mut self, task: TaskRecord) {
        self.order.push_back(task.id.clone());
        self.tasks.insert(task.id.clone(), task);
        self.prune();
    }

    pub fn active_for_pane(&self, pane_id: &str) -> Option<&TaskRecord> {
        self.tasks
            .values()
            .find(|task| task.pane_id == pane_id && task.state.is_active())
    }

    pub fn active_for_pane_mut(&mut self, pane_id: &str) -> Option<&mut TaskRecord> {
        let id = self
            .tasks
            .values()
            .find(|task| task.pane_id == pane_id && task.state.is_active())?
            .id
            .clone();
        self.tasks.get_mut(&id)
    }

    pub fn prune(&mut self) {
        let now = unix_time_millis();
        let expired = self
            .tasks
            .iter()
            .filter_map(|(id, task)| {
                (!task.state.is_active()
                    && task
                        .finished_at_ms
                        .is_some_and(|finished| now.saturating_sub(finished) > TASK_RETENTION_MS))
                .then_some(id.clone())
            })
            .collect::<Vec<_>>();
        for id in expired {
            self.remove(&id);
        }

        while self
            .tasks
            .values()
            .filter(|task| !task.state.is_active())
            .count()
            > MAX_COMPLETED_TASKS
        {
            let Some(id) = self
                .order
                .iter()
                .find(|id| {
                    self.tasks
                        .get(*id)
                        .is_some_and(|task| !task.state.is_active())
                })
                .cloned()
            else {
                break;
            };
            self.remove(&id);
        }
    }

    pub fn remove(&mut self, id: &str) {
        self.tasks.remove(id);
        self.order.retain(|candidate| candidate != id);
    }
}

pub fn refresh_task_record(task: &mut TaskRecord, pane: &BackendPane) {
    task.last_pane = pane.clone();
    refresh_window(&mut task.window, pane, &mut task.warnings);
    if pane.status_task_id.as_deref() == Some(&task.id) {
        match pane.status.as_deref() {
            Some("running") => task.state = TaskState::Running,
            Some(value) if value.parse::<i32>().is_ok() => {
                task.state = TaskState::Exited(value.parse().unwrap_or(1));
                task.finished_at_ms.get_or_insert_with(unix_time_millis);
            }
            _ => {}
        }
    } else if matches!(task.state, TaskState::Running)
        && pane.status_seq != task.start_status_seq
        && pane.status.as_deref() != Some("running")
    {
        task.state = TaskState::Lost;
        task.finished_at_ms.get_or_insert_with(unix_time_millis);
    }
}

pub fn pane_view(
    pane: &BackendPane,
    task: Option<&TaskRecord>,
    ctx_id: &str,
    lines: Option<Vec<String>>,
) -> TmuxPaneView {
    let unmanaged_running = task.is_none() && pane.status.as_deref() == Some("running");
    let locked = task.is_some_and(|task| task.state.is_active()) || unmanaged_running;
    let status = task
        .filter(|task| task.state.is_active())
        .map(|task| task.state.text())
        .or_else(|| pane.status.clone())
        .unwrap_or_else(|| "unknown".to_string());
    TmuxPaneView {
        id: pane.id.clone(),
        name: pane.name.clone(),
        tmux_pane_id: pane.tmux_pane_id.clone(),
        active: pane.active,
        status,
        cwd: pane.cwd.clone(),
        command: pane.command.clone(),
        created_at: pane.created_at_ms,
        locked,
        owned_by_current_context: task
            .filter(|task| task.state.is_active())
            .map(|task| task.owner_context_id == ctx_id),
        task: task.filter(|task| task.state.is_active()).map(task_view),
        lines,
    }
}

pub fn task_view(task: &TaskRecord) -> TmuxTaskView {
    TmuxTaskView {
        id: task.id.clone(),
        pane_id: task.pane_id.clone(),
        status: task.state.text(),
        started_at: task.started_at_ms,
        finished_at: task.finished_at_ms,
    }
}

pub fn current_task<'a>(tasks: &'a TaskRegistry, pane_id: &str) -> Option<&'a TaskRecord> {
    tasks.active_for_pane(pane_id)
}

pub fn require_owned_task<'a>(
    tasks: &'a TaskRegistry,
    task_id: &str,
    ctx_id: &str,
) -> Result<&'a TaskRecord, ToolError> {
    let task = tasks
        .tasks
        .get(task_id)
        .ok_or_else(|| task_expired(task_id))?;
    if task.owner_context_id != ctx_id {
        return Err(task_locked(task));
    }
    Ok(task)
}

pub fn task_locked(task: &TaskRecord) -> ToolError {
    ToolError::new(
        "tmux.taskLocked",
        format!("task {} is owned by another context", task.id),
    )
    .with_details(serde_json::json!({
        "task": task.id,
        "pane": task.pane_id,
    }))
}

pub fn task_expired(task_id: &str) -> ToolError {
    ToolError::new(
        "tmux.taskExpired",
        format!("tmux task is unavailable or expired: {task_id}"),
    )
}

pub fn new_task_id() -> String {
    format!("task-{}", Uuid::new_v4().simple())
}
#[cfg(test)]
mod tests {
    use super::{TASK_RETENTION_MS, TaskRecord, TaskRegistry, TaskState, unix_time_millis};
    use crate::tools::tmux::backend::BackendPane;
    use crate::tools::tmux::output::OutputWindow;

    fn pane() -> BackendPane {
        BackendPane {
            id: "pane-main".to_string(),
            name: "main".to_string(),
            tmux_pane_id: "%0".to_string(),
            pane_incarnation_id: "incarnation".to_string(),
            created_at_ms: 1,
            active: true,
            cwd: "/tmp".to_string(),
            command: "bash".to_string(),
            lines: Vec::new(),
            status: Some("idle".to_string()),
            status_seq: Some(1),
            status_task_id: None,
        }
    }

    fn task(id: &str, state: TaskState, finished_at_ms: Option<u128>) -> TaskRecord {
        TaskRecord {
            id: id.to_string(),
            pane_id: "pane-main".to_string(),
            pane_incarnation_id: "incarnation".to_string(),
            owner_context_id: "ctx-test".to_string(),
            state,
            window: OutputWindow::default(),
            start_status_seq: Some(1),
            started_at_ms: 1,
            finished_at_ms,
            last_pane: pane(),
            warnings: Vec::new(),
        }
    }

    #[test]
    fn completed_tasks_expire_but_active_tasks_are_retained() {
        let old = unix_time_millis().saturating_sub(TASK_RETENTION_MS + 1);
        let mut registry = TaskRegistry::default();
        registry.insert(task("completed", TaskState::Exited(0), Some(old)));
        registry.insert(task("running", TaskState::Running, Some(old)));

        assert!(!registry.tasks.contains_key("completed"));
        assert!(registry.tasks.contains_key("running"));
    }
}
