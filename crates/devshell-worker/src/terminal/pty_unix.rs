use std::fs::{self, File};
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};

use nix::libc;
use nix::pty::{Winsize, openpty};
use nix::sys::signal::{Signal, killpg};
use nix::unistd::{Pid, dup, setsid};

use crate::rpc::error::RpcError;

use super::{SpawnedTerminal, TerminalChild};

type ExitState = Arc<(Mutex<Option<(i32, i32)>>, Condvar)>;

static SHELL_STARTUP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub fn spawn(cwd: &Path, cols: u16, rows: u16) -> Result<SpawnedTerminal, RpcError> {
    let opened = openpty(
        Some(&Winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        }),
        None,
    )
    .map_err(|error| RpcError::new("terminal.spawnFailed", error.to_string()))?;
    let stdin = dup(&opened.slave)
        .map_err(|error| RpcError::new("terminal.spawnFailed", error.to_string()))?;
    let stdout = dup(&opened.slave)
        .map_err(|error| RpcError::new("terminal.spawnFailed", error.to_string()))?;
    let stderr = dup(&opened.slave)
        .map_err(|error| RpcError::new("terminal.spawnFailed", error.to_string()))?;
    let reader = dup(&opened.master)
        .map_err(|error| RpcError::new("terminal.spawnFailed", error.to_string()))?;
    let writer = dup(&opened.master)
        .map_err(|error| RpcError::new("terminal.spawnFailed", error.to_string()))?;
    let slave_fd = opened.slave.as_raw_fd();
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "/bin/sh".to_string());
    let startup = prepare_shell_startup(&shell)?;
    let mut command = Command::new(&shell);
    command
        .arg("-l")
        .current_dir(cwd)
        .stdin(Stdio::from(stdin))
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    if let Some(zdotdir) = startup.as_ref() {
        command.env("ZDOTDIR", zdotdir);
    }
    unsafe {
        command.pre_exec(move || {
            setsid().map_err(std::io::Error::other)?;
            if libc::ioctl(slave_fd, libc::TIOCSCTTY, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut process = match command.spawn() {
        Ok(process) => process,
        Err(error) => {
            if let Some(startup) = startup.as_ref() {
                let _ = fs::remove_dir_all(startup);
            }
            return Err(RpcError::new("terminal.spawnFailed", error.to_string()));
        }
    };
    drop(opened.slave);
    let pid = Pid::from_raw(process.id() as i32);
    let exit: ExitState = Arc::new((Mutex::new(None), Condvar::new()));
    let waiter_exit = Arc::clone(&exit);
    std::thread::spawn(move || {
        let status = process.wait();
        let value = status
            .map(|status| (status.code().unwrap_or(-1), status.signal().unwrap_or(0)))
            .unwrap_or((-1, 0));
        if let Some(startup) = startup {
            let _ = fs::remove_dir_all(startup);
        }
        let (lock, ready) = &*waiter_exit;
        if let Ok(mut current) = lock.lock() {
            *current = Some(value);
            ready.notify_all();
        }
    });

    Ok(SpawnedTerminal {
        child: Box::new(UnixTerminalChild {
            exit,
            master: opened.master,
            pid,
        }),
        reader: Box::new(File::from(reader)),
        writer: Box::new(File::from(writer)),
    })
}

fn prepare_shell_startup(shell: &str) -> Result<Option<PathBuf>, RpcError> {
    let is_zsh = Path::new(shell)
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == "zsh");
    if !is_zsh || std::env::var_os("ZDOTDIR").is_some_and(|value| !value.is_empty()) {
        return Ok(None);
    }

    let sequence = SHELL_STARTUP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let directory = std::env::temp_dir().join(format!(
        "portable-devshell-zsh-{}-{sequence}",
        std::process::id(),
    ));
    fs::create_dir(&directory)
        .map_err(|error| RpcError::new("terminal.spawnFailed", error.to_string()))?;
    if let Err(error) = fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)) {
        let _ = fs::remove_dir_all(&directory);
        return Err(RpcError::new("terminal.spawnFailed", error.to_string()));
    }
    let startup_files = [".zshenv", ".zprofile", ".zshrc", ".zlogin", ".zlogout"];
    for file in startup_files {
        let contents =
            format!("if [ -r \"$HOME/{file}\" ]; then\n  source \"$HOME/{file}\"\nfi\n",);
        if let Err(error) = fs::write(directory.join(file), contents) {
            let _ = fs::remove_dir_all(&directory);
            return Err(RpcError::new("terminal.spawnFailed", error.to_string()));
        }
    }
    Ok(Some(directory))
}

struct UnixTerminalChild {
    exit: ExitState,
    master: OwnedFd,
    pid: Pid,
}

impl TerminalChild for UnixTerminalChild {
    fn kill(&self) -> Result<(), String> {
        match killpg(self.pid, Signal::SIGKILL) {
            Ok(()) => Ok(()),
            Err(nix::errno::Errno::ESRCH) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let size = libc::winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        let result = unsafe { libc::ioctl(self.master.as_raw_fd(), libc::TIOCSWINSZ, &size) };
        if result < 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let _ = killpg(self.pid, Signal::SIGWINCH);
        Ok(())
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
