use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::sync::mpsc::{SyncSender, TrySendError};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde::Serialize;

use crate::capability::execution::ExecutionConfig;
use crate::capability::rpc::error::RpcError;
use crate::instance::sandbox::path::ResolvedPath;

use super::super::child::ExitLatch;
use super::super::output::{CaptureBudget, CapturePage, Captures};
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
    pub state: &'static str,
    pub latest_seq: u64,
    pub workspace: Option<std::path::PathBuf>,
    pub timed_out: bool,
    pub human_control: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit: Option<Exit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
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
    fn kill(&self) -> Result<(), String> {
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

    fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
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
    pub(super) controller: Option<String>,
    pub(super) revision: u64,
    pub(super) completion: Option<Result<Exit, String>>,
}

pub(in crate::capability::process) struct ManagedProcess {
    pub(super) id: String,
    pub(super) tty: bool,
    pub(super) control: Control,
    pub(super) input: Mutex<Option<SyncSender<Vec<u8>>>>,
    pub(super) workspace: Option<std::path::PathBuf>,
    pub(super) timed_out: std::sync::atomic::AtomicBool,
    pub(super) state: Mutex<State>,
    pub(super) changed: Condvar,
}

impl ManagedProcess {
    pub fn descriptor(&self) -> Descriptor {
        self.describe(&self.state.lock().expect("process state lock poisoned"))
    }

    fn describe(&self, state: &State) -> Descriptor {
        let (status, exit, error) = match &state.completion {
            None => ("running", None, None),
            Some(Ok(exit)) => ("exited", Some(exit.clone()), None),
            Some(Err(error)) => ("failed", None, Some(error.clone())),
        };
        Descriptor {
            id: self.id.clone(),
            tty: self.tty,
            state: status,
            latest_seq: state.output.latest_seq(),
            workspace: self.workspace.clone(),
            timed_out: self.timed_out.load(std::sync::atomic::Ordering::Acquire),
            human_control: state.controller.is_some(),
            exit,
            error,
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
        self.state
            .lock()
            .map_err(lock_error)?
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
        self.enqueue(data)
    }

    pub(super) fn enqueue(&self, data: &[u8]) -> Result<(), RpcError> {
        let input = self.input.lock().map_err(lock_error)?;
        let input = input
            .as_ref()
            .ok_or_else(|| RpcError::new("process.stdinClosed", "stdin is closed"))?;
        input.try_send(data.to_vec()).map_err(|error| match error {
            TrySendError::Full(_) => {
                RpcError::new("process.inputBusy", "terminal input queue is full")
            }
            TrySendError::Disconnected(_) => {
                RpcError::new("process.stdinClosed", "stdin is closed")
            }
        })
    }

    fn authorize_controller(state: &State, controller: Option<&str>) -> Result<(), RpcError> {
        if state.controller.as_deref() != controller {
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
    ) -> Result<(Option<String>, ScreenSnapshot), RpcError> {
        let mut state = self.state.lock().map_err(lock_error)?;
        let screen = state
            .screen
            .as_ref()
            .ok_or_else(|| RpcError::new("process.notTerminal", "process has no PTY"))?;
        let snapshot = screen.snapshot(state.output.latest_seq());
        let controller = if takeover {
            if state.controller.is_some() {
                return Err(RpcError::new(
                    "process.controlOwned",
                    "another participant controls this terminal",
                ));
            }
            let id = uuid::Uuid::new_v4().to_string();
            state.controller = Some(id.clone());
            Some(id)
        } else {
            None
        };
        Ok((controller, snapshot))
    }

    pub fn release_control(&self, controller: &str) {
        if let Ok(mut state) = self.state.lock() {
            if state.controller.as_deref() == Some(controller) {
                state.controller = None;
            }
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
        self.control
            .resize(cols, rows)
            .map_err(|error| RpcError::new("process.resizeFailed", error))?;
        screen.resize(cols, rows)?;
        state.revision += 1;
        self.changed.notify_all();
        Ok(())
    }

    pub fn kill(&self) -> Result<(), RpcError> {
        self.control
            .kill()
            .map_err(|error| RpcError::new("process.killFailed", error))
    }
}

fn lock_error<T>(_: std::sync::PoisonError<T>) -> RpcError {
    RpcError::new("process.internal", "process state lock poisoned")
}
