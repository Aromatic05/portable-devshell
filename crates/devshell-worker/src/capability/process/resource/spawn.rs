use super::super::child::{ExitLatch, reap, wait_until_exit};
use super::super::output::{Captures, OutputChannel, OutputJournal, READ_CHUNK};
use super::super::pty::spawn_managed;
use super::super::screen::TerminalScreen;
use super::super::shell::ShellCommand;
use super::managed::{Control, Exit, ManagedProcess, Reader, SpawnSpec, State, Writer};
use crate::capability::rpc::error::RpcError;
use std::io::{Read, Write};
use std::sync::{Arc, Condvar, Mutex, mpsc};
use std::time::Duration;

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
                controller: None,
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
                                if state.controller.is_none() && !replies.is_empty() {
                                    process.enqueue(&replies).map_err(|error| error.message)?;
                                }
                                state.captures.append(channel, &bytes[..n]);
                                state.output.append(channel, &bytes[..n]);
                                state.revision += 1;
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
}
