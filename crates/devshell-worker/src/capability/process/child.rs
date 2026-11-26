use std::process::Child;
use std::sync::{Condvar, Mutex};

type ExitResult = Result<(i32, i32), String>;

/// Synchronizes final reaping with process control. Once an exit has been
/// published, no caller may signal the old process identity.
#[derive(Default)]
pub(super) struct ExitLatch {
    exit: Mutex<Option<ExitResult>>,
    ready: Condvar,
}

impl ExitLatch {
    pub fn finish(&self, reap: impl FnOnce() -> ExitResult) {
        let mut exit = self.exit.lock().expect("process exit lock poisoned");
        *exit = Some(reap());
        self.ready.notify_all();
    }

    pub fn while_running(&self, action: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
        let exit = self.exit.lock().map_err(|_| "process exit lock poisoned")?;
        if exit.is_some() {
            return Ok(());
        }
        action()
    }

    pub fn wait(&self) -> ExitResult {
        let exit = self.exit.lock().map_err(|_| "process exit lock poisoned")?;
        let exit = self
            .ready
            .wait_while(exit, |exit| exit.is_none())
            .map_err(|_| "process exit lock poisoned")?;
        exit.as_ref().expect("exit was published").clone()
    }
}

#[cfg(unix)]
fn observe_exit(child: &Child) -> std::io::Result<bool> {
    use nix::libc;

    // Keep the group leader unreaped until all group-directed cleanup is done.
    let options = libc::WEXITED | libc::WNOWAIT;
    loop {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let result =
            unsafe { libc::waitid(libc::P_PID, child.id() as libc::id_t, &mut info, options) };
        if result == 0 {
            return Ok(unsafe { info.si_pid() != 0 });
        }
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

pub(super) fn wait_until_exit(child: &mut Child) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        observe_exit(child).map(|_| ())
    }
    #[cfg(windows)]
    {
        child.wait().map(|_| ())
    }
}

pub(super) fn reap(child: &mut Child) -> ExitResult {
    let status = child.wait().map_err(|error| error.to_string())?;
    #[cfg(unix)]
    let signal = {
        use std::os::unix::process::ExitStatusExt;
        status.signal().unwrap_or(0)
    };
    #[cfg(windows)]
    let signal = 0;
    Ok((status.code().unwrap_or(-1), signal))
}
