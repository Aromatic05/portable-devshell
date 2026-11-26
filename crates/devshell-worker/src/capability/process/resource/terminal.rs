//! The public terminal protocol is an identity/version view of a PTY resource.
use serde_json::{Value, json};

use super::managed::{ManagedProcess, State, lock_error};
use crate::capability::rpc::error::RpcError;
use crate::capability::terminal::{
    TerminalAttachInput, TerminalAttachResult, TerminalCommandInput, TerminalDescriptor,
    TerminalExit, TerminalOutputFrame, TerminalRestore,
};

impl ManagedProcess {
    pub(super) fn terminal_descriptor(&self, state: &State) -> Option<TerminalDescriptor> {
        let (cols, rows, pty, human_control) = if self.tty {
            let (cols, rows) = state.screen.as_ref()?.size();
            (cols, rows, true, state.active_controller().is_some())
        } else {
            (0, 0, false, false)
        };
        Some(TerminalDescriptor {
            terminal_id: self.id.clone(),
            generation: 1, // A globally unique process ID is never recycled.
            version: state.version,
            cols,
            rows,
            latest_seq: state.output.latest_seq(),
            state: if state.completion.is_none() {
                "running"
            } else {
                "exited"
            }
            .into(),
            created_at_ms: state.created_at_ms,
            name: self.name.clone(),
            cwd: self.cwd.clone(),
            workspace: self
                .workspace
                .as_ref()
                .map(|path| path.display().to_string()),
            command: self.command.clone(),
            persistent: self.persistent,
            pty,
            human_control,
        })
    }

    pub fn terminal_attach(
        &self,
        input: TerminalAttachInput,
    ) -> Result<TerminalAttachResult, RpcError> {
        let state = self.state.lock().map_err(lock_error)?;
        let session = self.terminal_descriptor(&state).ok_or_else(not_terminal)?;
        if input.generation != session.generation {
            return Err(conflict("Terminal generation changed."));
        }
        let snapshot = if input.restore && self.tty {
            let screen = state
                .screen
                .as_ref()
                .ok_or_else(not_terminal)?
                .snapshot(state.output.latest_seq());
            Some(TerminalRestore {
                seq: screen.seq,
                data: screen.restore,
            })
        } else {
            None
        };
        let mut output = state.output.replay_after(
            snapshot
                .as_ref()
                .map_or(input.from_seq, |screen| screen.seq),
        );
        if output.gap && !self.tty && input.restore {
            output = state
                .output
                .replay_after(output.oldest_seq.saturating_sub(1));
        }
        if output.gap {
            return Err(RpcError::new(
                "stream.gap",
                "Requested terminal output is no longer retained.",
            )
            .with_details(json!({
                "requestedFromSeq": input.from_seq,
                "oldestAvailableSeq": output.oldest_seq,
                "latestSeq": output.latest_seq,
            })));
        }
        let exit = state.completion.as_ref().map(|result| match result {
            Ok(exit) => TerminalExit {
                exit_code: exit.exit_code,
                signal: exit.signal,
            },
            Err(_) => TerminalExit {
                exit_code: -1,
                signal: 0,
            },
        });
        Ok(TerminalAttachResult {
            session,
            snapshot,
            replay: output
                .frames
                .into_iter()
                .map(|frame| TerminalOutputFrame {
                    seq: frame.seq,
                    data_base64: frame.data_base64,
                })
                .collect(),
            exit,
        })
    }

    fn validate_terminal(
        &self,
        state: &State,
        input: &TerminalCommandInput,
    ) -> Result<(), RpcError> {
        let descriptor = self.terminal_descriptor(state).ok_or_else(not_terminal)?;
        if input.generation != descriptor.generation || input.version != descriptor.version {
            return Err(conflict("Terminal generation or version changed."));
        }
        if state.completion.is_some() {
            return Err(conflict("Terminal has exited."));
        }
        Self::authorize_controller(state, input.controller.as_deref())
    }

    pub fn terminal_write(
        &self,
        input: TerminalCommandInput,
        data: &[u8],
    ) -> Result<Value, RpcError> {
        if !self.tty {
            return Err(not_terminal());
        }
        let state = self.state.lock().map_err(lock_error)?;
        self.validate_terminal(&state, &input)?;
        self.enqueue(data)?;
        Ok(accepted(&input, state.version))
    }

    pub fn terminal_resize(
        &self,
        input: TerminalCommandInput,
        cols: u16,
        rows: u16,
    ) -> Result<Value, RpcError> {
        if !self.tty {
            return Err(not_terminal());
        }
        let mut state = self.state.lock().map_err(lock_error)?;
        self.validate_terminal(&state, &input)?;
        let control = self.control.lock().map_err(lock_error)?.clone();
        control
            .resize(cols, rows)
            .map_err(|error| RpcError::new("terminal.resizeFailed", error))?;
        state
            .screen
            .as_mut()
            .ok_or_else(not_terminal)?
            .resize(cols, rows)?;
        Self::mark_controller_resized(&mut state, input.controller.as_deref());
        state.version += 1;
        Ok(accepted(&input, state.version))
    }

    pub fn terminal_kill(
        &self,
        input: TerminalCommandInput,
    ) -> Result<TerminalDescriptor, RpcError> {
        let state = self.state.lock().map_err(lock_error)?;
        self.validate_terminal(&state, &input)?;
        self.closed
            .store(true, std::sync::atomic::Ordering::Release);
        self.changed.notify_all();
        let control = self.control.lock().map_err(lock_error)?.clone();
        control
            .kill()
            .map_err(|error| RpcError::new("terminal.killFailed", error))?;
        self.terminal_descriptor(&state).ok_or_else(not_terminal)
    }
}

fn accepted(input: &TerminalCommandInput, version: u64) -> Value {
    json!({
        "terminalId": input.terminal_id, "generation": input.generation,
        "version": version, "clientSeq": input.client_seq, "accepted": true
    })
}

fn not_terminal() -> RpcError {
    RpcError::new("process.notTerminal", "process has no PTY")
}

fn conflict(message: &str) -> RpcError {
    RpcError::new("instance.conflict", message)
}
