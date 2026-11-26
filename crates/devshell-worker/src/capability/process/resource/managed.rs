use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{SyncSender, TrySendError};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::capability::execution::ExecutionConfig;
use crate::capability::rpc::error::RpcError;
use crate::instance::sandbox::path::ResolvedPath;

use super::super::child::ExitLatch;
use super::super::output::{CaptureBudget, CapturePage, CaptureSnapshot, Captures};
use super::super::output::{OutputChannel, OutputJournal, OutputPage};
use super::super::pty::TerminalChild;
use super::super::screen::{ScreenSnapshot, TerminalScreen};
use super::super::shell::ShellRuntime;

pub(in crate::capability::process) struct SpawnSpec<'a> {
    pub shell: &'a ShellRuntime,
    pub command: &'a str,
    pub cwd: &'a ResolvedPath,
    pub env: &'a BTreeMap<String, Option<String>>,
    pub execution: Option<&'a ExecutionConfig>,
    pub dimensions: Option<(u16, u16)>,
    pub interactive: bool,
    pub persistent: bool,
    pub name: Option<String>,
    pub stdin: Option<String>,
    pub keep_stdin: bool,
    pub workspace: Option<std::path::PathBuf>,
    pub timeout_ms: Option<u64>,
    pub capture_root: &'a std::path::Path,
    pub capture_budget: Arc<CaptureBudget>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::capability::process) struct Exit {
    pub(super) exit_code: i32,
    pub(super) signal: i32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::capability::process) struct Descriptor {
    pub id: String,
    pub tty: bool,
    pub pty: bool,
    pub interactive: bool,
    pub persistent: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    pub created_at_ms: u128,
    pub state: &'static str,
    pub latest_seq: u64,
    capture: CaptureSnapshot,
    pub workspace: Option<std::path::PathBuf>,
    pub timed_out: bool,
    pub human_control: bool,
    pub terminal: Option<crate::capability::terminal::TerminalDescriptor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit: Option<Exit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::capability::process) struct ReadResult {
    pub process: Descriptor,
    #[serde(flatten)]
    pub output: OutputPage,
}

pub(super) type Writer = Box<dyn Write + Send>;
pub(super) type Reader = Box<dyn Read + Send>;

pub(super) enum Control {
    Pipe { pid: i32, exit: Arc<ExitLatch> },
    Pty(Box<dyn TerminalChild + Send + Sync>),
}

impl Control {
    pub(super) fn kill(&self) -> Result<(), String> {
        match self {
            Self::Pipe { pid, exit } => exit.while_running(|| {
                crate::daemon::process::platform::terminate_process_group(*pid, true)
            }),
            Self::Pty(child) => child.kill(),
        }
    }

    pub(super) fn wait(&self) -> Result<(i32, i32), String> {
        match self {
            Self::Pipe { exit, .. } => exit.wait(),
            Self::Pty(child) => child.wait(),
        }
    }

    pub(super) fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        match self {
            Self::Pipe { .. } => Err("process has no PTY".into()),
            Self::Pty(child) => child.resize(cols, rows),
        }
    }
}

pub(super) struct State {
    pub(super) output: OutputJournal,
    pub(super) captures: Captures,
    pub(super) screen: Option<TerminalScreen>,
    pub(super) controller: Option<ControlOwner>,
    pub(super) version: u64,
    pub(super) created_at_ms: u128,
    pub(super) completion: Option<Result<Exit, ProcessFailure>>,
}

pub(super) struct ProcessFailure {
    pub(super) code: &'static str,
    pub(super) message: String,
}

impl ProcessFailure {
    pub(super) fn task(message: impl Into<String>) -> Self {
        Self {
            code: "process.taskFailed",
            message: message.into(),
        }
    }

    pub(super) fn io(message: impl Into<String>) -> Self {
        Self {
            code: "process.ioFailed",
            message: message.into(),
        }
    }
}

pub(super) struct ControlOwner {
    token: String,
    deadline: Option<Instant>,
    saved_size: Option<(u16, u16)>,
    resized: bool,
}

const REMOTE_CONTROL_LEASE: Duration = Duration::from_secs(30);

impl State {
    pub(super) fn active_controller(&self) -> Option<&str> {
        self.controller
            .as_ref()
            .filter(|owner| {
                owner
                    .deadline
                    .is_none_or(|deadline| deadline > Instant::now())
            })
            .map(|owner| owner.token.as_str())
    }
}

pub(in crate::capability::process) struct ManagedProcess {
    pub(super) id: String,
    pub(super) tty: bool,
    pub(super) interactive: bool,
    pub(super) persistent: bool,
    pub(super) name: Option<String>,
    pub(super) cwd: Option<String>,
    pub(super) command: Option<String>,
    pub(super) closed: AtomicBool,
    pub(super) control: Mutex<Arc<Control>>,
    pub(super) input: Mutex<Option<SyncSender<Vec<u8>>>>,
    pub(super) workspace: Option<std::path::PathBuf>,
    pub(super) provenance: Option<(String, std::path::PathBuf)>,
    pub(super) timed_out: AtomicBool,
    pub(super) state: Mutex<State>,
    pub(super) changed: Condvar,
}

impl ManagedProcess {
    pub fn provenance(&self) -> serde_json::Value {
        match &self.provenance {
            Some((command, cwd)) => serde_json::json!({"command": command, "cwd": cwd}),
            None => serde_json::json!({}),
        }
    }

    pub fn descriptor(&self) -> Descriptor {
        self.describe(&self.state.lock().expect("process state lock poisoned"))
    }

    pub(super) fn describe(&self, state: &State) -> Descriptor {
        let (status, exit, error, error_code) = match &state.completion {
            None => ("running", None, None, None),
            Some(Ok(exit)) => ("exited", Some(exit.clone()), None, None),
            Some(Err(error)) => (
                "failed",
                None,
                Some(error.message.clone()),
                Some(error.code),
            ),
        };
        Descriptor {
            id: self.id.clone(),
            tty: self.tty,
            pty: self.tty,
            interactive: self.interactive,
            persistent: self.persistent,
            name: self.name.clone(),
            cwd: self.cwd.clone(),
            command: self.command.clone(),
            created_at_ms: state.created_at_ms,
            state: status,
            latest_seq: state.output.latest_seq(),
            capture: state.captures.snapshot(),
            workspace: self.workspace.clone(),
            timed_out: self.timed_out.load(Ordering::Acquire),
            human_control: state.active_controller().is_some(),
            terminal: self.terminal_descriptor(state),
            exit,
            error,
            error_code,
        }
    }

    pub fn read(&self, from_seq: u64, wait: Duration) -> Result<ReadResult, RpcError> {
        let state = self.state.lock().map_err(lock_error)?;
        let (state, _) = self
            .changed
            .wait_timeout_while(state, wait, |state| {
                state.completion.is_none() && state.output.latest_seq() <= from_seq
            })
            .map_err(lock_error)?;
        Ok(ReadResult {
            process: self.describe(&state),
            output: state.output.read_after(from_seq),
        })
    }

    pub fn capture(
        &self,
        channel: OutputChannel,
        offset: usize,
        limit: usize,
    ) -> Result<CapturePage, RpcError> {
        self.state.lock().map_err(lock_error)?
            .captures
            .read(channel, offset, limit)
            .map_err(|error| RpcError::new("process.captureFailed", error.to_string()))
    }

    pub fn wait_done(&self, timeout: Duration) -> Result<bool, RpcError> {
        let state = self.state.lock().map_err(lock_error)?;
        let (state, _) = self
            .changed
            .wait_timeout_while(state, timeout, |state| state.completion.is_none())
            .map_err(lock_error)?;
        Ok(state.completion.is_some())
    }

    // The controller check and input enqueue share the resource lock.
    // Once takeover succeeds, a model cannot enqueue input behind it.
    pub fn input(&self, data: &[u8], controller: Option<&str>) -> Result<(), RpcError> {
        let state = self.state.lock().map_err(lock_error)?;
        Self::authorize_controller(&state, controller)?;
        if let Some(completion) = &state.completion {
            return Err(match completion {
                Ok(_) => RpcError::new(
                    "process.exited",
                    "process has already exited; omit input to read retained output",
                ),
                Err(failure) => RpcError::new(failure.code, failure.message.clone()),
            });
        }
        self.enqueue(data)
    }

    pub(super) fn enqueue(&self, data: &[u8]) -> Result<(), RpcError> {
        let stdin_closed = || {
            if self.tty {
                RpcError::new("process.stdinClosed", "stdin is closed")
            } else {
                RpcError::new(
                    "process.stdinClosed",
                    "stdin is closed for non-PTY tasks; use task_manage(command=\"close\", task=...) to stop a running task, or rerun bash_run with pty=true for interactive input",
                )
            }
        };
        let input = self.input.lock().map_err(lock_error)?;
        let input = input.as_ref().ok_or_else(stdin_closed)?;
        input.try_send(data.to_vec()).map_err(|error| match error {
            TrySendError::Full(_) => {
                RpcError::new("process.inputBusy", "terminal input queue is full")
            }
            TrySendError::Disconnected(_) => stdin_closed(),
        })
    }

    pub(super) fn authorize_controller(
        state: &State,
        controller: Option<&str>,
    ) -> Result<(), RpcError> {
        if state.active_controller() != controller {
            return Err(RpcError::new(
                "process.controlOwned",
                "terminal input is controlled by another participant",
            ));
        }
        Ok(())
    }

    pub fn begin_attach(
        &self,
        takeover: bool,
        remote: bool,
    ) -> Result<(Option<String>, ScreenSnapshot), RpcError> {
        let mut state = self.state.lock().map_err(lock_error)?;
        let screen = state
            .screen
            .as_ref()
            .ok_or_else(|| RpcError::new("process.notTerminal", "process has no PTY"))?;
        let snapshot = screen.snapshot(state.output.latest_seq());
        let controller = if takeover {
            if state.active_controller().is_some() {
                return Err(RpcError::new(
                    "process.controlOwned",
                    "another participant controls this terminal",
                ));
            }
            let id = uuid::Uuid::new_v4().to_string();
            state.controller = Some(ControlOwner {
                token: id.clone(),
                deadline: remote.then(|| Instant::now() + REMOTE_CONTROL_LEASE),
                saved_size: Some(screen.size()),
                resized: false,
            });
            Some(id)
        } else {
            None
        };
        Ok((controller, snapshot))
    }

    pub fn has_control(&self, controller: &str) -> bool {
        self.state
            .lock()
            .is_ok_and(|state| state.active_controller() == Some(controller))
    }

    pub fn renew_control(&self, controller: &str) -> Result<(), RpcError> {
        let mut state = self.state.lock().map_err(lock_error)?;
        Self::authorize_controller(&state, Some(controller))?;
        if let Some(owner) = state.controller.as_mut() {
            if owner.deadline.is_some() {
                owner.deadline = Some(Instant::now() + REMOTE_CONTROL_LEASE);
            }
        }
        Ok(())
    }

    pub(super) fn mark_controller_resized(state: &mut State, controller: Option<&str>) {
        if let (Some(token), Some(owner)) = (controller, state.controller.as_mut())
            && owner.token == token
        {
            owner.resized = true;
        }
    }

    pub fn release_control(&self, controller: &str) {
        if let Ok(mut state) = self.state.lock()
            && state
                .controller
                .as_ref()
                .is_some_and(|owner| owner.token == controller)
            && let Some(owner) = state.controller.take()
        {
            if owner.resized
                && state.completion.is_none()
                && let Some((cols, rows)) = owner.saved_size
                && let Some(screen) = state.screen.as_mut()
                && screen.size() != (cols, rows)
                && let Ok(control) = self.control.lock().map(|guard| guard.clone())
                && control.resize(cols, rows).is_ok()
                && screen.resize(cols, rows).is_ok()
            {
                state.version += 1;
            }
            self.changed.notify_all();
        }
    }

    pub fn close_input(&self) -> Result<(), RpcError> {
        if self.tty {
            return Err(RpcError::new(
                "process.notPipe",
                "send terminal EOF using the terminal input sequence",
            ));
        }
        self.input.lock().map_err(lock_error)?.take();
        Ok(())
    }

    pub fn inspect(&self) -> Result<ScreenSnapshot, RpcError> {
        let state = self.state.lock().map_err(lock_error)?;
        let screen = state
            .screen
            .as_ref()
            .ok_or_else(|| RpcError::new("process.notTerminal", "process has no PTY"))?;
        Ok(screen.snapshot(state.output.latest_seq()))
    }

    pub fn resize(&self, cols: u16, rows: u16, controller: Option<&str>) -> Result<(), RpcError> {
        let mut state = self.state.lock().map_err(lock_error)?;
        Self::authorize_controller(&state, controller)?;
        let screen = state
            .screen
            .as_mut()
            .ok_or_else(|| RpcError::new("process.notTerminal", "process has no PTY"))?;
        // Keep the output reader at the same size boundary as the native PTY.
        let control = self.control.lock().map_err(lock_error)?.clone();
        control
            .resize(cols, rows)
            .map_err(|error| RpcError::new("process.resizeFailed", error))?;
        screen.resize(cols, rows)?;
        Self::mark_controller_resized(&mut state, controller);
        state.version += 1;
        self.changed.notify_all();
        Ok(())
    }

    pub fn kill(&self) -> Result<(), RpcError> {
        {
            let _state = self.state.lock().map_err(lock_error)?;
            self.closed.store(true, Ordering::Release);
            self.changed.notify_all();
        }
        let control = self.control.lock().map_err(lock_error)?.clone();
        control
            .kill()
            .map_err(|error| RpcError::new("process.killFailed", error))
    }
}

pub(super) fn lock_error<T>(_: std::sync::PoisonError<T>) -> RpcError {
    RpcError::new("process.internal", "process state lock poisoned")
}
