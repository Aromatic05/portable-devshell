use std::collections::HashMap;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::warning;

use crate::platform::unix_time_millis;
use crate::security::path::{
    FilesystemCapability, PathNamespace, ResolvedPath, parse_requested_path,
    resolve_existing_target,
};
use crate::tools::tmux::backend::{BackendPane, BackendWorkspace, MAX_PANES, TmuxBackend};
use crate::tools::tmux::output::TranscriptCursor;
use crate::tools::tmux::replay::ReplayCache;
use crate::tools::tmux::task::{
    TaskRecord, TaskRegistry, TaskState, current_task, new_task_id, pane_detail, pane_ref,
    pane_summary, refresh_task_record, require_task, task_expired, task_view,
};
use crate::tools::tmux::types::{
    TmuxCloseOutput, TmuxCloseParams, TmuxCreateOutput, TmuxCreateParams, TmuxInputOutput,
    TmuxInputParams, TmuxInspectParams, TmuxListOutput, TmuxPaneDetail, TmuxPaneOperationOutput,
    TmuxReadParams, TmuxRunParams, TmuxTaskOperationOutput, TmuxWaitMode, TmuxWarning,
};
use crate::tools::{ToolCall, ToolError};

const DEFAULT_LINE: i64 = 80;
const MAX_OUTPUT_LINES: i64 = 400;
const DEFAULT_RUN_TIME_MS: u64 = 30_000;
const DEFAULT_INPUT_TIME_MS: u64 = 0;
const DEFAULT_READ_TIME_MS: u64 = 0;
const MAX_TIME_MS: u64 = 300_000;
const DEFAULT_INSPECT_START: i64 = -80;
const DEFAULT_INSPECT_END: i64 = 0;
const MAX_INSPECT_LINES: i64 = 200;
const TASK_REAPER_INTERVAL_MS: u64 = 1_000;
const MAX_QUEUED_WARNINGS: usize = 64;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedTaskRecord {
    schema_version: u32,
    task_id: String,
    pane_id: String,
    status: String,
    finished_at_ms: u128,
}

pub struct TmuxState {
    backend: TmuxBackend,
    structure: Mutex<()>,
    pane_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    tasks: Mutex<TaskRegistry>,
    pending_warnings: Mutex<Vec<TmuxWarning>>,
    replays: ReplayCache,
}

impl TmuxState {
    pub fn new(backend: TmuxBackend) -> Result<Self, ToolError> {
        let mut tasks = TaskRegistry::default();
        for record in backend.load_task_records::<PersistedTaskRecord>()? {
            if record.schema_version != 1 {
                continue;
            }
            let state = match record.status.as_str() {
                "terminated" => TaskState::Terminated,
                "unknown" => TaskState::Lost,
                value => match value.parse::<i32>() {
                    Ok(code) => TaskState::Exited(code),
                    Err(_) => continue,
                },
            };
            tasks.insert(TaskRecord {
                id: record.task_id.clone(),
                pane_id: record.pane_id,
                pane_incarnation_id: String::new(),
                state,
                transcript: TranscriptCursor::restore(
                    backend.transcript_path(&record.task_id),
                    backend.load_task_offset(&record.task_id)?,
                ),
                finished_at_ms: Some(record.finished_at_ms),
                last_pane: None,
                warnings: Vec::new(),
            });
        }
        tasks.prune();
        Ok(Self {
            backend,
            structure: Mutex::new(()),
            pane_locks: Mutex::new(HashMap::new()),
            tasks: Mutex::new(tasks),
            pending_warnings: Mutex::new(Vec::new()),
            replays: ReplayCache::default(),
        })
    }

    pub fn start_reaper(state: &Arc<Self>) {
        let state = Arc::downgrade(state);
        thread::spawn(move || {
            loop {
                thread::sleep(Duration::from_millis(TASK_REAPER_INTERVAL_MS));
                let Some(state) = state.upgrade() else {
                    break;
                };
                let has_lifecycle_work = state.tasks.lock().is_ok_and(|tasks| {
                    tasks.tasks.values().any(|task| {
                        task.state.is_active()
                            || task.last_pane.is_some()
                            || state.backend.task_runtime_pending(&task.id)
                    })
                });
                if !has_lifecycle_work {
                    continue;
                }
                if !state.backend.has_session() {
                    continue;
                }
                if let Err(error) = state.refresh_all_tasks() {
                    let _ = state.push_pending_warning(warning(
                        None,
                        "tmux.reaperFailed",
                        &format!("task pane reaper failed: {}", error.message),
                    ));
                }
            }
        });
    }

    pub fn run(
        &self,
        call: &ToolCall,
        params: TmuxRunParams,
    ) -> Result<TmuxTaskOperationOutput, ToolError> {
        self.replays
            .execute(call, "tmux_run", || self.run_once(call, params))
    }

    fn run_once(
        &self,
        call: &ToolCall,
        params: TmuxRunParams,
    ) -> Result<TmuxTaskOperationOutput, ToolError> {
        call.check_cancelled()?;
        require_execute(call)?;
        if params.command.is_empty() || params.command.contains('\0') {
            return Err(ToolError::new(
                "tool.invalidArguments",
                "command must be non-empty and must not contain NUL",
            ));
        }
        let cwd = resolve_cwd(call, params.cwd.as_deref())?;
        let wait = params.wait.unwrap_or(TmuxWaitMode::Nonblock);
        let time_ms = validate_time(params.time_ms.unwrap_or(DEFAULT_RUN_TIME_MS))?;
        let line = validate_line(params.line.unwrap_or(DEFAULT_LINE))?;

        let task_id = new_task_id();
        {
            let _structure_guard = self
                .structure
                .lock()
                .map_err(|_| lock_error("tmux structure"))?;
            self.backend.ensure_session()?;
            let mut workspace = self.backend.capture_workspace()?;
            if self.refresh_tasks_with_workspace(&workspace)? {
                workspace = self.backend.capture_workspace()?;
            }
            if workspace.total_panes >= MAX_PANES {
                return Err(ToolError::new(
                    "tmux.capacityReached",
                    format!("tmux pane capacity reached ({MAX_PANES})"),
                ));
            }
            let pane = self
                .backend
                .create_task_pane(&task_id, &cwd.canonical, &params.command)?;
            if let Err(error) = verify_pane_cwd(&pane, &cwd) {
                let _ = self.backend.close_pane(&pane);
                self.backend.remove_task_runtime(&task_id);
                let _ = fs::remove_file(self.backend.transcript_path(&task_id));
                return Err(error);
            }
            if let Err(error) = self.backend.start_task_pane(&task_id) {
                let _ = self.backend.close_pane(&pane);
                self.backend.remove_task_runtime(&task_id);
                let _ = fs::remove_file(self.backend.transcript_path(&task_id));
                return Err(error);
            }
            let mut task = TaskRecord {
                id: task_id.clone(),
                pane_id: pane.id.clone(),
                pane_incarnation_id: pane.pane_incarnation_id.clone(),
                state: TaskState::Running,
                transcript: TranscriptCursor::new(self.backend.transcript_path(&task_id)),
                finished_at_ms: None,
                last_pane: Some(pane.clone()),
                warnings: self.output_warnings(&workspace)?,
            };
            refresh_task_record(&mut task, &pane);
            self.tasks
                .lock()
                .map_err(|_| lock_error("tmux tasks"))?
                .insert(task);
        }

        if wait == TmuxWaitMode::Block {
            let deadline = Instant::now() + Duration::from_millis(time_ms);
            while Instant::now() < deadline {
                if call.cancellation.is_cancelled() {
                    return Err(ToolError::new(
                        "tool.cancelled",
                        "tmux_run wait was cancelled; the tmux task was left running.",
                    )
                    .with_details(serde_json::json!({ "task": task_id })));
                }
                self.refresh_task(&task_id)?;
                if self.task_is_terminal(&task_id)? {
                    break;
                }
                thread::sleep(Duration::from_millis(50));
            }
            if !self.task_is_terminal(&task_id)? {
                self.push_task_warning(
                    &task_id,
                    "tmux.blockTimeout",
                    "block wait timed out; the task is still running",
                )?;
            }
        } else {
            self.refresh_task(&task_id)?;
        }

        self.task_output(&task_id, line, true)
    }

    pub fn input(
        &self,
        call: &ToolCall,
        params: TmuxInputParams,
    ) -> Result<TmuxInputOutput, ToolError> {
        self.replays
            .execute(call, "tmux_input", || self.input_once(call, params))
    }

    fn input_once(
        &self,
        call: &ToolCall,
        params: TmuxInputParams,
    ) -> Result<TmuxInputOutput, ToolError> {
        call.check_cancelled()?;
        require_execute(call)?;
        match params {
            TmuxInputParams::Task(params) => {
                if params.input.is_empty() {
                    return Err(ToolError::new(
                        "tool.invalidArguments",
                        "input must not be empty",
                    ));
                }
                let task_id = params.task;
                let time_ms = validate_time(params.time_ms.unwrap_or(DEFAULT_INPUT_TIME_MS))?;
                let line = validate_line(params.line.unwrap_or(DEFAULT_LINE))?;
                self.refresh_task(&task_id)?;
                let (pane_id, tmux_pane_id) = {
                    let tasks = self.tasks.lock().map_err(|_| lock_error("tmux tasks"))?;
                    let task = require_task(&tasks, &task_id)?;
                    if !task.state.is_active() {
                        return Err(ToolError::new(
                            "tmux.taskNotRunning",
                            format!("task {task_id} is no longer running"),
                        ));
                    }
                    let pane = task.last_pane.as_ref().ok_or_else(|| {
                        ToolError::new("tmux.taskNotRunning", "task pane is unavailable")
                    })?;
                    (task.pane_id.clone(), pane.tmux_pane_id.clone())
                };
                let pane_lock = self.pane_lock(&pane_id)?;
                {
                    let _pane_guard = pane_lock.lock().map_err(|_| lock_error("pane operation"))?;
                    self.refresh_task(&task_id)?;
                    {
                        let tasks = self.tasks.lock().map_err(|_| lock_error("tmux tasks"))?;
                        let task = require_task(&tasks, &task_id)?;
                        if !task.state.is_active() {
                            return Err(ToolError::new(
                                "tmux.taskNotRunning",
                                format!("task {task_id} is no longer running"),
                            ));
                        }
                    }
                    self.backend.send_input(&tmux_pane_id, &params.input)?;
                }
                let deadline = Instant::now() + Duration::from_millis(time_ms);
                loop {
                    if call.cancellation.is_cancelled() {
                        return Err(ToolError::new(
                            "tool.cancelled",
                            "tmux_input wait was cancelled after terminal input was delivered.",
                        )
                        .with_details(serde_json::json!({
                            "task": task_id,
                            "inputDelivered": true
                        })));
                    }
                    self.refresh_task(&task_id)?;
                    if self.task_has_output(&task_id)?
                        || self.task_is_terminal(&task_id)?
                        || Instant::now() >= deadline
                    {
                        break;
                    }
                    thread::sleep(Duration::from_millis(50));
                }
                let task_output = self.task_output(&task_id, line, false)?;
                let pane = {
                    let tasks = self.tasks.lock().map_err(|_| lock_error("tmux tasks"))?;
                    let task = require_task(&tasks, &task_id)?;
                    task.state
                        .is_active()
                        .then(|| task.last_pane.as_ref().map(pane_ref))
                        .flatten()
                };
                Ok(TmuxInputOutput {
                    task: Some(task_output.task),
                    pane,
                    output: task_output.output,
                    warnings: task_output.warnings,
                })
            }
            TmuxInputParams::Pane(params) => {
                if params.input.is_empty() {
                    return Err(ToolError::new(
                        "tool.invalidArguments",
                        "input must not be empty",
                    ));
                }
                self.backend.ensure_session()?;
                let mut workspace = self.backend.capture_workspace()?;
                if self.refresh_tasks_with_workspace(&workspace)? {
                    workspace = self.backend.capture_workspace()?;
                }
                let pane = self
                    .backend
                    .resolve(&workspace, Some(&params.pane))?
                    .clone();
                if pane.managed_task_id.is_some() {
                    return Err(ToolError::new(
                        "tmux.taskTargetRequired",
                        "managed task panes must be controlled by task id",
                    ));
                }
                let pane_lock = self.pane_lock(&pane.id)?;
                let _pane_guard = pane_lock.lock().map_err(|_| lock_error("pane operation"))?;
                self.backend.send_input(&pane.tmux_pane_id, &params.input)?;
                Ok(TmuxInputOutput {
                    task: None,
                    pane: Some(pane_ref(&pane)),
                    output: None,
                    warnings: non_empty(self.output_warnings(&workspace)?),
                })
            }
        }
    }

    pub fn read(
        &self,
        call: &ToolCall,
        params: TmuxReadParams,
    ) -> Result<TmuxTaskOperationOutput, ToolError> {
        call.check_cancelled()?;
        require_read(call)?;
        let time_ms = validate_time(params.time_ms.unwrap_or(DEFAULT_READ_TIME_MS))?;
        let line = validate_line(params.line.unwrap_or(DEFAULT_LINE))?;
        let deadline = Instant::now() + Duration::from_millis(time_ms);
        loop {
            call.check_cancelled()?;
            self.refresh_task(&params.task)?;
            if self.task_has_output(&params.task)?
                || self.task_is_terminal(&params.task)?
                || Instant::now() >= deadline
            {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        call.check_cancelled()?;
        self.task_output(&params.task, line, false)
    }

    pub fn inspect(
        &self,
        call: &ToolCall,
        params: TmuxInspectParams,
    ) -> Result<TmuxPaneOperationOutput, ToolError> {
        call.check_cancelled()?;
        require_read(call)?;
        let (pane, all, start, end) = match params {
            TmuxInspectParams::Single(params) => (
                params.pane,
                false,
                params.start.unwrap_or(DEFAULT_INSPECT_START),
                params.end.unwrap_or(DEFAULT_INSPECT_END),
            ),
            TmuxInspectParams::All(params) => {
                let _ = params.panes;
                (
                    None,
                    true,
                    params.start.unwrap_or(DEFAULT_INSPECT_START),
                    params.end.unwrap_or(DEFAULT_INSPECT_END),
                )
            }
        };
        if start >= end || start >= 0 || end > 0 || end - start > MAX_INSPECT_LINES {
            return Err(ToolError::new(
                "tool.invalidArguments",
                "inspect requires start < end <= 0 and a range of at most 200 lines",
            ));
        }
        self.backend.ensure_session()?;
        let mut workspace = self.backend.capture_workspace()?;
        if self.refresh_tasks_with_workspace(&workspace)? {
            workspace = self.backend.capture_workspace()?;
        }
        let selected = if all {
            workspace.panes.clone()
        } else {
            vec![self.backend.resolve(&workspace, pane.as_deref())?.clone()]
        };
        let tasks = self.tasks.lock().map_err(|_| lock_error("tmux tasks"))?;
        let mut panes = Vec::with_capacity(selected.len());
        for pane in selected {
            let lines = self
                .backend
                .capture_lines(&pane.tmux_pane_id, start, end)?;
            panes.push(pane_detail(&pane, current_task(&tasks, &pane.id), lines));
        }
        Ok(self.pane_output(panes, self.output_warnings(&workspace)?))
    }

    pub fn list(&self, call: &ToolCall) -> Result<TmuxListOutput, ToolError> {
        call.check_cancelled()?;
        require_read(call)?;
        self.backend.ensure_session()?;
        let mut workspace = self.backend.capture_workspace()?;
        if self.refresh_tasks_with_workspace(&workspace)? {
            workspace = self.backend.capture_workspace()?;
        }
        let tasks = self.tasks.lock().map_err(|_| lock_error("tmux tasks"))?;
        let panes = workspace
            .panes
            .iter()
            .map(|pane| pane_summary(pane, current_task(&tasks, &pane.id)))
            .collect();
        Ok(TmuxListOutput {
            panes,
            warnings: non_empty(self.output_warnings(&workspace)?),
        })
    }

    pub fn create(
        &self,
        call: &ToolCall,
        params: TmuxCreateParams,
    ) -> Result<TmuxCreateOutput, ToolError> {
        call.check_cancelled()?;
        self.replays
            .execute(call, "tmux_create", || self.create_once(call, params))
    }

    fn create_once(
        &self,
        call: &ToolCall,
        params: TmuxCreateParams,
    ) -> Result<TmuxCreateOutput, ToolError> {
        require_execute(call)?;
        let cwd = resolve_cwd(call, params.cwd.as_deref())?;
        let _structure_guard = self
            .structure
            .lock()
            .map_err(|_| lock_error("tmux structure"))?;
        self.backend.ensure_session()?;
        let mut workspace = self.backend.capture_workspace()?;
        if self.refresh_tasks_with_workspace(&workspace)? {
            workspace = self.backend.capture_workspace()?;
        }
        if workspace.panes.iter().any(|pane| pane.name == params.name) {
            return Err(ToolError::new(
                "tmux.paneNameExists",
                format!("pane name already exists: {}", params.name),
            ));
        }
        if workspace.total_panes >= MAX_PANES {
            return Err(ToolError::new(
                "tmux.capacityReached",
                format!("tmux pane capacity reached ({MAX_PANES})"),
            ));
        }
        let pane = self.backend.create_pane(&params.name, &cwd.canonical)?;
        if let Err(error) = verify_pane_cwd(&pane, &cwd) {
            let _ = self.backend.close_pane(&pane);
            return Err(error);
        }
        let after = self.backend.capture_workspace()?;
        Ok(TmuxCreateOutput {
            pane: pane_ref(&pane),
            warnings: non_empty(self.output_warnings(&after)?),
        })
    }

    pub fn close(
        &self,
        call: &ToolCall,
        params: TmuxCloseParams,
    ) -> Result<TmuxCloseOutput, ToolError> {
        call.check_cancelled()?;
        self.replays
            .execute(call, "tmux_close", || self.close_once(call, params))
    }

    fn close_once(
        &self,
        call: &ToolCall,
        params: TmuxCloseParams,
    ) -> Result<TmuxCloseOutput, ToolError> {
        require_execute(call)?;
        match params {
            TmuxCloseParams::Task(params) => self.close_task(&params.task, params.force),
            TmuxCloseParams::Pane(params) => self.close_persistent_pane(&params.pane, params.force),
        }
    }

    fn close_task(&self, task_id: &str, force: bool) -> Result<TmuxCloseOutput, ToolError> {
        self.refresh_task(task_id)?;
        let task = {
            let tasks = self.tasks.lock().map_err(|_| lock_error("tmux tasks"))?;
            require_task(&tasks, task_id)?.clone()
        };
        if !task.state.is_active() {
            return Err(ToolError::new(
                "tmux.taskNotRunning",
                format!("task {task_id} is no longer running"),
            ));
        }
        if !force {
            return Err(ToolError::new(
                "tmux.taskBusy",
                format!("task {task_id} is running; use force=true to terminate it"),
            ));
        }
        let workspace = self.backend.capture_workspace()?;
        let pane = workspace
            .panes
            .iter()
            .find(|pane| {
                pane.id == task.pane_id && pane.pane_incarnation_id == task.pane_incarnation_id
            })
            .cloned()
            .ok_or_else(|| ToolError::new("tmux.taskNotRunning", "task pane is unavailable"))?;
        let pane_lock = self.pane_lock(&pane.id)?;
        let pane_guard = pane_lock.lock().map_err(|_| lock_error("pane operation"))?;
        let current = self
            .backend
            .capture_workspace()?
            .panes
            .into_iter()
            .find(|current| {
                current.id == pane.id && current.pane_incarnation_id == pane.pane_incarnation_id
            });
        let Some(current) = current else {
            drop(pane_guard);
            self.mark_task_lost(task_id, &pane.id)?;
            return Err(ToolError::new(
                "tmux.taskNotRunning",
                "task pane is no longer available",
            ));
        };
        let already_terminal = {
            let mut tasks = self.tasks.lock().map_err(|_| lock_error("tmux tasks"))?;
            let task = tasks
                .tasks
                .get_mut(task_id)
                .ok_or_else(|| task_expired(task_id))?;
            refresh_task_record(task, &current);
            !task.state.is_active()
        };
        if already_terminal {
            self.persist_task_record(task_id)?;
            drop(pane_guard);
            if let Err(error) = self.cleanup_task_pane(task_id, &current) {
                self.push_pending_warning(cleanup_warning(task_id, Some(&current.id), &error))?;
            }
            return Err(ToolError::new(
                "tmux.taskNotRunning",
                format!("task {task_id} is no longer running"),
            ));
        }
        self.backend.close_pane(&current)?;
        {
            let mut tasks = self.tasks.lock().map_err(|_| lock_error("tmux tasks"))?;
            let task = tasks
                .tasks
                .get_mut(task_id)
                .ok_or_else(|| task_expired(task_id))?;
            task.state = TaskState::Terminated;
            task.finished_at_ms = Some(unix_time_millis());
        }
        self.persist_task_record(task_id)?;
        drop(pane_guard);
        if let Err(error) = self.cleanup_task_pane(task_id, &current) {
            self.push_pending_warning(cleanup_warning(task_id, Some(&current.id), &error))?;
        }
        Ok(TmuxCloseOutput {
            closed_task_id: Some(task_id.to_string()),
            closed_pane_id: None,
            warnings: non_empty(self.take_pending_warnings()?),
        })
    }

    fn close_persistent_pane(
        &self,
        selector: &str,
        force: bool,
    ) -> Result<TmuxCloseOutput, ToolError> {
        let _structure_guard = self
            .structure
            .lock()
            .map_err(|_| lock_error("tmux structure"))?;
        self.backend.ensure_session()?;
        let mut workspace = self.backend.capture_workspace()?;
        if self.refresh_tasks_with_workspace(&workspace)? {
            workspace = self.backend.capture_workspace()?;
        }
        let pane = self.backend.resolve(&workspace, Some(selector))?.clone();
        if pane.managed_task_id.is_some() {
            return Err(ToolError::new(
                "tmux.taskTargetRequired",
                "managed task panes must be closed by task id",
            ));
        }
        if pane.name == "main" {
            return Err(ToolError::new(
                "tmux.mainPane",
                "the main interactive pane cannot be closed",
            ));
        }
        let pane_lock = self.pane_lock(&pane.id)?;
        let _pane_guard = pane_lock.lock().map_err(|_| lock_error("pane operation"))?;
        let current = self
            .backend
            .capture_workspace()?
            .panes
            .into_iter()
            .find(|current| {
                current.id == pane.id && current.pane_incarnation_id == pane.pane_incarnation_id
            })
            .ok_or_else(|| ToolError::new("tmux.paneNotFound", "pane is no longer available"))?;
        if current.status.as_deref() == Some("running") && !force {
            return Err(ToolError::new(
                "tmux.paneBusy",
                format!("pane {} has a running foreground process", current.name),
            ));
        }
        self.backend.close_pane(&current)?;
        self.pane_locks
            .lock()
            .map_err(|_| lock_error("tmux pane locks"))?
            .remove(&pane.id);
        let after = self.backend.capture_workspace()?;
        Ok(TmuxCloseOutput {
            closed_task_id: None,
            closed_pane_id: Some(pane.id),
            warnings: non_empty(self.output_warnings(&after)?),
        })
    }

    fn refresh_all_tasks(&self) -> Result<(), ToolError> {
        let workspace = self.backend.capture_workspace()?;
        self.refresh_tasks_with_workspace(&workspace).map(|_| ())
    }

    fn refresh_task(&self, task_id: &str) -> Result<(), ToolError> {
        let missing = {
            let mut tasks = self.tasks.lock().map_err(|_| lock_error("tmux tasks"))?;
            tasks.prune();
            !tasks.tasks.contains_key(task_id)
        };
        if missing {
            let workspace = self.backend.capture_workspace()?;
            self.refresh_tasks_with_workspace(&workspace)?;
        }
        let task = {
            let mut tasks = self.tasks.lock().map_err(|_| lock_error("tmux tasks"))?;
            tasks.prune();
            tasks
                .tasks
                .get(task_id)
                .cloned()
                .ok_or_else(|| task_expired(task_id))?
        };
        if !task.state.is_active() {
            if let Some(pane) = task.last_pane.as_ref() {
                if let Err(error) = self.cleanup_task_pane(task_id, pane) {
                    self.push_task_cleanup_warning(task_id, &error)?;
                }
            } else if self.backend.task_runtime_pending(task_id) {
                if self.backend.has_session() {
                    let workspace = self.backend.capture_workspace()?;
                    self.refresh_tasks_with_workspace(&workspace)?;
                } else {
                    match self.backend.finish_task_capture(task_id) {
                        Ok(()) => self.backend.remove_task_runtime(task_id),
                        Err(error) => self.push_task_cleanup_warning(task_id, &error)?,
                    }
                }
            }
            return Ok(());
        }
        if !self.backend.has_session() {
            self.mark_task_lost(task_id, &task.pane_id)?;
            return Ok(());
        }
        let workspace = self.backend.capture_workspace()?;
        let pane = workspace.panes.iter().find(|pane| pane.id == task.pane_id);
        let mut completed_pane = None;
        let mut became_terminal = false;
        let mut lost = false;
        {
            let mut tasks = self.tasks.lock().map_err(|_| lock_error("tmux tasks"))?;
            let current = tasks
                .tasks
                .get_mut(task_id)
                .ok_or_else(|| task_expired(task_id))?;
            match pane {
                Some(pane) if pane.pane_incarnation_id == current.pane_incarnation_id => {
                    refresh_task_record(current, pane);
                    if !current.state.is_active() && pane.managed_task_id.is_some() {
                        completed_pane = Some(pane.clone());
                        became_terminal = true;
                    }
                }
                _ => {
                    lost = true;
                }
            }
            tasks.prune();
        }
        if lost {
            self.mark_task_lost(task_id, &task.pane_id)?;
            return Ok(());
        }
        if became_terminal {
            self.persist_task_record(task_id)?;
        }
        if let Some(pane) = completed_pane {
            if let Err(error) = self.cleanup_task_pane(task_id, &pane) {
                self.push_task_cleanup_warning(task_id, &error)?;
            }
        }
        Ok(())
    }

    fn mark_task_lost(&self, task_id: &str, pane_id: &str) -> Result<(), ToolError> {
        {
            let mut tasks = self.tasks.lock().map_err(|_| lock_error("tmux tasks"))?;
            let task = tasks
                .tasks
                .get_mut(task_id)
                .ok_or_else(|| task_expired(task_id))?;
            if !task.state.is_active() {
                return Ok(());
            }
            task.state = TaskState::Lost;
            task.finished_at_ms = Some(unix_time_millis());
        }
        self.persist_task_record(task_id)?;
        self.cleanup_lost_task(task_id, pane_id)?;
        Ok(())
    }

    fn cleanup_lost_task(&self, task_id: &str, pane_id: &str) -> Result<(), ToolError> {
        match self.backend.finish_task_capture(task_id) {
            Ok(()) => self.backend.remove_task_runtime(task_id),
            Err(error) => self.push_task_cleanup_warning(task_id, &error)?,
        }
        self.backend.remove_pane_metadata(pane_id);
        if let Some(task) = self
            .tasks
            .lock()
            .map_err(|_| lock_error("tmux tasks"))?
            .tasks
            .get_mut(task_id)
        {
            task.last_pane = None;
        }
        self.pane_locks
            .lock()
            .map_err(|_| lock_error("tmux pane locks"))?
            .remove(pane_id);
        Ok(())
    }

    fn refresh_tasks_with_workspace(
        &self,
        workspace: &BackendWorkspace,
    ) -> Result<bool, ToolError> {
        let mut cleanup = Vec::new();
        let mut finished = Vec::new();
        let mut lost = Vec::new();
        let mut finalize_only = Vec::new();
        let mut adopted_panes = Vec::new();
        {
            let mut tasks = self.tasks.lock().map_err(|_| lock_error("tmux tasks"))?;
            tasks.prune();
            cleanup.extend(tasks.tasks.values().filter_map(|task| {
                (!task.state.is_active())
                    .then(|| {
                        task.last_pane
                            .as_ref()
                            .map(|pane| (task.id.clone(), pane.clone()))
                    })
                    .flatten()
            }));
            for task in tasks
                .tasks
                .values_mut()
                .filter(|task| task.state.is_active())
            {
                match workspace.panes.iter().find(|pane| pane.id == task.pane_id) {
                    Some(pane) if pane.pane_incarnation_id == task.pane_incarnation_id => {
                        refresh_task_record(task, pane);
                        if !task.state.is_active() && pane.managed_task_id.is_some() {
                            cleanup.push((task.id.clone(), pane.clone()));
                            finished.push(task.id.clone());
                        }
                    }
                    _ => {
                        task.state = TaskState::Lost;
                        task.finished_at_ms = Some(unix_time_millis());
                        finished.push(task.id.clone());
                        lost.push((task.id.clone(), task.pane_id.clone()));
                    }
                }
            }

            for pane in &workspace.panes {
                let Some(task_id) = pane.managed_task_id.as_ref() else {
                    continue;
                };
                if let Some(task) = tasks.tasks.get_mut(task_id) {
                    if !task.state.is_active()
                        && task.last_pane.is_none()
                        && task.pane_id == pane.id
                    {
                        task.pane_incarnation_id = pane.pane_incarnation_id.clone();
                        task.last_pane = Some(pane.clone());
                        cleanup.push((task.id.clone(), pane.clone()));
                    }
                    continue;
                }
                let mut task = TaskRecord {
                    id: task_id.clone(),
                    pane_id: pane.id.clone(),
                    pane_incarnation_id: pane.pane_incarnation_id.clone(),
                    state: TaskState::Running,
                    transcript: TranscriptCursor::restore(
                        self.backend.transcript_path(task_id),
                        self.backend.load_task_offset(task_id)?,
                    ),
                    finished_at_ms: None,
                    last_pane: Some(pane.clone()),
                    warnings: Vec::new(),
                };
                refresh_task_record(&mut task, pane);
                if !task.state.is_active() && pane.managed_task_id.is_some() {
                    cleanup.push((task.id.clone(), pane.clone()));
                    finished.push(task.id.clone());
                }
                if task.state.is_active() {
                    adopted_panes.push(pane.id.clone());
                }
                tasks.insert(task);
            }
            finalize_only.extend(tasks.tasks.values().filter_map(|task| {
                (!task.state.is_active()
                    && task.last_pane.is_none()
                    && self.backend.task_runtime_pending(&task.id))
                .then(|| task.id.clone())
            }));
            tasks.prune();
        }
        let changed = !cleanup.is_empty();
        for task_id in finished {
            self.persist_task_record(&task_id)?;
        }
        for (task_id, pane_id) in lost {
            self.cleanup_lost_task(&task_id, &pane_id)?;
        }
        for (task_id, pane) in cleanup {
            if let Err(error) = self.cleanup_task_pane(&task_id, &pane) {
                self.push_pending_warning(cleanup_warning(&task_id, Some(&pane.id), &error))?;
            }
        }
        for task_id in finalize_only {
            match self.backend.finish_task_capture(&task_id) {
                Ok(()) => self.backend.remove_task_runtime(&task_id),
                Err(error) => self.push_pending_warning(cleanup_warning(&task_id, None, &error))?,
            }
        }
        for pane_id in adopted_panes {
            self.push_pending_warning(warning(
                Some(&pane_id),
                "tmux.taskAdopted",
                "the worker automatically adopted a running managed task after restart",
            ))?;
        }
        Ok(changed)
    }

    fn cleanup_task_pane(&self, task_id: &str, pane: &BackendPane) -> Result<(), ToolError> {
        let pane_lock = self.pane_lock(&pane.id)?;
        let _pane_guard = pane_lock.lock().map_err(|_| lock_error("pane operation"))?;
        let needs_cleanup = {
            let tasks = self.tasks.lock().map_err(|_| lock_error("tmux tasks"))?;
            tasks
                .tasks
                .get(task_id)
                .and_then(|task| task.last_pane.as_ref())
                .is_some_and(|last| {
                    last.id == pane.id && last.pane_incarnation_id == pane.pane_incarnation_id
                })
        };
        if !needs_cleanup {
            return Ok(());
        }
        let workspace = self.backend.capture_workspace()?;
        if let Some(current) = workspace.panes.iter().find(|current| {
            current.id == pane.id && current.pane_incarnation_id == pane.pane_incarnation_id
        }) {
            self.backend.close_pane(current)?;
        }
        self.backend.finish_task_capture(task_id)?;
        self.backend.remove_task_runtime(task_id);
        self.backend.remove_pane_metadata(&pane.id);
        {
            let mut tasks = self.tasks.lock().map_err(|_| lock_error("tmux tasks"))?;
            if let Some(task) = tasks.tasks.get_mut(task_id) {
                if task.last_pane.as_ref().is_some_and(|last| {
                    last.id == pane.id && last.pane_incarnation_id == pane.pane_incarnation_id
                }) {
                    task.last_pane = None;
                }
            }
        }
        self.pane_locks
            .lock()
            .map_err(|_| lock_error("tmux pane locks"))?
            .remove(&pane.id);
        Ok(())
    }

    fn task_output(
        &self,
        task_id: &str,
        line: i64,
        include_pane: bool,
    ) -> Result<TmuxTaskOperationOutput, ToolError> {
        let mut tasks = self.tasks.lock().map_err(|_| lock_error("tmux tasks"))?;
        tasks.prune();
        let task = tasks
            .tasks
            .get_mut(task_id)
            .ok_or_else(|| task_expired(task_id))?;
        let terminal = !task.state.is_active()
            && task.last_pane.is_none()
            && !self.backend.task_runtime_pending(task_id);
        let previous_offset = task.transcript.offset();
        let mut transcript = task.transcript.clone();
        let mut task_warnings = task.warnings.clone();
        let output = transcript.take_output(&task.pane_id, &mut task_warnings, line, terminal)?;
        if transcript.offset() != previous_offset {
            self.backend
                .persist_task_offset(task_id, transcript.offset())?;
        }
        task.transcript = transcript;
        task.warnings = task_warnings;
        let mut warnings = std::mem::take(&mut task.warnings);
        let view = task_view(task);
        let pane = (include_pane && task.state.is_active())
            .then(|| task.last_pane.as_ref().map(pane_ref))
            .flatten();
        drop(tasks);
        warnings.append(&mut self.take_pending_warnings()?);
        Ok(TmuxTaskOperationOutput {
            task: view,
            pane,
            output: non_empty(output),
            warnings: non_empty(warnings),
        })
    }

    fn persist_task_record(&self, task_id: &str) -> Result<(), ToolError> {
        let record = {
            let tasks = self.tasks.lock().map_err(|_| lock_error("tmux tasks"))?;
            let task = require_task(&tasks, task_id)?;
            if task.state.is_active() {
                return Ok(());
            }
            PersistedTaskRecord {
                schema_version: 1,
                task_id: task.id.clone(),
                pane_id: task.pane_id.clone(),
                status: task.state.text(),
                finished_at_ms: task.finished_at_ms.unwrap_or_else(unix_time_millis),
            }
        };
        self.backend.persist_task_record(task_id, &record)
    }

    fn task_has_output(&self, task_id: &str) -> Result<bool, ToolError> {
        let tasks = self.tasks.lock().map_err(|_| lock_error("tmux tasks"))?;
        let task = require_task(&tasks, task_id)?;
        let terminal = !task.state.is_active()
            && task.last_pane.is_none()
            && !self.backend.task_runtime_pending(task_id);
        task.transcript.has_output(terminal)
    }

    fn task_is_terminal(&self, task_id: &str) -> Result<bool, ToolError> {
        Ok(!self
            .tasks
            .lock()
            .map_err(|_| lock_error("tmux tasks"))?
            .tasks
            .get(task_id)
            .ok_or_else(|| task_expired(task_id))?
            .state
            .is_active())
    }

    fn push_task_warning(&self, task_id: &str, code: &str, message: &str) -> Result<(), ToolError> {
        let mut tasks = self.tasks.lock().map_err(|_| lock_error("tmux tasks"))?;
        let task = tasks
            .tasks
            .get_mut(task_id)
            .ok_or_else(|| task_expired(task_id))?;
        let value = warning(Some(&task.pane_id), code, message);
        if task.warnings.iter().any(|existing| {
            existing.code == value.code
                && existing.pane == value.pane
                && existing.message == value.message
        }) {
            return Ok(());
        }
        task.warnings.push(value);
        if task.warnings.len() > MAX_QUEUED_WARNINGS {
            let excess = task.warnings.len() - MAX_QUEUED_WARNINGS;
            task.warnings.drain(..excess);
        }
        Ok(())
    }

    fn push_task_cleanup_warning(&self, task_id: &str, error: &ToolError) -> Result<(), ToolError> {
        self.push_task_warning(
            task_id,
            "tmux.cleanupPending",
            &format!(
                "task finished but terminal cleanup is still pending: {}",
                error.message
            ),
        )
    }

    fn push_pending_warning(&self, value: TmuxWarning) -> Result<(), ToolError> {
        let mut warnings = self
            .pending_warnings
            .lock()
            .map_err(|_| lock_error("tmux warnings"))?;
        if warnings.iter().any(|existing| {
            existing.code == value.code
                && existing.pane == value.pane
                && existing.message == value.message
        }) {
            return Ok(());
        }
        warnings.push(value);
        if warnings.len() > MAX_QUEUED_WARNINGS {
            let excess = warnings.len() - MAX_QUEUED_WARNINGS;
            warnings.drain(..excess);
        }
        Ok(())
    }

    fn take_pending_warnings(&self) -> Result<Vec<TmuxWarning>, ToolError> {
        Ok(std::mem::take(
            &mut *self
                .pending_warnings
                .lock()
                .map_err(|_| lock_error("tmux warnings"))?,
        ))
    }

    fn output_warnings(&self, workspace: &BackendWorkspace) -> Result<Vec<TmuxWarning>, ToolError> {
        let mut warnings = workspace_warnings(workspace);
        if self.backend.take_runtime_migrated() {
            warnings.push(warning(
                None,
                "tmux.runtimeMigrated",
                "an incompatible tmux runtime was replaced; persistent panes and running tasks from the older runtime were reset",
            ));
        }
        warnings.append(&mut self.take_pending_warnings()?);
        Ok(warnings)
    }

    fn pane_lock(&self, pane_id: &str) -> Result<Arc<Mutex<()>>, ToolError> {
        let mut locks = self
            .pane_locks
            .lock()
            .map_err(|_| lock_error("tmux pane locks"))?;
        Ok(locks
            .entry(pane_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone())
    }

    fn pane_output(
        &self,
        panes: Vec<TmuxPaneDetail>,
        warnings: Vec<TmuxWarning>,
    ) -> TmuxPaneOperationOutput {
        TmuxPaneOperationOutput {
            panes,
            warnings: non_empty(warnings),
        }
    }
}

fn validate_time(value: u64) -> Result<u64, ToolError> {
    if value > MAX_TIME_MS {
        return Err(ToolError::new(
            "tool.invalidArguments",
            format!("timeMs must be between 0 and {MAX_TIME_MS}"),
        ));
    }
    Ok(value)
}

fn validate_line(value: i64) -> Result<i64, ToolError> {
    if !(-MAX_OUTPUT_LINES..=MAX_OUTPUT_LINES).contains(&value) {
        return Err(ToolError::new(
            "tool.invalidArguments",
            format!("line must be between -{MAX_OUTPUT_LINES} and {MAX_OUTPUT_LINES}"),
        ));
    }
    Ok(value)
}

fn require_execute(call: &ToolCall) -> Result<(), ToolError> {
    call.policy
        .check_capability(FilesystemCapability::ProcessExecute)
        .map_err(ToolError::from)
}

fn require_read(call: &ToolCall) -> Result<(), ToolError> {
    call.policy
        .check_capability(FilesystemCapability::WorkspaceRead)
        .map_err(ToolError::from)
}

fn resolve_cwd(call: &ToolCall, requested: Option<&str>) -> Result<ResolvedPath, ToolError> {
    let explicit = requested.is_some();
    let raw = requested.unwrap_or("./");
    let requested = parse_requested_path(raw)?;
    if explicit {
        let (read, write) = match requested.namespace {
            PathNamespace::Workspace => (
                FilesystemCapability::WorkspaceRead,
                FilesystemCapability::WorkspaceWrite,
            ),
            PathNamespace::Absolute => (
                FilesystemCapability::AbsoluteRead,
                FilesystemCapability::AbsoluteWrite,
            ),
        };
        call.policy
            .check_capability(read)
            .and_then(|_| call.policy.check_capability(write))
            .map_err(ToolError::from)?;
    }
    let resolved = resolve_existing_target(&call.workspace, &requested)?;
    if !resolved
        .metadata()
        .map_err(|error| ToolError::new("tmux.invalidCwd", error.to_string()))?
        .is_dir()
    {
        return Err(ToolError::new(
            "tmux.invalidCwd",
            format!(
                "pane cwd is not a directory: {}",
                resolved.canonical.display()
            ),
        ));
    }
    Ok(resolved)
}

fn verify_pane_cwd(pane: &BackendPane, expected: &ResolvedPath) -> Result<(), ToolError> {
    let expected_metadata = expected.metadata().map_err(|error| {
        ToolError::retryable(
            "tmux.cwdChanged",
            format!("resolved pane cwd cannot be verified: {error}"),
        )
    })?;
    let actual_metadata = fs::metadata(&pane.cwd).map_err(|error| {
        ToolError::retryable(
            "tmux.cwdChanged",
            format!("created pane cwd cannot be verified: {error}"),
        )
    })?;
    let (expected_device, expected_inode) = expected_metadata.device_and_inode();
    if actual_metadata.dev() != expected_device || actual_metadata.ino() != expected_inode {
        return Err(ToolError::retryable(
            "tmux.cwdChanged",
            format!(
                "created pane cwd does not match the resolved directory: expected {}, received {}",
                expected.canonical.display(),
                pane.cwd,
            ),
        ));
    }
    Ok(())
}

fn non_empty<T>(values: Vec<T>) -> Option<Vec<T>> {
    (!values.is_empty()).then_some(values)
}

fn workspace_warnings(workspace: &BackendWorkspace) -> Vec<TmuxWarning> {
    let mut warnings = Vec::new();
    if workspace.foreign_panes > 0 {
        warnings.push(warning(
            None,
            "tmux.foreignPanes",
            &format!(
                "ignored {} unmanaged pane(s) in the tmux session",
                workspace.foreign_panes
            ),
        ));
    }
    if workspace.total_panes >= MAX_PANES {
        warnings.push(warning(
            None,
            "tmux.capacityFull",
            "managed pane capacity is full",
        ));
    }
    warnings
}

fn lock_error(name: &str) -> ToolError {
    ToolError::new("tmux.internalError", format!("{name} lock poisoned"))
}

fn cleanup_warning(task_id: &str, pane_id: Option<&str>, error: &ToolError) -> TmuxWarning {
    warning(
        pane_id,
        "tmux.cleanupPending",
        &format!(
            "task {task_id} finished but terminal cleanup is still pending: {}",
            error.message
        ),
    )
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{validate_line, verify_pane_cwd};
    use crate::security::path::{parse_requested_path, resolve_existing_target};
    use crate::tools::tmux::backend::BackendPane;

    #[test]
    fn transcript_line_count_is_bounded() {
        assert_eq!(validate_line(-400).unwrap(), -400);
        assert_eq!(validate_line(400).unwrap(), 400);
        assert_eq!(
            validate_line(-401).unwrap_err().code,
            "tool.invalidArguments"
        );
        assert_eq!(
            validate_line(401).unwrap_err().code,
            "tool.invalidArguments"
        );
    }

    #[test]
    fn pane_cwd_verification_rejects_a_created_pane_outside_the_resolved_directory() {
        let root = crate::testing::temp_dir();
        let outside = crate::testing::temp_dir();
        let workspace = root.path().join("workspace");
        fs::create_dir_all(workspace.join("safe")).unwrap();
        let requested = parse_requested_path("./safe").unwrap();
        let resolved = resolve_existing_target(&workspace, &requested).unwrap();
        let mut created = pane();
        created.cwd = outside.path().to_string_lossy().into_owned();
        let error = verify_pane_cwd(&created, &resolved).unwrap_err();
        assert_eq!(error.code, "tmux.cwdChanged");
    }

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
}
