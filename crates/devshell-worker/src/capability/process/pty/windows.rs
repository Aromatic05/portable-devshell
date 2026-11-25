use std::sync::{Arc, Mutex};

use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};

use crate::capability::rpc::error::RpcError;
use crate::daemon::process::platform::terminate_process_group;

use super::{SpawnedTerminal, TerminalChild};
use crate::capability::process::shell::ShellCommand;
use crate::instance::sandbox::path::ResolvedPath;

use crate::capability::process::child::ExitLatch;

pub(in crate::capability::process) fn spawn_interactive(
    cwd: &ResolvedPath,
    env: &std::collections::BTreeMap<String, Option<String>>,
    execution: Option<&crate::capability::execution::ExecutionConfig>,
    cols: u16,
    rows: u16,
) -> Result<SpawnedTerminal, RpcError> {
    let command = ShellCommand::prepare_program(
        "powershell.exe".into(),
        ["-NoLogo", "-NoProfile", "-NoExit"]
            .map(std::ffi::OsString::from)
            .to_vec(),
        env,
        execution,
        true,
    )?;
    spawn_managed(&command, cwd, cols, rows)
}

pub(in crate::capability::process) fn spawn_managed(
    command: &ShellCommand,
    cwd: &ResolvedPath,
    cols: u16,
    rows: u16,
) -> Result<SpawnedTerminal, RpcError> {
    let mut command = command.pty_command();
    command.cwd(cwd.access_path().as_os_str());
    spawn_with(command, cols, rows)
}

fn spawn_with(command: CommandBuilder, cols: u16, rows: u16) -> Result<SpawnedTerminal, RpcError> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(pty_size(cols, rows))
        .map_err(|error| RpcError::new("terminal.spawnFailed", error.to_string()))?;

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| RpcError::new("terminal.spawnFailed", error.to_string()))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| RpcError::new("terminal.spawnFailed", error.to_string()))?;
    let mut process = pair
        .slave
        .spawn_command(command)
        .map_err(|error| RpcError::new("terminal.spawnFailed", error.to_string()))?;
    let Some(pid) = process.process_id() else {
        let _ = process.kill();
        let _ = process.wait();
        return Err(RpcError::new(
            "terminal.spawnFailed",
            "ConPTY child process did not publish a process id.",
        ));
    };
    drop(pair.slave);

    let exit = Arc::new(ExitLatch::default());
    let waiter_exit = Arc::clone(&exit);
    std::thread::spawn(move || {
        let value = process
            .wait()
            .map(|status| (i32::try_from(status.exit_code()).unwrap_or(-1), 0))
            .map_err(|error| error.to_string());
        // Keep the process handle alive through publication of its exit.
        waiter_exit.finish(|| value);
    });

    Ok(SpawnedTerminal {
        child: Box::new(WindowsTerminalChild {
            exit,
            master: Mutex::new(Some(pair.master)),
            pid,
        }),
        reader,
        writer,
    })
}

struct WindowsTerminalChild {
    exit: Arc<ExitLatch>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    pid: u32,
}

impl TerminalChild for WindowsTerminalChild {
    fn kill(&self) -> Result<(), String> {
        self.exit.while_running(|| {
            let pid = i32::try_from(self.pid).map_err(|_| {
                format!(
                    "ConPTY child pid is outside the supported range: {}",
                    self.pid
                )
            })?;
            terminate_process_group(pid, true)
        })
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.master
            .lock()
            .map_err(|_| "terminal ConPTY lock poisoned".to_string())?
            .as_ref()
            .ok_or_else(|| "terminal has exited".to_string())?
            .resize(pty_size(cols, rows))
            .map_err(|error| error.to_string())
    }

    fn wait(&self) -> Result<(i32, i32), String> {
        let exit = self.exit.wait();
        // Close the pseudoconsole after child exit while the reader still
        // drains its output; keeping it alive can prevent pipe EOF.
        self.master
            .lock()
            .map_err(|_| "terminal ConPTY lock poisoned".to_string())?
            .take();
        exit
    }
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        cols,
        rows,
        pixel_width: 0,
        pixel_height: 0,
    }
}
