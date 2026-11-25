use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde::Serialize;

use crate::capability::execution::ExecutionConfig;
use crate::capability::rpc::error::RpcError;
use crate::instance::sandbox::path::ResolvedPath;

use super::capture::{CaptureBudget, CapturePage, Captures};
use super::child::{ExitLatch, reap, wait_until_exit};
use super::output::{OutputChannel, OutputJournal, OutputPage, READ_CHUNK};
use super::pty::{TerminalChild, spawn_managed};
use super::screen::{ScreenSnapshot, TerminalScreen};
use super::shell::{ShellCommand, ShellRuntime};

pub(super) struct SpawnSpec<'a> {
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
pub(super) struct Exit {
    exit_code: i32,
    signal: i32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Descriptor {
    pub id: String,
    pub tty: bool,
    pub state: &'static str,
    pub latest_seq: u64,
    pub workspace: Option<std::path::PathBuf>,
    pub timed_out: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit: Option<Exit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ReadResult {
    process: Descriptor,
    #[serde(flatten)]
    output: OutputPage,
}

type Writer = Box<dyn Write + Send>;
type Reader = Box<dyn Read + Send>;

enum Control {
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

    fn wait(&self) -> Result<(i32, i32), String> {
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

struct State {
    output: OutputJournal,
    captures: Captures,
    screen: Option<TerminalScreen>,
    revision: u64,
    completion: Option<Result<Exit, String>>,
}

pub(super) struct ManagedProcess {
    id: String,
    tty: bool,
    control: Control,
    input: Mutex<Option<SyncSender<Vec<u8>>>>,
    workspace: Option<std::path::PathBuf>,
    timed_out: std::sync::atomic::AtomicBool,
    state: Mutex<State>,
    changed: Condvar,
}

impl ManagedProcess {
    pub fn spawn(id: String, spec: SpawnSpec<'_>) -> Result<Arc<Self>, RpcError> {
        let captures = Captures::new(spec.capture_root, Arc::clone(&spec.capture_budget))
            .map_err(|error| RpcError::new("process.captureFailed", error.to_string()))?;
        let screen = spec
            .dimensions
            .map(|(cols, rows)| TerminalScreen::new(cols, rows))
            .transpose()?;
        let (control, writer, outputs): (Control, Writer, Vec<(OutputChannel, Reader)>) =
            if let Some((cols, rows)) = spec.dimensions {
                let prepared = ShellCommand::prepare(
                    spec.shell,
                    spec.command,
                    spec.env,
                    spec.execution,
                    true,
                )?;
                let terminal = spawn_managed(&prepared, spec.cwd, cols, rows)?;
                (
                    Control::Pty(terminal.child),
                    terminal.writer,
                    vec![(OutputChannel::Terminal, terminal.reader)],
                )
            } else {
                let mut child = super::pipe::spawn_shell(
                    spec.shell,
                    spec.command,
                    spec.cwd,
                    spec.env,
                    spec.execution,
                )?;
                let pid = child.id() as i32;
                // spawn_shell always establishes these three pipes.
                let writer = Box::new(child.stdin.take().expect("piped stdin"));
                let stdout = Box::new(child.stdout.take().expect("piped stdout"));
                let stderr = Box::new(child.stderr.take().expect("piped stderr"));
                let exit = Arc::new(ExitLatch::default());
                let waiter = Arc::clone(&exit);
                std::thread::spawn(move || {
                    let observed = wait_until_exit(&mut child).map_err(|error| error.to_string());
                    waiter.finish(|| {
                        let cleanup = if observed.is_ok() {
                            crate::daemon::process::platform::terminate_process_group(pid, true)
                        } else {
                            Ok(())
                        };
                        let status = reap(&mut child);
                        observed.and(cleanup).and(status)
                    });
                });
                (
                    Control::Pipe { pid, exit },
                    writer,
                    vec![
                        (OutputChannel::Stdout, stdout),
                        (OutputChannel::Stderr, stderr),
                    ],
                )
            };

        let tty = spec.dimensions.is_some();
        let keep_stdin = tty || spec.keep_stdin;
        let (input_tx, input_rx) = mpsc::sync_channel::<Vec<u8>>(32);
        // Initial input enters the same ordered queue as later input. The
        // request thread never waits for a blocked child to consume bytes.
        if let Some(stdin) = spec.stdin {
            input_tx
                .try_send(stdin.into_bytes())
                .expect("empty input queue");
        }
        let process = Arc::new(Self {
            id,
            tty,
            control,
            input: Mutex::new(if keep_stdin { Some(input_tx) } else { None }),
            workspace: spec.workspace,
            timed_out: std::sync::atomic::AtomicBool::new(false),
            state: Mutex::new(State {
                screen,
                captures,
                output: OutputJournal::default(),
                revision: 0,
                completion: None,
            }),
            changed: Condvar::new(),
        });
        std::thread::spawn(move || {
            let mut writer = writer;
            while let Ok(bytes) = input_rx.recv() {
                if writer
                    .write_all(&bytes)
                    .and_then(|_| writer.flush())
                    .is_err()
                {
                    break;
                }
            }
        });
        let readers: Vec<_> = outputs
            .into_iter()
            .map(|(channel, mut reader)| {
                let process = Arc::clone(&process);
                std::thread::spawn(move || {
                    let mut bytes = vec![0; READ_CHUNK];
                    loop {
                        match reader.read(&mut bytes) {
                            Ok(0) => return Ok(()),
                            Ok(n) => {
                                let mut state = process
                                    .state
                                    .lock()
                                    .map_err(|_| "process state lock poisoned")?;
                                let replies = if let Some(screen) = state.screen.as_mut() {
                                    screen.process(&bytes[..n])
                                } else {
                                    Vec::new()
                                };
                                state.captures.append(channel, &bytes[..n]);
                                state.output.append(channel, &bytes[..n]);
                                state.revision += 1;
                                process.changed.notify_all();
                                drop(state);
                                if !replies.is_empty() {
                                    process.input(&replies).map_err(|error| error.message)?;
                                }
                            }
                            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {
                                continue;
                            }
                            // Linux PTYs return EIO once their last slave closes.
                            #[cfg(unix)]
                            Err(error)
                                if process.tty && error.raw_os_error() == Some(nix::libc::EIO) =>
                            {
                                return Ok(());
                            }
                            Err(error) => return Err(error.to_string()),
                        }
                    }
                })
            })
            .collect();
        let observed = Arc::clone(&process);
        std::thread::spawn(move || {
            let exit = observed
                .control
                .wait()
                .map(|(exit_code, signal)| Exit { exit_code, signal });
            // The input endpoint no longer belongs to a live process.
            if let Ok(mut input) = observed.input.lock() {
                input.take();
            }
            // Publish terminal status only after both output streams have
            // drained, so an exited result includes the command's final bytes.
            let mut failure = None;
            for reader in readers {
                match reader.join() {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => {
                        failure.get_or_insert(error);
                    }
                    Err(_) => {
                        failure.get_or_insert("process output reader panicked".into());
                    }
                }
            }
            let mut state = observed.state.lock().expect("process state lock poisoned");
            state.completion = Some(match failure {
                Some(error) => Err(error),
                None => exit,
            });
            state.revision += 1;
            observed.changed.notify_all();
        });

        if let Some(timeout_ms) = spec.timeout_ms {
            let target = Arc::downgrade(&process);
            std::thread::spawn(move || {
                if let Some(target) = target.upgrade() {
                    if target
                        .wait_done(Duration::from_millis(timeout_ms))
                        .is_ok_and(|done| !done)
                    {
                        target
                            .timed_out
                            .store(true, std::sync::atomic::Ordering::Release);
                        let _ = target.kill();
                    }
                }
            });
        }
        Ok(process)
    }

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

    pub fn input(&self, data: &[u8]) -> Result<(), RpcError> {
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

    pub fn viewport(
        &self,
        revision: Option<u64>,
    ) -> Result<(u64, Descriptor, ScreenSnapshot), RpcError> {
        let state = self.state.lock().map_err(lock_error)?;
        let (state, _) = self
            .changed
            .wait_timeout_while(state, Duration::from_secs(1), |state| {
                state.completion.is_none() && revision == Some(state.revision)
            })
            .map_err(lock_error)?;
        let screen = state
            .screen
            .as_ref()
            .ok_or_else(|| RpcError::new("process.notTerminal", "process has no PTY"))?;
        Ok((
            state.revision,
            self.describe(&state),
            screen.snapshot(state.output.latest_seq()),
        ))
    }

    pub fn inspect(&self) -> Result<ScreenSnapshot, RpcError> {
        let state = self.state.lock().map_err(lock_error)?;
        let screen = state
            .screen
            .as_ref()
            .ok_or_else(|| RpcError::new("process.notTerminal", "process has no PTY"))?;
        Ok(screen.snapshot(state.output.latest_seq()))
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), RpcError> {
        let mut state = self.state.lock().map_err(lock_error)?;
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
