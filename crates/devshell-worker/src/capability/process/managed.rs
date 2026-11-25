use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde::Serialize;

use crate::capability::execution::ExecutionConfig;
use crate::capability::rpc::error::RpcError;
use crate::instance::sandbox::path::ResolvedPath;

use super::child::{ExitLatch, reap, wait_until_exit};
use super::output::{OutputChannel, OutputJournal, OutputPage, READ_CHUNK};
use super::pty::{TerminalChild, spawn_managed};
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

#[derive(Default)]
struct State {
    output: OutputJournal,
    completion: Option<Result<Exit, String>>,
}

pub(super) struct ManagedProcess {
    id: String,
    tty: bool,
    control: Control,
    writer: Mutex<Option<Writer>>,
    state: Mutex<State>,
    changed: Condvar,
}

impl ManagedProcess {
    pub fn spawn(id: String, spec: SpawnSpec<'_>) -> Result<Arc<Self>, RpcError> {
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
        let process = Arc::new(Self {
            id,
            tty,
            control,
            writer: Mutex::new(Some(writer)),
            state: Mutex::new(State::default()),
            changed: Condvar::new(),
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
                                state.output.append(channel, &bytes[..n]);
                                process.changed.notify_all();
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
            if let Ok(mut writer) = observed.writer.lock() {
                writer.take();
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
            observed.changed.notify_all();
        });

        // The caller can read and kill while the initial stdin is being
        // delivered. For an ordinary pipe command, omission delivers EOF.
        let keep_stdin = spec.keep_stdin;
        if let Some(stdin) = spec.stdin {
            let target = Arc::clone(&process);
            let (ready, started) = std::sync::mpsc::sync_channel(0);
            std::thread::spawn(move || {
                let mut writer = target.writer.lock().expect("process stdin lock poisoned");
                let _ = ready.send(());
                if let Some(writer) = writer.as_mut() {
                    let _ = writer
                        .write_all(stdin.as_bytes())
                        .and_then(|_| writer.flush());
                }
                if !tty && !keep_stdin {
                    writer.take();
                }
            });
            started
                .recv()
                .map_err(|error| RpcError::new("process.ioFailed", error.to_string()))?;
        } else if !tty && !keep_stdin {
            process.writer.lock().map_err(lock_error)?.take();
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

    pub fn wait_done(&self, timeout: Duration) -> Result<bool, RpcError> {
        let state = self.state.lock().map_err(lock_error)?;
        let (state, _) = self
            .changed
            .wait_timeout_while(state, timeout, |state| state.completion.is_none())
            .map_err(lock_error)?;
        Ok(state.completion.is_some())
    }

    pub fn input(&self, data: &[u8]) -> Result<(), RpcError> {
        let mut writer = self.writer.lock().map_err(lock_error)?;
        let writer = writer
            .as_mut()
            .ok_or_else(|| RpcError::new("process.stdinClosed", "stdin is closed"))?;
        writer
            .write_all(data)
            .and_then(|_| writer.flush())
            .map_err(io_error)
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), RpcError> {
        self.control
            .resize(cols, rows)
            .map_err(|error| RpcError::new("process.resizeFailed", error))
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

fn io_error(error: std::io::Error) -> RpcError {
    RpcError::new("process.ioFailed", error.to_string())
}
