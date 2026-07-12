use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::security::path::{
    FilesystemCapability, PathNamespace, parse_requested_path, resolve_existing_target,
};
use crate::tools::tmux::backend::{BackendPane, BackendWorkspace, MAX_PANES, TmuxBackend};
use crate::tools::tmux::codec::contains_tmux_prefix_input;
use crate::tools::tmux::types::{
    TmuxCapacity, TmuxCaptureParams, TmuxCloseOutput, TmuxCloseParams, TmuxCreateOutput,
    TmuxCreateParams, TmuxInspectParams, TmuxListOutput, TmuxPaneOperationOutput, TmuxPanePosition,
    TmuxPaneView, TmuxSendParams, TmuxWaitMode, TmuxWarning,
};
use crate::tools::{ToolCall, ToolError};

const DEFAULT_LINE: i64 = 80;
const DEFAULT_TIME_MS: u64 = 1000;
const MAX_TIME_MS: u64 = 300_000;
const DEFAULT_INSPECT_START: i64 = -80;
const DEFAULT_INSPECT_END: i64 = 0;
const MAX_INSPECT_LINES: i64 = 200;
const MAX_UNREAD_LINES: usize = 400;

#[derive(Debug, Clone, PartialEq, Eq)]
enum PaneRunState {
    Idle,
    Running,
    Exited(i32),
    Unknown,
}

#[derive(Debug, Default, Clone)]
struct OutputWindow {
    anchor: Vec<String>,
    unread: Vec<String>,
}

#[derive(Debug, Clone)]
struct PaneObservation {
    state: PaneRunState,
    window: Option<OutputWindow>,
    start_status_seq: Option<u64>,
    observed_status_seq: Option<u64>,
    settled_status_seq: Option<u64>,
}

impl Default for PaneObservation {
    fn default() -> Self {
        Self {
            state: PaneRunState::Idle,
            window: None,
            start_status_seq: None,
            observed_status_seq: None,
            settled_status_seq: None,
        }
    }
}

pub struct TmuxState {
    backend: TmuxBackend,
    structure: Mutex<()>,
    pane_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    observations: Mutex<HashMap<String, PaneObservation>>,
}

impl TmuxState {
    pub fn new(backend: TmuxBackend) -> Self {
        Self {
            backend,
            structure: Mutex::new(()),
            pane_locks: Mutex::new(HashMap::new()),
            observations: Mutex::new(HashMap::new()),
        }
    }

    pub fn send(
        &self,
        call: &ToolCall,
        params: TmuxSendParams,
    ) -> Result<TmuxPaneOperationOutput, ToolError> {
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
        let wait = params.wait.unwrap_or(TmuxWaitMode::Block);
        let time_ms = params.time_ms.unwrap_or(DEFAULT_TIME_MS);
        if time_ms == 0 || time_ms > MAX_TIME_MS {
            return Err(ToolError::new(
                "tool.invalidArguments",
                format!("timeMs must be between 1 and {MAX_TIME_MS}"),
            ));
        }
        let line = params.line.unwrap_or(DEFAULT_LINE);
        self.ensure_session()?;
        let initial = self.backend.capture_workspace()?;
        let selected = self
            .backend
            .resolve(&initial, params.pane.as_deref())?
            .clone();
        let pane_lock = self.pane_lock(&selected.id)?;
        let _pane_guard = pane_lock.lock().map_err(|_| lock_error("pane operation"))?;

        let before = self.backend.capture_workspace()?;
        let pane = self.backend.resolve(&before, Some(&selected.id))?.clone();
        let mut warnings = workspace_warnings(&before);
        let mut observation = self.observation(&pane.id)?;
        refresh_observation(&mut observation, &pane, &mut warnings);

        match wait {
            TmuxWaitMode::Block | TmuxWaitMode::Nonblock => match observation.state {
                PaneRunState::Running => {
                    return Err(ToolError::new(
                        "tmux.paneBusy",
                        format!("pane {} is already running a task", pane.name),
                    ));
                }
                PaneRunState::Unknown => {
                    return Err(ToolError::new(
                        "tmux.paneNotReady",
                        format!("pane {} shell status is unavailable", pane.name),
                    ));
                }
                PaneRunState::Idle | PaneRunState::Exited(_) => {
                    discard_window(&pane.id, &mut observation, &mut warnings);
                    observation.window = Some(OutputWindow {
                        anchor: pane.lines.clone(),
                        unread: Vec::new(),
                    });
                    observation.start_status_seq = pane.status_seq;
                    observation.settled_status_seq = None;
                    observation.state = PaneRunState::Running;
                }
            },
            TmuxWaitMode::Interactive => {
                if observation.state != PaneRunState::Running {
                    return Err(ToolError::new(
                        "tmux.noInteractiveTask",
                        "interactive input requires a running task started with wait=nonblock",
                    ));
                }
                if observation.window.is_none() {
                    observation.window = Some(OutputWindow {
                        anchor: pane.lines.clone(),
                        unread: Vec::new(),
                    });
                } else if let Some(window) = observation.window.as_mut() {
                    window.anchor = pane.lines.clone();
                }
            }
        }

        self.backend.send_input(&pane.tmux_pane_id, &params.input)?;
        let deadline = Instant::now() + Duration::from_millis(time_ms);
        let mut after;
        let mut after_pane;
        loop {
            after = self.backend.capture_workspace()?;
            after_pane = self.backend.resolve(&after, Some(&pane.id))?.clone();
            refresh_observation(&mut observation, &after_pane, &mut warnings);
            let done = match wait {
                TmuxWaitMode::Block => matches!(observation.state, PaneRunState::Exited(_)),
                TmuxWaitMode::Nonblock | TmuxWaitMode::Interactive => {
                    observation
                        .window
                        .as_ref()
                        .is_some_and(|window| !window.unread.is_empty())
                        || matches!(observation.state, PaneRunState::Exited(_))
                }
            };
            if done || Instant::now() >= deadline {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }

        if wait == TmuxWaitMode::Block && !matches!(observation.state, PaneRunState::Exited(_)) {
            warnings.push(warning(
                Some(&pane.id),
                "tmux.blockTimeout",
                "block wait timed out; the command is still running",
            ));
        }
        let output = take_output(&pane.id, &mut observation, line, &mut warnings);
        let status = status_text(&observation.state);
        maybe_finish(&mut observation);
        self.store_observation(&pane.id, observation)?;
        Ok(self.pane_output(
            "send",
            vec![pane_view(&after_pane, status, Some(output), None)],
            warnings,
        ))
    }

    pub fn capture(
        &self,
        call: &ToolCall,
        params: TmuxCaptureParams,
    ) -> Result<TmuxPaneOperationOutput, ToolError> {
        require_execute(call)?;
        let line = params.line.unwrap_or(DEFAULT_LINE);
        self.ensure_session()?;
        let workspace = self.backend.capture_workspace()?;
        let selected = self
            .backend
            .resolve(&workspace, params.pane.as_deref())?
            .clone();
        let pane_lock = self.pane_lock(&selected.id)?;
        let _pane_guard = pane_lock.lock().map_err(|_| lock_error("pane operation"))?;
        let current = self.backend.capture_workspace()?;
        let pane = self.backend.resolve(&current, Some(&selected.id))?.clone();
        let mut warnings = workspace_warnings(&current);
        let mut observation = self.observation(&pane.id)?;
        refresh_observation(&mut observation, &pane, &mut warnings);
        let output = take_output(&pane.id, &mut observation, line, &mut warnings);
        let status = status_text(&observation.state);
        maybe_finish(&mut observation);
        self.store_observation(&pane.id, observation)?;
        Ok(self.pane_output(
            "capture",
            vec![pane_view(&pane, status, Some(output), None)],
            warnings,
        ))
    }

    pub fn inspect(
        &self,
        call: &ToolCall,
        params: TmuxInspectParams,
    ) -> Result<TmuxPaneOperationOutput, ToolError> {
        require_execute(call)?;
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
        let selected = if params.panes.is_some() {
            workspace.panes.clone()
        } else {
            vec![
                self.backend
                    .resolve(&workspace, params.pane.as_deref())?
                    .clone(),
            ]
        };
        let mut panes = Vec::with_capacity(selected.len());
        for pane in selected {
            let pane_lock = self.pane_lock(&pane.id)?;
            let _pane_guard = pane_lock.lock().map_err(|_| lock_error("pane operation"))?;
            let lines = self.backend.capture_lines(&pane.tmux_pane_id, start, end)?;
            let status = self.effective_status(&pane)?;
            panes.push(pane_view(&pane, status, None, Some(lines)));
        }
        Ok(self.pane_output("inspect", panes, workspace_warnings(&workspace)))
    }

    pub fn list(&self, call: &ToolCall) -> Result<TmuxListOutput, ToolError> {
        require_execute(call)?;
        self.ensure_session()?;
        let workspace = self.backend.capture_workspace()?;
        let mut panes = Vec::with_capacity(workspace.panes.len());
        for pane in &workspace.panes {
            let pane_lock = self.pane_lock(&pane.id)?;
            let _pane_guard = pane_lock.lock().map_err(|_| lock_error("pane operation"))?;
            panes.push(pane_view(pane, self.effective_status(pane)?, None, None));
        }
        Ok(TmuxListOutput {
            kind: "list".to_string(),
            panes,
            capacity: TmuxCapacity {
                used: workspace.total_panes,
                max: MAX_PANES,
            },
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
        self.store_observation(&pane.id, PaneObservation::default())?;
        let after = self.backend.capture_workspace()?;
        Ok(TmuxCreateOutput {
            kind: "create".to_string(),
            pane: pane_view(&pane, self.effective_status(&pane)?, None, None),
            capacity: TmuxCapacity {
                used: after.total_panes,
                max: MAX_PANES,
            },
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
        let pane = self
            .backend
            .resolve(&workspace, Some(&params.pane))?
            .clone();
        let pane_lock = self.pane_lock(&pane.id)?;
        let _pane_guard = pane_lock.lock().map_err(|_| lock_error("pane operation"))?;
        if !params.force {
            let mut warnings = Vec::new();
            let mut observation = self.observation(&pane.id)?;
            refresh_observation(&mut observation, &pane, &mut warnings);
            maybe_finish(&mut observation);
            if observation.state != PaneRunState::Idle {
                return Err(ToolError::new(
                    "tmux.paneBusy",
                    format!(
                        "pane {} is not idle; use force=true to terminate it",
                        pane.name
                    ),
                ));
            }
        }
        self.backend.close_pane(&pane)?;
        self.observations
            .lock()
            .map_err(|_| lock_error("tmux observations"))?
            .remove(&pane.id);
        self.pane_locks
            .lock()
            .map_err(|_| lock_error("tmux pane locks"))?
            .remove(&pane.id);
        let after = self.backend.capture_workspace()?;
        Ok(TmuxCloseOutput {
            kind: "close".to_string(),
            closed_pane_id: pane.id,
            capacity: TmuxCapacity {
                used: after.total_panes,
                max: MAX_PANES,
            },
            warnings: workspace_warnings(&after),
            observation_epoch: self.backend.observation_epoch().to_string(),
            observation_reset: self.backend.observation_reset(),
        })
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

    fn observation(&self, pane_id: &str) -> Result<PaneObservation, ToolError> {
        Ok(self
            .observations
            .lock()
            .map_err(|_| lock_error("tmux observations"))?
            .get(pane_id)
            .cloned()
            .unwrap_or_default())
    }

    fn store_observation(
        &self,
        pane_id: &str,
        observation: PaneObservation,
    ) -> Result<(), ToolError> {
        self.observations
            .lock()
            .map_err(|_| lock_error("tmux observations"))?
            .insert(pane_id.to_string(), observation);
        Ok(())
    }

    fn effective_status(&self, pane: &BackendPane) -> Result<String, ToolError> {
        let mut warnings = Vec::new();
        let mut observation = self.observation(&pane.id)?;
        refresh_observation(&mut observation, pane, &mut warnings);
        maybe_finish(&mut observation);
        let status = status_text(&observation.state);
        self.store_observation(&pane.id, observation)?;
        Ok(status)
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

fn require_execute(call: &ToolCall) -> Result<(), ToolError> {
    call.policy
        .check_capability(FilesystemCapability::ProcessExecute)
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

fn refresh_observation(
    observation: &mut PaneObservation,
    pane: &BackendPane,
    warnings: &mut Vec<TmuxWarning>,
) {
    if let Some(window) = observation.window.as_mut() {
        refresh_window(window, pane, warnings);
    }
    observation.observed_status_seq = pane.status_seq;
    let mut next = match pane.status.as_deref() {
        Some("idle") => PaneRunState::Idle,
        Some("running") => PaneRunState::Running,
        Some(value) => value
            .parse::<i32>()
            .map(PaneRunState::Exited)
            .unwrap_or(PaneRunState::Unknown),
        None => PaneRunState::Unknown,
    };
    if let PaneRunState::Exited(_) = next {
        if pane.status_seq == observation.start_status_seq {
            next = PaneRunState::Running;
        } else if pane.status_seq == observation.settled_status_seq {
            next = PaneRunState::Idle;
        }
    }
    observation.state = next;
}

fn refresh_window(window: &mut OutputWindow, pane: &BackendPane, warnings: &mut Vec<TmuxWarning>) {
    if pane.lines.len() >= window.anchor.len()
        && pane.lines[..window.anchor.len()] == window.anchor[..]
    {
        append_unread(
            window,
            &pane.lines[window.anchor.len()..],
            &pane.id,
            warnings,
        );
        window.anchor = pane.lines.clone();
        return;
    }
    if let Some(lines) = inline_growth(window, &pane.lines) {
        append_unread(window, &lines, &pane.id, warnings);
        window.anchor = pane.lines.clone();
        return;
    }
    if pane.lines != window.anchor {
        warnings.push(warning(
            Some(&pane.id),
            "tmux.windowResync",
            "terminal history changed outside the current output window; unread output was resynchronized",
        ));
        window.anchor = pane.lines.clone();
        window.unread.clear();
    }
}

fn inline_growth(window: &OutputWindow, current: &[String]) -> Option<Vec<String>> {
    let last = window.anchor.len().checked_sub(1)?;
    if current.len() < window.anchor.len() || current[..last] != window.anchor[..last] {
        return None;
    }
    let current_last = current.get(last)?;
    let anchor_last = window.anchor.get(last)?;
    if !current_last.starts_with(anchor_last) {
        return None;
    }
    let mut lines = Vec::new();
    let suffix = &current_last[anchor_last.len()..];
    if !suffix.is_empty() {
        lines.push(suffix.to_string());
    }
    lines.extend(current.iter().skip(last + 1).cloned());
    Some(lines)
}

fn append_unread(
    window: &mut OutputWindow,
    lines: &[String],
    pane_id: &str,
    warnings: &mut Vec<TmuxWarning>,
) {
    window.unread.extend(lines.iter().cloned());
    let excess = window.unread.len().saturating_sub(MAX_UNREAD_LINES);
    if excess > 0 {
        window.unread.drain(..excess);
        warnings.push(warning(
            Some(pane_id),
            "tmux.outputDropped",
            "oldest unread output was dropped to keep the output window bounded",
        ));
    }
}

fn take_output(
    pane_id: &str,
    observation: &mut PaneObservation,
    line: i64,
    warnings: &mut Vec<TmuxWarning>,
) -> Vec<String> {
    let Some(window) = observation.window.as_mut() else {
        return Vec::new();
    };
    match line.cmp(&0) {
        std::cmp::Ordering::Equal => {
            window.unread.clear();
            Vec::new()
        }
        std::cmp::Ordering::Greater => {
            let count = line as usize;
            let output = window
                .unread
                .iter()
                .take(count)
                .cloned()
                .collect::<Vec<_>>();
            window.unread.drain(..output.len());
            output
        }
        std::cmp::Ordering::Less => {
            let keep = line.unsigned_abs() as usize;
            let split = window.unread.len().saturating_sub(keep);
            if split > 0 {
                warnings.push(warning(
                    Some(pane_id),
                    "tmux.outputSkipped",
                    "earlier unread output was discarded; only the requested tail was returned",
                ));
            }
            let output = window
                .unread
                .iter()
                .skip(split)
                .cloned()
                .collect::<Vec<_>>();
            window.unread.clear();
            output
        }
    }
}

fn discard_window(
    pane_id: &str,
    observation: &mut PaneObservation,
    warnings: &mut Vec<TmuxWarning>,
) {
    if observation
        .window
        .as_ref()
        .is_some_and(|window| !window.unread.is_empty())
    {
        warnings.push(warning(
            Some(pane_id),
            "tmux.outputDiscarded",
            "starting a new task discarded unread output from the previous task",
        ));
    }
}

fn maybe_finish(observation: &mut PaneObservation) {
    let unread = observation
        .window
        .as_ref()
        .is_some_and(|window| !window.unread.is_empty());
    if matches!(observation.state, PaneRunState::Exited(_)) && !unread {
        observation.state = PaneRunState::Idle;
        observation.window = None;
        observation.start_status_seq = None;
        observation.settled_status_seq = observation.observed_status_seq;
    }
}

fn status_text(state: &PaneRunState) -> String {
    match state {
        PaneRunState::Idle => "idle".to_string(),
        PaneRunState::Running => "running".to_string(),
        PaneRunState::Exited(code) => code.to_string(),
        PaneRunState::Unknown => "unknown".to_string(),
    }
}

fn pane_view(
    pane: &BackendPane,
    status: String,
    output: Option<Vec<String>>,
    lines: Option<Vec<String>>,
) -> TmuxPaneView {
    TmuxPaneView {
        id: pane.id.clone(),
        name: pane.name.clone(),
        tmux_pane_id: pane.tmux_pane_id.clone(),
        active: pane.active,
        status,
        cwd: pane.cwd.clone(),
        command: pane.command.clone(),
        created_at: pane.created_at_ms,
        output,
        lines,
    }
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

fn lock_error(name: &str) -> ToolError {
    ToolError::new("tmux.internalError", format!("{name} lock poisoned"))
}
