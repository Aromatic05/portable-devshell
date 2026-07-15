use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::security::path::{
    FilesystemCapability, PathNamespace, parse_requested_path, resolve_existing_target,
};
use crate::tools::tmux::backend::{BackendPane, BackendWorkspace, MAX_PANES, TmuxBackend};
use crate::tools::tmux::codec::contains_tmux_prefix_input;
use crate::tools::tmux::output::{OutputWindow, take_output};
use crate::tools::tmux::replay::ReplayCache;
use crate::tools::tmux::task::{
    TaskRecord, TaskRegistry, TaskState, current_task, new_task_id, pane_view, refresh_task_record,
    require_owned_task, task_expired, task_locked, task_view,
};
use crate::tools::tmux::types::{
    TmuxCapacity, TmuxCloseOutput, TmuxCloseParams, TmuxCreateOutput, TmuxCreateParams,
    TmuxInputParams, TmuxInspectParams, TmuxListOutput, TmuxPaneOperationOutput, TmuxPanePosition,
    TmuxPaneView, TmuxReadParams, TmuxRunParams, TmuxTaskOperationOutput, TmuxWaitMode,
    TmuxWarning,
};
use crate::tools::{ToolCall, ToolError};

const DEFAULT_LINE: i64 = 80;
const DEFAULT_RUN_TIME_MS: u64 = 30_000;
const DEFAULT_INPUT_TIME_MS: u64 = 1_000;
const DEFAULT_READ_TIME_MS: u64 = 0;
const MAX_TIME_MS: u64 = 300_000;
const START_CONFIRM_TIME_MS: u64 = 3_000;
const DEFAULT_INSPECT_START: i64 = -80;
const DEFAULT_INSPECT_END: i64 = 0;
const MAX_INSPECT_LINES: i64 = 200;

pub struct TmuxState {
    backend: TmuxBackend,
    structure: Mutex<()>,
    pane_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    tasks: Mutex<TaskRegistry>,
    replays: ReplayCache,
}

impl TmuxState {
    pub fn new(backend: TmuxBackend) -> Self {
        Self {
            backend,
            structure: Mutex::new(()),
            pane_locks: Mutex::new(HashMap::new()),
            tasks: Mutex::new(TaskRegistry::default()),
            replays: ReplayCache::default(),
        }
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
        if params.command.is_empty()
            || params.command.contains('\0')
            || params.command.contains('\n')
            || params.command.contains('\r')
        {
            return Err(ToolError::new(
                "tool.invalidArguments",
                "command must be one non-empty shell command without NUL or newline characters",
            ));
        }
        let wait = params.wait.unwrap_or(TmuxWaitMode::Block);
        let time_ms = validate_time(params.time_ms.unwrap_or(DEFAULT_RUN_TIME_MS))?;
        let line = params.line.unwrap_or(DEFAULT_LINE);

        let task_id = {
            let _structure_guard = self
                .structure
                .lock()
                .map_err(|_| lock_error("tmux structure"))?;
            self.backend.ensure_session()?;
            let mut workspace = self.backend.capture_workspace()?;
            self.refresh_tasks_with_workspace(&workspace)?;

            let mut auto_created = false;
            let pane = if let Some(selector) = params.pane.as_deref() {
                self.backend.resolve(&workspace, Some(selector))?.clone()
            } else if let Some(pane) = self.select_idle_pane(&workspace)? {
                pane
            } else {
                if workspace.total_panes >= MAX_PANES {
                    return Err(ToolError::new(
                        "tmux.capacityReached",
                        format!(
                            "no idle pane is available and tmux pane capacity reached ({MAX_PANES})"
                        ),
                    ));
                }
                let relative = workspace
                    .panes
                    .iter()
                    .find(|pane| pane.name == "main")
                    .or_else(|| workspace.panes.first())
                    .ok_or_else(|| ToolError::new("tmux.paneNotFound", "no managed pane exists"))?;
                let name = next_auto_name(&workspace);
                let pane =
                    self.backend
                        .create_pane(&name, relative, true, None, &call.workspace)?;
                workspace = self.backend.capture_workspace()?;
                auto_created = true;
                pane
            };

            let pane_lock = self.pane_lock(&pane.id)?;
            let _pane_guard = pane_lock.lock().map_err(|_| lock_error("pane operation"))?;
            let current = workspace
                .panes
                .iter()
                .find(|candidate| candidate.id == pane.id)
                .cloned()
                .unwrap_or(pane);
            self.assert_pane_available(call, &current)?;

            let task_id = new_task_id();
            let task = TaskRecord {
                id: task_id.clone(),
                pane_id: current.id.clone(),
                pane_incarnation_id: current.pane_incarnation_id.clone(),
                owner_context_id: call.ctx_id.clone(),
                state: TaskState::Pending,
                window: OutputWindow {
                    anchor: current.lines.clone(),
                    unread: Vec::new(),
                },
                start_status_seq: current.status_seq,
                started_at_ms: now_ms(),
                finished_at_ms: None,
                last_pane: current.clone(),
                warnings: workspace_warnings(&workspace),
            };
            self.tasks
                .lock()
                .map_err(|_| lock_error("tmux tasks"))?
                .insert(task);

            if let Err(error) = self
                .backend
                .prepare_task(&current.id, &task_id)
                .and_then(|_| {
                    self.backend
                        .send_command(&current.tmux_pane_id, &params.command)
                })
            {
                self.backend.clear_pending_task(&current.id);
                self.tasks
                    .lock()
                    .map_err(|_| lock_error("tmux tasks"))?
                    .remove(&task_id);
                if auto_created {
                    let _ = self.backend.close_pane(&current);
                }
                return Err(error);
            }
            task_id
        };

        let start_confirmed =
            self.wait_for_task_start(&task_id, Duration::from_millis(START_CONFIRM_TIME_MS), call)?;
        if start_confirmed.is_none() {
            return Err(ToolError::new(
                "tool.cancelled",
                "tmux_run wait was cancelled; the tmux task was left running.",
            )
            .with_details(serde_json::json!({ "task": task_id })));
        }
        if start_confirmed == Some(false) {
            let pane_id = {
                let mut tasks = self.tasks.lock().map_err(|_| lock_error("tmux tasks"))?;
                let pane_id = tasks.tasks.get(&task_id).map(|task| task.pane_id.clone());
                if let Some(task) = tasks.tasks.get_mut(&task_id) {
                    task.state = TaskState::UnknownActive;
                }
                pane_id
            };
            return Err(ToolError::retryable(
                "tmux.taskStartUnconfirmed",
                "the command was sent but the shell did not confirm the task start",
            )
            .with_details(serde_json::json!({
                "task": task_id,
                "pane": pane_id,
            })));
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

        call.check_cancelled()?;
        self.task_output(call, "run", &task_id, line)
    }

    pub fn input(
        &self,
        call: &ToolCall,
        params: TmuxInputParams,
    ) -> Result<TmuxTaskOperationOutput, ToolError> {
        self.replays
            .execute(call, "tmux_input", || self.input_once(call, params))
    }

    fn input_once(
        &self,
        call: &ToolCall,
        params: TmuxInputParams,
    ) -> Result<TmuxTaskOperationOutput, ToolError> {
        call.check_cancelled()?;
        require_execute(call)?;
        if params.input.is_empty() {
            return Err(ToolError::new(
                "tool.invalidArguments",
                "input must not be empty",
            ));
        }
        if contains_tmux_prefix_input(&params.input) {
            return Err(ToolError::new(
                "tmux.forbiddenInput",
                "tmux prefix input (^B / Ctrl-B) is forbidden",
            ));
        }
        let time_ms = validate_time(params.time_ms.unwrap_or(DEFAULT_INPUT_TIME_MS))?;
        let line = params.line.unwrap_or(DEFAULT_LINE);
        self.refresh_task(&params.task)?;
        let (pane_id, tmux_pane_id, unread_before) = {
            let tasks = self.tasks.lock().map_err(|_| lock_error("tmux tasks"))?;
            let task = require_owned_task(&tasks, &params.task, &call.ctx_id)?;
            if !task.state.is_active() {
                return Err(ToolError::new(
                    "tmux.taskNotRunning",
                    format!("task {} is no longer running", params.task),
                ));
            }
            (
                task.pane_id.clone(),
                task.last_pane.tmux_pane_id.clone(),
                task.window.unread.len(),
            )
        };
        let pane_lock = self.pane_lock(&pane_id)?;
        {
            let _pane_guard = pane_lock.lock().map_err(|_| lock_error("pane operation"))?;
            self.refresh_task(&params.task)?;
            {
                let tasks = self.tasks.lock().map_err(|_| lock_error("tmux tasks"))?;
                let task = require_owned_task(&tasks, &params.task, &call.ctx_id)?;
                if !task.state.is_active() {
                    return Err(ToolError::new(
                        "tmux.taskNotRunning",
                        format!("task {} is no longer running", params.task),
                    ));
                }
            }
            self.backend.send_input(&tmux_pane_id, &params.input)?;
        }

        let deadline = Instant::now() + Duration::from_millis(time_ms);
        loop {
            call.check_cancelled()?;
            self.refresh_task(&params.task)?;
            let (unread, terminal) = {
                let tasks = self.tasks.lock().map_err(|_| lock_error("tmux tasks"))?;
                let task = require_owned_task(&tasks, &params.task, &call.ctx_id)?;
                (task.window.unread.len(), !task.state.is_active())
            };
            if unread > unread_before || terminal || Instant::now() >= deadline {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        call.check_cancelled()?;
        self.task_output(call, "input", &params.task, line)
    }

    pub fn read(
        &self,
        call: &ToolCall,
        params: TmuxReadParams,
    ) -> Result<TmuxTaskOperationOutput, ToolError> {
        call.check_cancelled()?;
        require_read(call)?;
        let time_ms = validate_time(params.time_ms.unwrap_or(DEFAULT_READ_TIME_MS))?;
        let line = params.line.unwrap_or(DEFAULT_LINE);
        let deadline = Instant::now() + Duration::from_millis(time_ms);
        loop {
            call.check_cancelled()?;
            self.refresh_task(&params.task)?;
            let ready = {
                let tasks = self.tasks.lock().map_err(|_| lock_error("tmux tasks"))?;
                let task = require_owned_task(&tasks, &params.task, &call.ctx_id)?;
                !task.window.unread.is_empty() || !task.state.is_active()
            };
            if ready || Instant::now() >= deadline {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        call.check_cancelled()?;
        self.task_output(call, "read", &params.task, line)
    }

    pub fn inspect(
        &self,
        call: &ToolCall,
        params: TmuxInspectParams,
    ) -> Result<TmuxPaneOperationOutput, ToolError> {
        call.check_cancelled()?;
        require_read(call)?;
        if params.pane.is_some() && params.panes.is_some() {
            return Err(ToolError::new(
                "tool.invalidArguments",
                "pane and panes are mutually exclusive",
            ));
        }
        let start = params.start.unwrap_or(DEFAULT_INSPECT_START);
        let end = params.end.unwrap_or(DEFAULT_INSPECT_END);
        if start >= end || start >= 0 || end > 0 || end - start > MAX_INSPECT_LINES {
            return Err(ToolError::new(
                "tool.invalidArguments",
                "inspect requires start < end <= 0 and a range of at most 200 lines",
            ));
        }
        self.ensure_session()?;
        let workspace = self.backend.capture_workspace()?;
        self.refresh_tasks_with_workspace(&workspace)?;
        let selected = if params.panes.is_some() {
            workspace.panes.clone()
        } else {
            vec![
                self.backend
                    .resolve(&workspace, params.pane.as_deref())?
                    .clone(),
            ]
        };
        let tasks = self.tasks.lock().map_err(|_| lock_error("tmux tasks"))?;
        let mut panes = Vec::with_capacity(selected.len());
        for pane in selected {
            let lines = self.backend.capture_lines(&pane.tmux_pane_id, start, end)?;
            panes.push(pane_view(
                &pane,
                current_task(&tasks, &pane.id),
                &call.ctx_id,
                Some(lines),
            ));
        }
        Ok(self.pane_output("inspect", panes, workspace_warnings(&workspace)))
    }

    pub fn list(&self, call: &ToolCall) -> Result<TmuxListOutput, ToolError> {
        call.check_cancelled()?;
        require_read(call)?;
        self.ensure_session()?;
        let workspace = self.backend.capture_workspace()?;
        self.refresh_tasks_with_workspace(&workspace)?;
        call.check_cancelled()?;
        let tasks = self.tasks.lock().map_err(|_| lock_error("tmux tasks"))?;
        let panes = workspace
            .panes
            .iter()
            .map(|pane| pane_view(pane, current_task(&tasks, &pane.id), &call.ctx_id, None))
            .collect();
        Ok(TmuxListOutput {
            kind: "list".to_string(),
            panes,
            capacity: capacity(&workspace),
            warnings: workspace_warnings(&workspace),
            observation_epoch: self.backend.observation_epoch().to_string(),
            observation_reset: self.backend.observation_reset(),
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
        if let Some(size) = params.size_percent
            && !(10..=90).contains(&size)
        {
            return Err(ToolError::new(
                "tool.invalidArguments",
                "sizePercent must be between 10 and 90",
            ));
        }
        let cwd = resolve_cwd(call, params.cwd.as_deref())?;
        let _structure_guard = self
            .structure
            .lock()
            .map_err(|_| lock_error("tmux structure"))?;
        self.backend.ensure_session()?;
        let workspace = self.backend.capture_workspace()?;
        if workspace.total_panes >= MAX_PANES {
            return Err(ToolError::new(
                "tmux.capacityReached",
                format!("tmux pane capacity reached ({MAX_PANES})"),
            ));
        }
        if workspace.panes.iter().any(|pane| pane.name == params.name) {
            return Err(ToolError::new(
                "tmux.paneNameExists",
                format!("pane name already exists: {}", params.name),
            ));
        }
        let relative = if let Some(selector) = params.relative_to.as_deref() {
            self.backend.resolve(&workspace, Some(selector))?
        } else {
            workspace
                .panes
                .iter()
                .find(|pane| pane.name == "main")
                .or_else(|| workspace.panes.first())
                .ok_or_else(|| ToolError::new("tmux.paneNotFound", "no managed pane exists"))?
        };
        let pane = self.backend.create_pane(
            &params.name,
            relative,
            params.position.unwrap_or(TmuxPanePosition::Right) == TmuxPanePosition::Right,
            params.size_percent,
            &cwd,
        )?;
        let after = self.backend.capture_workspace()?;
        Ok(TmuxCreateOutput {
            kind: "create".to_string(),
            pane: pane_view(&pane, None, &call.ctx_id, None),
            capacity: capacity(&after),
            warnings: workspace_warnings(&after),
            observation_epoch: self.backend.observation_epoch().to_string(),
            observation_reset: self.backend.observation_reset(),
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
        let _structure_guard = self
            .structure
            .lock()
            .map_err(|_| lock_error("tmux structure"))?;
        self.backend.ensure_session()?;
        let workspace = self.backend.capture_workspace()?;
        if workspace.panes.len() <= 1 {
            return Err(ToolError::new(
                "tmux.lastPane",
                "the final managed pane cannot be closed",
            ));
        }
        self.refresh_tasks_with_workspace(&workspace)?;
        let pane = self
            .backend
            .resolve(&workspace, Some(&params.pane))?
            .clone();
        let pane_lock = self.pane_lock(&pane.id)?;
        let _pane_guard = pane_lock.lock().map_err(|_| lock_error("pane operation"))?;

        {
            let mut tasks = self.tasks.lock().map_err(|_| lock_error("tmux tasks"))?;
            if let Some(task) = tasks.active_for_pane_mut(&pane.id) {
                if task.owner_context_id != call.ctx_id {
                    return Err(task_locked(task));
                }
                if !params.force {
                    return Err(ToolError::new(
                        "tmux.paneBusy",
                        format!(
                            "pane {} is running task {}; use force=true to terminate it",
                            pane.name, task.id
                        ),
                    ));
                }
                refresh_task_record(task, &pane);
                task.state = TaskState::Lost;
                task.finished_at_ms = Some(now_ms());
            } else if pane.status.as_deref() == Some("running") && !params.force {
                return Err(ToolError::new(
                    "tmux.paneBusy",
                    format!("pane {} has a running foreground process", pane.name),
                ));
            }
        }

        self.backend.close_pane(&pane)?;
        self.pane_locks
            .lock()
            .map_err(|_| lock_error("tmux pane locks"))?
            .remove(&pane.id);
        let after = self.backend.capture_workspace()?;
        Ok(TmuxCloseOutput {
            kind: "close".to_string(),
            closed_pane_id: pane.id,
            capacity: capacity(&after),
            warnings: workspace_warnings(&after),
            observation_epoch: self.backend.observation_epoch().to_string(),
            observation_reset: self.backend.observation_reset(),
        })
    }

    fn select_idle_pane(
        &self,
        workspace: &BackendWorkspace,
    ) -> Result<Option<BackendPane>, ToolError> {
        let tasks = self.tasks.lock().map_err(|_| lock_error("tmux tasks"))?;
        let available = |pane: &&BackendPane| {
            tasks.active_for_pane(&pane.id).is_none()
                && pane
                    .status
                    .as_deref()
                    .is_some_and(|status| status == "idle" || status.parse::<i32>().is_ok())
        };
        Ok(workspace
            .panes
            .iter()
            .filter(available)
            .min_by_key(|pane| (pane.name != "main", pane.created_at_ms))
            .cloned())
    }

    fn assert_pane_available(&self, call: &ToolCall, pane: &BackendPane) -> Result<(), ToolError> {
        let tasks = self.tasks.lock().map_err(|_| lock_error("tmux tasks"))?;
        if let Some(task) = tasks.active_for_pane(&pane.id) {
            if task.owner_context_id != call.ctx_id {
                return Err(task_locked(task));
            }
            return Err(ToolError::new(
                "tmux.paneBusy",
                format!("pane {} is already running task {}", pane.name, task.id),
            ));
        }
        match pane.status.as_deref() {
            Some("idle") => Ok(()),
            Some(value) if value.parse::<i32>().is_ok() => Ok(()),
            Some("running") => Err(ToolError::new(
                "tmux.paneBusy",
                format!("pane {} has a running foreground process", pane.name),
            )),
            _ => Err(ToolError::new(
                "tmux.paneNotReady",
                format!("pane {} shell status is unavailable", pane.name),
            )),
        }
    }

    fn wait_for_task_start(
        &self,
        task_id: &str,
        timeout: Duration,
        call: &ToolCall,
    ) -> Result<Option<bool>, ToolError> {
        let deadline = Instant::now() + timeout;
        loop {
            if call.cancellation.is_cancelled() {
                return Ok(None);
            }
            self.refresh_task(task_id)?;
            let state = self
                .tasks
                .lock()
                .map_err(|_| lock_error("tmux tasks"))?
                .tasks
                .get(task_id)
                .ok_or_else(|| task_expired(task_id))?
                .state
                .clone();
            if !matches!(state, TaskState::Pending) {
                return Ok(Some(matches!(
                    state,
                    TaskState::Running | TaskState::Exited(_)
                )));
            }
            if Instant::now() >= deadline {
                return Ok(Some(false));
            }
            thread::sleep(Duration::from_millis(25));
        }
    }

    fn refresh_task(&self, task_id: &str) -> Result<(), ToolError> {
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
            return Ok(());
        }
        let workspace = self.backend.capture_workspace()?;
        let pane = workspace.panes.iter().find(|pane| pane.id == task.pane_id);
        let mut tasks = self.tasks.lock().map_err(|_| lock_error("tmux tasks"))?;
        let current = tasks
            .tasks
            .get_mut(task_id)
            .ok_or_else(|| task_expired(task_id))?;
        match pane {
            Some(pane) if pane.pane_incarnation_id == current.pane_incarnation_id => {
                refresh_task_record(current, pane);
            }
            _ => {
                current.state = TaskState::Lost;
                current.finished_at_ms = Some(now_ms());
            }
        }
        tasks.prune();
        Ok(())
    }

    fn refresh_tasks_with_workspace(&self, workspace: &BackendWorkspace) -> Result<(), ToolError> {
        let mut tasks = self.tasks.lock().map_err(|_| lock_error("tmux tasks"))?;
        for task in tasks
            .tasks
            .values_mut()
            .filter(|task| task.state.is_active())
        {
            match workspace.panes.iter().find(|pane| pane.id == task.pane_id) {
                Some(pane) if pane.pane_incarnation_id == task.pane_incarnation_id => {
                    refresh_task_record(task, pane);
                }
                _ => {
                    task.state = TaskState::Lost;
                    task.finished_at_ms = Some(now_ms());
                }
            }
        }
        let orphans = workspace
            .panes
            .iter()
            .filter_map(|pane| {
                let task_id = pane.status_task_id.as_ref()?;
                (pane.status.as_deref() == Some("running")
                    && tasks.active_for_pane(&pane.id).is_none()
                    && !tasks.tasks.contains_key(task_id))
                .then(|| TaskRecord {
                    id: task_id.clone(),
                    pane_id: pane.id.clone(),
                    pane_incarnation_id: pane.pane_incarnation_id.clone(),
                    owner_context_id: "__orphaned__".to_string(),
                    state: TaskState::Running,
                    window: OutputWindow {
                        anchor: pane.lines.clone(),
                        unread: Vec::new(),
                    },
                    start_status_seq: pane.status_seq,
                    started_at_ms: now_ms(),
                    finished_at_ms: None,
                    last_pane: pane.clone(),
                    warnings: vec![warning(
                        Some(&pane.id),
                        "tmux.taskOrphaned",
                        "the worker adopted a running task without its previous owner context",
                    )],
                })
            })
            .collect::<Vec<_>>();
        for task in orphans {
            tasks.insert(task);
        }
        tasks.prune();
        Ok(())
    }

    fn task_output(
        &self,
        call: &ToolCall,
        kind: &str,
        task_id: &str,
        line: i64,
    ) -> Result<TmuxTaskOperationOutput, ToolError> {
        let mut tasks = self.tasks.lock().map_err(|_| lock_error("tmux tasks"))?;
        tasks.prune();
        let task = tasks
            .tasks
            .get_mut(task_id)
            .ok_or_else(|| task_expired(task_id))?;
        if task.owner_context_id != call.ctx_id {
            return Err(task_locked(task));
        }
        let output = take_output(&mut task.window, &task.pane_id, &mut task.warnings, line);
        let warnings = std::mem::take(&mut task.warnings);
        let view = task_view(task);
        let pane = pane_view(&task.last_pane, Some(task), &call.ctx_id, None);
        Ok(TmuxTaskOperationOutput {
            kind: kind.to_string(),
            task: view,
            pane,
            output,
            warnings,
            observation_epoch: self.backend.observation_epoch().to_string(),
            observation_reset: self.backend.observation_reset(),
        })
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
        task.warnings
            .push(warning(Some(&task.pane_id), code, message));
        Ok(())
    }

    fn ensure_session(&self) -> Result<(), ToolError> {
        let _guard = self
            .structure
            .lock()
            .map_err(|_| lock_error("tmux structure"))?;
        self.backend.ensure_session()
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
        kind: &str,
        panes: Vec<TmuxPaneView>,
        warnings: Vec<TmuxWarning>,
    ) -> TmuxPaneOperationOutput {
        TmuxPaneOperationOutput {
            kind: kind.to_string(),
            panes,
            warnings,
            observation_epoch: self.backend.observation_epoch().to_string(),
            observation_reset: self.backend.observation_reset(),
        }
    }
}

fn capacity(workspace: &BackendWorkspace) -> TmuxCapacity {
    TmuxCapacity {
        used: workspace.total_panes,
        max: MAX_PANES,
    }
}

fn next_auto_name(workspace: &BackendWorkspace) -> String {
    for index in 1..=MAX_PANES {
        let name = format!("auto-{index}");
        if workspace.panes.iter().all(|pane| pane.name != name) {
            return name;
        }
    }
    format!("auto-{}", now_ms())
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

fn require_execute(call: &ToolCall) -> Result<(), ToolError> {
    call.policy
        .check_capability(FilesystemCapability::ProcessExecute)
        .map_err(|error| ToolError::new(error.code, error.message))
}

fn require_read(call: &ToolCall) -> Result<(), ToolError> {
    call.policy
        .check_capability(FilesystemCapability::WorkspaceRead)
        .map_err(|error| ToolError::new(error.code, error.message))
}

fn resolve_cwd(call: &ToolCall, requested: Option<&str>) -> Result<PathBuf, ToolError> {
    let Some(raw) = requested else {
        return Ok(call.workspace.clone());
    };
    let requested = parse_requested_path(raw)?;
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
        .map_err(|error| ToolError::new(error.code, error.message))?;
    let resolved = resolve_existing_target(&call.workspace, &requested)?.canonical;
    if !resolved.is_dir() {
        return Err(ToolError::new(
            "tmux.invalidCwd",
            format!("pane cwd is not a directory: {}", resolved.display()),
        ));
    }
    Ok(resolved)
}

fn workspace_warnings(workspace: &BackendWorkspace) -> Vec<TmuxWarning> {
    if workspace.foreign_panes == 0 {
        Vec::new()
    } else {
        vec![warning(
            None,
            "tmux.foreignPanes",
            &format!(
                "{} pane(s) without devshell ownership metadata are hidden",
                workspace.foreign_panes
            ),
        )]
    }
}

fn warning(pane: Option<&str>, code: &str, message: &str) -> TmuxWarning {
    TmuxWarning {
        pane: pane.map(ToOwned::to_owned),
        code: code.to_string(),
        message: message.to_string(),
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn lock_error(name: &str) -> ToolError {
    ToolError::new("tmux.internalError", format!("{name} lock poisoned"))
}

#[cfg(test)]
mod tests {
    use super::next_auto_name;
    use crate::tools::tmux::backend::{BackendPane, BackendWorkspace};

    #[test]
    fn automatic_pane_names_use_the_first_gap() {
        let pane = |name: &str| BackendPane {
            id: name.to_string(),
            name: name.to_string(),
            tmux_pane_id: "%1".to_string(),
            pane_incarnation_id: name.to_string(),
            created_at_ms: 1,
            active: false,
            cwd: "/tmp".to_string(),
            command: "bash".to_string(),
            lines: vec![],
            status: Some("idle".to_string()),
            status_seq: Some(1),
            status_task_id: None,
        };
        let workspace = BackendWorkspace {
            panes: vec![pane("main"), pane("auto-1"), pane("auto-3")],
            total_panes: 3,
            foreign_panes: 0,
        };
        assert_eq!(next_auto_name(&workspace), "auto-2");
    }
}
