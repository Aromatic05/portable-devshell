use std::path::Path;
use std::sync::{Arc, Condvar, Mutex};

use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};

use crate::platform::terminate_process_group;
use crate::rpc::error::RpcError;

use super::{SpawnedTerminal, TerminalChild};

type ExitState = Arc<(Mutex<Option<(i32, i32)>>, Condvar)>;

pub fn spawn(cwd: &Path, cols: u16, rows: u16) -> Result<SpawnedTerminal, RpcError> {
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

    let mut command = CommandBuilder::new_default_prog();
    command.cwd(cwd.as_os_str());
    command.env("TERM", "xterm-256color");
    let mut process = pair
        .slave
        .spawn_command(command)
        .map_err(|error| RpcError::new("terminal.spawnFailed", error.to_string()))?;
    let pid = process.process_id().ok_or_else(|| {
        RpcError::new(
            "terminal.spawnFailed",
            "ConPTY child process did not publish a process id.",
        )
    })?;
    drop(pair.slave);

    let exit: ExitState = Arc::new((Mutex::new(None), Condvar::new()));
    let waiter_exit = Arc::clone(&exit);
    std::thread::spawn(move || {
        let value = process
            .wait()
            .map(|status| (i32::try_from(status.exit_code()).unwrap_or(-1), 0))
            .unwrap_or((-1, 0));
        let (lock, ready) = &*waiter_exit;
        if let Ok(mut current) = lock.lock() {
            *current = Some(value);
            ready.notify_all();
        }
    });

    Ok(SpawnedTerminal {
        child: Box::new(WindowsTerminalChild {
            exit,
            master: Mutex::new(pair.master),
            pid,
        }),
        reader,
        writer,
    })
}

struct WindowsTerminalChild {
    exit: ExitState,
    master: Mutex<Box<dyn MasterPty + Send>>,
    pid: u32,
}

impl TerminalChild for WindowsTerminalChild {
    fn kill(&self) -> Result<(), String> {
        let pid = i32::try_from(self.pid).map_err(|_| {
            format!(
                "ConPTY child pid is outside the supported range: {}",
                self.pid
            )
        })?;
        terminate_process_group(pid, true)
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.master
            .lock()
            .map_err(|_| "terminal ConPTY lock poisoned".to_string())?
            .resize(pty_size(cols, rows))
            .map_err(|error| error.to_string())
    }

    fn wait(&self) -> Result<(i32, i32), String> {
        let (lock, ready) = &*self.exit;
        let mut current = lock
            .lock()
            .map_err(|_| "terminal exit lock poisoned".to_string())?;
        while current.is_none() {
            current = ready
                .wait(current)
                .map_err(|_| "terminal exit lock poisoned".to_string())?;
        }
        Ok(current.expect("terminal exit is present"))
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
