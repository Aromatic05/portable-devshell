use super::super::child::{ExitLatch, reap, wait_until_exit};
use super::super::output::{Captures, OutputChannel, OutputJournal, READ_CHUNK};
use super::super::pty::{default_interactive_shell, spawn_interactive, spawn_managed};
use super::super::screen::TerminalScreen;
use super::super::shell::ShellCommand;
use super::managed::{
    Control, Exit, ManagedProcess, ProcessFailure, Reader, SpawnSpec, State, Writer,
};
use crate::capability::execution::ExecutionConfig;
use crate::capability::rpc::error::RpcError;
use crate::instance::sandbox::path::ResolvedPath;
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, mpsc};
use std::time::{Duration, Instant};

const RAPID_EXIT_WINDOW: Duration = Duration::from_secs(1);
const MAX_RAPID_RESPAWN_EXITS: u32 = 5;
const RESPAWN_RESET_BANNER: &[u8] = b"\x1b[?1049l\x1b[0m\r\n[shell restarted]\r\n";

struct RespawnConfig {
    cwd: ResolvedPath,
    env: BTreeMap<String, Option<String>>,
    execution: Option<ExecutionConfig>,
    shell: Option<String>,
}

impl ManagedProcess {
    pub fn spawn(id: String, spec: SpawnSpec<'_>) -> Result<Arc<Self>, RpcError> {
        let captures = Captures::new(spec.capture_root, Arc::clone(&spec.capture_budget))
            .map_err(|error| RpcError::new("process.captureFailed", error.to_string()))?;
        let screen = spec
            .dimensions
            .map(|(cols, rows)| TerminalScreen::new(cols, rows))
            .transpose()?;
        let shell_override = (spec.interactive && !spec.command.trim().is_empty())
            .then(|| spec.command.trim().to_string());
        let (control, writer, outputs): (Control, Writer, Vec<(OutputChannel, Reader)>) =
            if let Some((cols, rows)) = spec.dimensions {
                let terminal = if spec.interactive {
                    spawn_interactive(
                        spec.cwd,
                        spec.env,
                        spec.execution,
                        shell_override.as_deref(),
                        cols,
                        rows,
                    )?
                } else {
                    let prepared = ShellCommand::prepare(
                        spec.shell,
                        spec.command,
                        spec.env,
                        spec.execution,
                        true,
                    )?;
                    spawn_managed(&prepared, spec.cwd, cols, rows)?
                };
                (
                    Control::Pty(terminal.child),
                    terminal.writer,
                    vec![(OutputChannel::Terminal, terminal.reader)],
                )
            } else {
                let mut child = super::super::pipe::spawn_shell(
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
        let command_summary = if spec.interactive {
            Some(
                shell_override
                    .clone()
                    .unwrap_or_else(default_interactive_shell),
            )
        } else {
            shorten_command(spec.command)
        };
        let cwd_display = Some(spec.cwd.canonical.to_string_lossy().into_owned());
        let respawn_config = if spec.persistent {
            Some(RespawnConfig {
                cwd: spec.cwd.clone(),
                env: spec.env.clone(),
                execution: spec.execution.cloned(),
                shell: shell_override,
            })
        } else {
            None
        };
        let initial_control = Arc::new(control);
        let process = Arc::new(Self {
            id,
            tty,
            interactive: spec.interactive,
            persistent: spec.persistent,
            name: spec.name,
            cwd: cwd_display,
            command: command_summary,
            closed: AtomicBool::new(false),
            control: Mutex::new(Arc::clone(&initial_control)),
            workspace: spec.workspace,
            provenance: (!spec.interactive && spec.command.len() <= 16 * 1024)
                .then(|| (spec.command.to_owned(), spec.cwd.canonical.clone())),
            timed_out: AtomicBool::new(false),
            state: Mutex::new(State {
                screen,
                captures,
                output: OutputJournal::default(),
                version: 1,
                created_at_ms: crate::tool::unix_time_millis(),
                shell_generation: 0,
                input: if keep_stdin { Some(input_tx) } else { None },
                controller: None,
                control_seq: 0,
                completion: None,
            }),
            changed: Condvar::new(),
        });
        spawn_writer_thread(writer, input_rx);
        let readers: Vec<_> = outputs
            .into_iter()
            .map(|(channel, reader)| spawn_reader_thread(Arc::clone(&process), 0, channel, reader))
            .collect();

        let observed = Arc::clone(&process);
        std::thread::spawn(move || {
            let mut current_control = initial_control;
            let mut current_readers = readers;
            let mut spawned_at = Instant::now();
            let mut rapid_exits: u32 = 0;
            loop {
                let exit = current_control
                    .wait()
                    .map(|(exit_code, signal)| Exit { exit_code, signal })
                    .map_err(ProcessFailure::io);
                let will_respawn = observed.persistent
                    && respawn_config.is_some()
                    && !observed.closed.load(Ordering::Acquire);
                // If respawning, install a fresh input channel immediately so
                // the old writer thread exits cleanly while concurrent writes
                // buffer for the new shell instead of failing with stdinClosed.
                let next_input = if will_respawn {
                    let (next_tx, next_rx) = mpsc::sync_channel::<Vec<u8>>(32);
                    let mut state = observed.state.lock().expect("process state lock poisoned");
                    // Publish the input sender and generation in the same
                    // critical section used by input validation and enqueue.
                    let generation = state.advance_shell(next_tx);
                    observed.changed.notify_all();
                    Some((generation, next_rx))
                } else {
                    observed.state.lock().expect("process state lock poisoned").input.take();
                    None
                };
                // Publish terminal status (or respawn) only after output streams have
                // drained, so the command's final bytes are never lost.
                let mut failure = None;
                for reader in current_readers {
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

                if will_respawn && !observed.closed.load(Ordering::Acquire) {
                    if spawned_at.elapsed() < RAPID_EXIT_WINDOW {
                        rapid_exits = rapid_exits.saturating_add(1);
                    } else {
                        rapid_exits = 0;
                    }
                    if rapid_exits >= MAX_RAPID_RESPAWN_EXITS {
                        let mut state = observed.state.lock().expect("process state lock poisoned");
                        state.input.take();
                        state.completion = Some(Err(ProcessFailure::task(
                            "persistent terminal shell exited repeatedly",
                        )));
                        state.version += 1;
                        observed.changed.notify_all();
                        return;
                    }
                    if rapid_exits > 0 {
                        let shift = (rapid_exits - 1).min(4);
                        let backoff = Duration::from_millis(100u64 << shift);
                        let state = observed.state.lock().expect("process state lock poisoned");
                        let _ = observed.changed.wait_timeout_while(state, backoff, |_| {
                            !observed.closed.load(Ordering::Acquire)
                        });
                    }
                    if !observed.closed.load(Ordering::Acquire)
                        && let Some(config) = respawn_config.as_ref()
                    {
                        let (cols, rows) = observed
                            .state
                            .lock()
                            .ok()
                            .and_then(|state| state.screen.as_ref().map(|screen| screen.size()))
                            .unwrap_or((120, 36));
                        match spawn_interactive(
                            &config.cwd,
                            &config.env,
                            config.execution.as_ref(),
                            config.shell.as_deref(),
                            cols,
                            rows,
                        ) {
                            Ok(terminal) => {
                                let new_control = Arc::new(Control::Pty(terminal.child));
                                // Preserve state -> control lock order used by resize/kill.
                                let closed_during_spawn = {
                                    let mut state = observed
                                        .state
                                        .lock()
                                        .expect("process state lock poisoned");
                                    let mut control_guard = observed
                                        .control
                                        .lock()
                                        .expect("process control lock poisoned");
                                    if observed.closed.load(Ordering::Acquire) {
                                        true
                                    } else {
                                        if let Some(screen) = state.screen.as_ref() {
                                            let (current_cols, current_rows) = screen.size();
                                            if (current_cols, current_rows) != (cols, rows) {
                                                let _ =
                                                    new_control.resize(current_cols, current_rows);
                                            }
                                        }
                                        if let Some(screen) = state.screen.as_mut() {
                                            let _ = screen.process(RESPAWN_RESET_BANNER);
                                        }
                                        state
                                            .captures
                                            .append(OutputChannel::Terminal, RESPAWN_RESET_BANNER);
                                        state
                                            .output
                                            .append(OutputChannel::Terminal, RESPAWN_RESET_BANNER);
                                        *control_guard = Arc::clone(&new_control);
                                        observed.changed.notify_all();
                                        false
                                    }
                                };
                                if closed_during_spawn {
                                    observed.state.lock().expect("process state lock poisoned").input.take();
                                    let _ = new_control.kill();
                                    let _ = new_control.wait();
                                    drop(terminal.writer);
                                    drop(terminal.reader);
                                    let mut state = observed
                                        .state
                                        .lock()
                                        .expect("process state lock poisoned");
                                    state.completion = Some(match failure {
                                        Some(error) => Err(ProcessFailure::io(error)),
                                        None => exit,
                                    });
                                    state.version += 1;
                                    observed.changed.notify_all();
                                    return;
                                }
                                let (generation, input_rx) = next_input.expect("respawn input queue");
                                spawn_writer_thread(terminal.writer, input_rx);
                                current_readers = vec![spawn_reader_thread(
                                    Arc::clone(&observed),
                                    generation,
                                    OutputChannel::Terminal,
                                    terminal.reader,
                                )];
                                current_control = new_control;
                                spawned_at = Instant::now();
                                continue;
                            }
                            Err(error) => {
                                observed.state.lock().expect("process state lock poisoned").input.take();
                                let mut state = observed
                                    .state
                                    .lock()
                                    .expect("process state lock poisoned");
                                state.completion = Some(Err(ProcessFailure::io(error.message)));
                                state.version += 1;
                                observed.changed.notify_all();
                                return;
                            }
                        }
                    }
                }

                let mut state = observed.state.lock().expect("process state lock poisoned");
                state.input.take();
                state.completion = Some(match failure {
                    Some(error) => Err(ProcessFailure::io(error)),
                    None => exit,
                });
                state.version += 1;
                observed.changed.notify_all();
                return;
            }
        });

        if let Some(timeout_ms) = spec.timeout_ms {
            let target = Arc::downgrade(&process);
            std::thread::spawn(move || {
                if let Some(target) = target.upgrade() {
                    if target
                        .wait_done(Duration::from_millis(timeout_ms))
                        .is_ok_and(|done| !done)
                    {
                        target.timed_out.store(true, Ordering::Release);
                        let _ = target.kill();
                    }
                }
            });
        }
        Ok(process)
    }
}

fn spawn_writer_thread(mut writer: Writer, input_rx: mpsc::Receiver<Vec<u8>>) {
    std::thread::spawn(move || {
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
}

impl State {
    fn advance_shell(&mut self, input: mpsc::SyncSender<Vec<u8>>) -> u64 {
        self.shell_generation += 1;
        self.input = Some(input);
        self.version += 1;
        self.shell_generation
    }

    fn record_output(&mut self, generation: u64, channel: OutputChannel, bytes: &[u8]) {
        let replies = self.screen.as_mut().map_or_else(Vec::new, |screen| screen.process(bytes));
        // An old reader may drain after a fresh queue was published. Its
        // bytes remain in the transcript, but its replies belong to the old shell.
        if generation == self.shell_generation && self.active_controller().is_none()
            && !replies.is_empty() && let Some(input) = &self.input
        {
            let _ = input.try_send(replies);
        }
        self.captures.append(channel, bytes);
        self.output.append(channel, bytes);
    }
}

fn spawn_reader_thread(
    process: Arc<ManagedProcess>,
    generation: u64,
    channel: OutputChannel,
    mut reader: Reader,
) -> std::thread::JoinHandle<Result<(), String>> {
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
                    state.record_output(generation, channel, &bytes[..n]);
                    process.changed.notify_all();
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {
                    continue;
                }
                // Linux PTYs return EIO once their last slave closes.
                #[cfg(unix)]
                Err(error) if process.tty && error.raw_os_error() == Some(nix::libc::EIO) => {
                    return Ok(());
                }
                Err(error) => return Err(error.to_string()),
            }
        }
    })
}

fn shorten_command(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    const MAX_CHARS: usize = 256;
    if trimmed.chars().count() <= MAX_CHARS {
        return Some(trimmed.to_string());
    }
    let prefix: String = trimmed.chars().take(MAX_CHARS - 3).collect();
    Some(format!("{prefix}..."))
}

#[cfg(test)]
mod generation_tests {
    use super::*;
    use crate::capability::process::output::CaptureBudget;

    #[test]
    fn old_reader_drains_output_without_replies_crossing_shell_generation() {
        let root = crate::testing::temp_dir();
        let (old_tx, old_rx) = mpsc::sync_channel(32);
        let (new_tx, new_rx) = mpsc::sync_channel(32);
        let mut state = State {
            output: OutputJournal::default(),
            captures: Captures::new(root.path(), Arc::new(CaptureBudget::default())).unwrap(),
            screen: Some(TerminalScreen::new(80, 24).unwrap()),
            controller: None,
            control_seq: 0,
            version: 1,
            created_at_ms: 0,
            shell_generation: 0,
            input: Some(old_tx),
            completion: None,
        };
        assert_eq!(state.advance_shell(new_tx), 1);
        assert!(matches!(old_rx.try_recv(), Err(mpsc::TryRecvError::Disconnected)));
        let query = b"\x1b[5n";
        state.record_output(0, OutputChannel::Terminal, query);
        assert!(matches!(new_rx.try_recv(), Err(mpsc::TryRecvError::Empty)));
        assert_eq!(state.captures.snapshot().stdout.source_bytes, query.len());
        state.record_output(1, OutputChannel::Terminal, query);
        assert_eq!(new_rx.try_recv().unwrap(), b"\x1b[0n");
        assert_eq!(state.captures.snapshot().stdout.source_bytes, query.len() * 2);
    }
}
