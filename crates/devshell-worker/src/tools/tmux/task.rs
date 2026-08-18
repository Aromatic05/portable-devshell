use std::collections::HashMap;

use uuid::Uuid;

use crate::platform::unix_time_millis;
use crate::tools::ToolError;
use crate::tools::tmux::backend::BackendPane;
use crate::tools::tmux::output::TranscriptCursor;
use crate::tools::tmux::types::{
    TmuxPaneDetail, TmuxPaneRef, TmuxPaneSummary, TmuxTaskView, TmuxTerminalSize, TmuxWarning,
};

const MAX_COMPLETED_TASKS: usize = 64;
const TASK_RETENTION_MS: u128 = 30 * 60 * 1_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskState {
    Running,
    Exited(i32),
    Terminated,
    Lost,
}

impl TaskState {
    pub fn is_active(&self) -> bool {
        matches!(self, Self::Running)
    }

    pub fn text(&self) -> String {
        match self {
            Self::Running => "running".to_string(),
            Self::Exited(code) => code.to_string(),
            Self::Terminated => "terminated".to_string(),
            Self::Lost => "unknown".to_string(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct TaskRecord {
    pub id: String,
    pub pane_id: String,
    pub pane_incarnation_id: String,
    pub state: TaskState,
    pub transcript: TranscriptCursor,
    pub finished_at_ms: Option<u128>,
    pub last_pane: Option<BackendPane>,
    pub warnings: Vec<TmuxWarning>,
}

#[derive(Default)]
pub struct TaskRegistry {
    pub tasks: HashMap<String, TaskRecord>,
}

impl TaskRegistry {
    pub fn insert(&mut self, task: TaskRecord) {
        self.tasks.insert(task.id.clone(), task);
        self.prune();
    }

    pub fn active_for_pane(&self, pane_id: &str) -> Option<&TaskRecord> {
        self.tasks
            .values()
            .find(|task| task.pane_id == pane_id && task.state.is_active())
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
                .tasks
                .iter()
                .filter(|(_, task)| !task.state.is_active())
                .min_by_key(|(_, task)| task.finished_at_ms.unwrap_or(0))
                .map(|(id, _)| id.clone())
            else {
                break;
            };
            self.remove(&id);
        }
    }

    pub fn remove(&mut self, id: &str) {
        if let Some(task) = self.tasks.remove(id) {
            let _ = std::fs::remove_file(&task.transcript.path);
            let _ = std::fs::remove_file(task.transcript.path.with_extension("json"));
            let _ = std::fs::remove_file(task.transcript.path.with_extension("done"));
            let _ = std::fs::remove_file(task.transcript.path.with_extension("offset"));
        }
    }
}

pub fn refresh_task_record(task: &mut TaskRecord, pane: &BackendPane) {
    task.last_pane = Some(pane.clone());
    if pane.managed_task_id.as_deref() == Some(&task.id) {
        match pane.status.as_deref() {
            Some("running") => task.state = TaskState::Running,
            Some(value) if value.parse::<i32>().is_ok() => {
                task.state = TaskState::Exited(value.parse().unwrap_or(1));
                task.finished_at_ms.get_or_insert_with(unix_time_millis);
            }
            Some("unknown") => {
                task.state = TaskState::Lost;
                task.finished_at_ms.get_or_insert_with(unix_time_millis);
            }
            _ => {}
        }
    } else if task.state.is_active() {
        task.state = TaskState::Lost;
        task.finished_at_ms.get_or_insert_with(unix_time_millis);
    }
}

pub fn pane_ref(pane: &BackendPane) -> TmuxPaneRef {
    TmuxPaneRef {
        id: pane.id.clone(),
        name: pane.name.clone(),
    }
}

pub fn pane_summary(pane: &BackendPane, task: Option<&TaskRecord>) -> TmuxPaneSummary {
    TmuxPaneSummary {
        id: pane.id.clone(),
        name: pane.name.clone(),
        status: pane_status(pane, task),
        task: active_task(task),
    }
}

pub fn pane_detail(
    pane: &BackendPane,
    task: Option<&TaskRecord>,
    lines: Vec<String>,
) -> TmuxPaneDetail {
    let unmanaged_running = task.is_none() && pane.status.as_deref() == Some("running");
    let locked = task.is_some_and(|task| task.state.is_active()) || unmanaged_running;
    TmuxPaneDetail {
        id: pane.id.clone(),
        name: pane.name.clone(),
        status: pane_status(pane, task),
        cwd: (!pane.cwd.is_empty()).then(|| pane.cwd.clone()),
        command: (!pane.command.is_empty()).then(|| pane.command.clone()),
        size: Some(TmuxTerminalSize {
            columns: pane.columns,
            rows: pane.rows,
        }),
        locked: locked.then_some(true),
        task: active_task(task),
        lines: (!lines.is_empty()).then_some(lines),
    }
}

fn pane_status(pane: &BackendPane, task: Option<&TaskRecord>) -> String {
    task.filter(|task| task.state.is_active())
        .map(|task| task.state.text())
        .or_else(|| pane.status.clone())
        .unwrap_or_else(|| "unknown".to_string())
}

fn active_task(task: Option<&TaskRecord>) -> Option<TmuxTaskView> {
    task.filter(|task| task.state.is_active()).map(task_view)
}

pub fn task_view(task: &TaskRecord) -> TmuxTaskView {
    TmuxTaskView {
        id: task.id.clone(),
        status: task.state.text(),
    }
}

pub fn current_task<'a>(tasks: &'a TaskRegistry, pane_id: &str) -> Option<&'a TaskRecord> {
    tasks.active_for_pane(pane_id)
}

pub fn require_task<'a>(
    tasks: &'a TaskRegistry,
    task_id: &str,
) -> Result<&'a TaskRecord, ToolError> {
    tasks
        .tasks
        .get(task_id)
        .ok_or_else(|| task_expired(task_id))
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
    use super::{
        TASK_RETENTION_MS, TaskRecord, TaskRegistry, TaskState, refresh_task_record,
        unix_time_millis,
    };
    use crate::tools::tmux::backend::BackendPane;
    use crate::tools::tmux::output::TranscriptCursor;

    fn pane() -> BackendPane {
        BackendPane {
            id: "pane-main".to_string(),
            name: "main".to_string(),
            tmux_pane_id: "%0".to_string(),
            columns: 240,
            rows: 60,
            pane_incarnation_id: "incarnation".to_string(),
            created_at_ms: 1,
            cwd: "/tmp".to_string(),
            command: "bash".to_string(),
            status: Some("idle".to_string()),
            managed_task_id: None,
        }
    }

    fn task(id: &str, state: TaskState, finished_at_ms: Option<u128>) -> TaskRecord {
        TaskRecord {
            id: id.to_string(),
            pane_id: "pane-main".to_string(),
            pane_incarnation_id: "incarnation".to_string(),
            state,
            transcript: TranscriptCursor::new(std::env::temp_dir().join(format!("{id}.log"))),
            finished_at_ms,
            last_pane: Some(pane()),
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

    #[test]
    fn completed_task_cap_evicts_the_oldest_finish_time() {
        let now = unix_time_millis();
        let mut registry = TaskRegistry::default();
        for index in 0..=64u128 {
            registry.insert(task(
                &format!("task-{index:02}"),
                TaskState::Exited(0),
                Some(now.saturating_sub(index)),
            ));
        }

        assert!(registry.tasks.contains_key("task-00"));
        assert!(!registry.tasks.contains_key("task-64"));
        assert_eq!(registry.tasks.len(), 64);
    }

    #[test]
    fn unknown_managed_pane_marks_running_task_lost() {
        let mut task = task("task-a", TaskState::Running, None);
        let mut pane = pane();
        pane.managed_task_id = Some("task-a".to_string());
        pane.status = Some("unknown".to_string());

        refresh_task_record(&mut task, &pane);

        assert_eq!(task.state, TaskState::Lost);
        assert!(task.finished_at_ms.is_some());
    }
}
