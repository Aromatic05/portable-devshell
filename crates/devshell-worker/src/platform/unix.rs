use std::process::Command;

use nix::errno::Errno;
use nix::sys::signal::{Signal, kill};
use nix::unistd::Pid;

pub fn process_is_running(pid: u32) -> bool {
    match kill(Pid::from_raw(pid as i32), None) {
        Ok(()) => true,
        Err(Errno::EPERM) => true,
        Err(_) => false,
    }
}

pub fn terminate_process(pid: u32, force: bool) -> Result<(), String> {
    let signal = if force {
        Signal::SIGKILL
    } else {
        Signal::SIGTERM
    };
    match kill(Pid::from_raw(pid as i32), signal) {
        Ok(()) => Ok(()),
        Err(Errno::ESRCH) => Ok(()),
        Err(error) => Err(format!(
            "failed to terminate process {pid} with {signal:?}: {error}"
        )),
    }
}

pub fn terminate_process_group(pid: i32, force: bool) -> Result<(), String> {
    let signal = if force {
        Signal::SIGKILL
    } else {
        Signal::SIGTERM
    };
    match kill(Pid::from_raw(-pid), signal) {
        Ok(()) => Ok(()),
        Err(Errno::ESRCH) => Ok(()),
        Err(error) => Err(format!(
            "failed to terminate process group {pid} with {signal:?}: {error}"
        )),
    }
}

pub fn configure_daemon_command(_command: &mut Command) {}
