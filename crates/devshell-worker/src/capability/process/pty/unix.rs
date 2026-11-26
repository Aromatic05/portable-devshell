use std::fs::{self, File};
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use nix::fcntl::{FcntlArg, FdFlag, fcntl};
use nix::libc;
use nix::pty::{Winsize, openpty};
use nix::sys::signal::{Signal, killpg};
use nix::unistd::{Pid, fchdir, setsid};

use crate::capability::rpc::error::RpcError;

use super::{SpawnedTerminal, TerminalChild};
use crate::capability::process::shell::ShellCommand;
use crate::instance::sandbox::path::ResolvedPath;

use crate::capability::process::child::{ExitLatch, reap, wait_until_exit};

static SHELL_STARTUP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub(in crate::capability::process) fn default_interactive_shell() -> String {
    if cfg!(test) {
        "/bin/sh".to_string()
    } else {
        std::env::var("SHELL")
            .ok()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "/bin/sh".to_string())
    }
}

pub(in crate::capability::process) fn spawn_interactive(
    cwd: &ResolvedPath,
    env: &std::collections::BTreeMap<String, Option<String>>,
    execution: Option<&crate::capability::execution::ExecutionConfig>,
    shell: Option<&str>,
    cols: u16,
    rows: u16,
) -> Result<SpawnedTerminal, RpcError> {
    let shell = shell
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(default_interactive_shell);
    let startup = if cfg!(test) {
        None
    } else {
        prepare_shell_startup(&shell)?
    };
    let startup = startup.map(StartupDirectory);
    let mut env = env.clone();
    if let Some(zdotdir) = startup.as_ref() {
        env.insert(
            "ZDOTDIR".into(),
            Some(zdotdir.0.to_string_lossy().into_owned()),
        );
    }
    let args = if cfg!(test) || !supports_login_flag(&shell) {
        Vec::new()
    } else {
        vec!["-l".into()]
    };
    let prepared =
        ShellCommand::prepare_program(PathBuf::from(&shell), args, &env, execution, true)?;
    let anchored = cwd
        .cloned_directory_file()
        .map_err(|error| RpcError::new("terminal.spawnFailed", error.to_string()))?;
    spawn_with(
        prepared.std_command(),
        cwd.access_path(),
        anchored,
        startup,
        true,
        cols,
        rows,
    )
}

/// Start the command itself as the controlling-terminal process, rather than
/// sending text into an interactive shell. Its exit status belongs to the task.
pub(in crate::capability::process) fn spawn_managed(
    command: &ShellCommand,
    cwd: &ResolvedPath,
    cols: u16,
    rows: u16,
) -> Result<SpawnedTerminal, RpcError> {
    let anchored = cwd
        .cloned_directory_file()
        .map_err(|error| RpcError::new("terminal.spawnFailed", error.to_string()))?;
    spawn_with(
        command.std_command(),
        cwd.access_path(),
        anchored,
        None,
        true,
        cols,
        rows,
    )
}

struct StartupDirectory(PathBuf);

impl Drop for StartupDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn spawn_with(
    mut command: Command,
    cwd: &Path,
    anchored: Option<File>,
    startup: Option<StartupDirectory>,
    managed: bool,
    cols: u16,
    rows: u16,
) -> Result<SpawnedTerminal, RpcError> {
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
    for fd in [&opened.master, &opened.slave] {
        fcntl(fd, FcntlArg::F_SETFD(FdFlag::FD_CLOEXEC))
            .map_err(|error| RpcError::new("terminal.spawnFailed", error.to_string()))?;
    }
    let stdin = opened
        .slave
        .try_clone()
        .map_err(|error| RpcError::new("terminal.spawnFailed", error.to_string()))?;
    let stdout = opened
        .slave
        .try_clone()
        .map_err(|error| RpcError::new("terminal.spawnFailed", error.to_string()))?;
    let stderr = opened
        .slave
        .try_clone()
        .map_err(|error| RpcError::new("terminal.spawnFailed", error.to_string()))?;
    let reader = opened
        .master
        .try_clone()
        .map_err(|error| RpcError::new("terminal.spawnFailed", error.to_string()))?;
    let writer = opened
        .master
        .try_clone()
        .map_err(|error| RpcError::new("terminal.spawnFailed", error.to_string()))?;
    let slave_fd = opened.slave.as_raw_fd();
    if anchored.is_none() {
        command.current_dir(cwd);
    }
    command
        .stdin(Stdio::from(stdin))
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    unsafe {
        command.pre_exec(move || {
            if let Some(directory) = &anchored {
                fchdir(directory).map_err(std::io::Error::other)?;
            }
            setsid().map_err(std::io::Error::other)?;
            #[cfg(target_os = "macos")]
            let tiocsctty = libc::TIOCSCTTY as libc::c_ulong;
            #[cfg(not(target_os = "macos"))]
            let tiocsctty = libc::TIOCSCTTY;
            if libc::ioctl(slave_fd, tiocsctty, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut process = command
        .spawn()
        .map_err(|error| RpcError::new("terminal.spawnFailed", error.to_string()))?;
    drop(opened.slave);
    let pid = Pid::from_raw(process.id() as i32);
    let exit = Arc::new(ExitLatch::default());
    let waiter_exit = Arc::clone(&exit);
    std::thread::spawn(move || {
        let observed = wait_until_exit(&mut process).map_err(|error| error.to_string());
        waiter_exit.finish(|| {
            // A managed command owns its process group, including descendants
            // that would otherwise retain the terminal after the shell exits.
            let cleanup = if observed.is_ok() && managed {
                crate::daemon::process::platform::terminate_process_group(pid.as_raw(), true)
            } else {
                Ok(())
            };
            let status = reap(&mut process);
            observed.and(cleanup).and(status)
        });
        drop(startup);
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

fn supports_login_flag(shell: &str) -> bool {
    Path::new(shell)
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            matches!(
                name,
                "sh" | "bash"
                    | "zsh"
                    | "fish"
                    | "dash"
                    | "ash"
                    | "ksh"
                    | "ksh93"
                    | "mksh"
                    | "csh"
                    | "tcsh"
                    | "nu"
                    | "pwsh"
            )
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
    exit: Arc<ExitLatch>,
    master: OwnedFd,
    pid: Pid,
}

impl TerminalChild for UnixTerminalChild {
    fn kill(&self) -> Result<(), String> {
        self.exit
            .while_running(|| match killpg(self.pid, Signal::SIGKILL) {
                Ok(()) => Ok(()),
                Err(nix::errno::Errno::ESRCH) => Ok(()),
                Err(error) => Err(error.to_string()),
            })
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
        Ok(())
    }

    fn wait(&self) -> Result<(i32, i32), String> {
        self.exit.wait()
    }
}
