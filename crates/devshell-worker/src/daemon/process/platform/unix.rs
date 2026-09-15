use std::os::unix::process::CommandExt;
use std::process::Command;

use nix::errno::Errno;
use nix::sys::signal::{Signal, kill};
use nix::unistd::{Pid, setsid};

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

pub fn configure_daemon_command(command: &mut Command) {
    unsafe {
        command.pre_exec(|| {
            setsid().map_err(std::io::Error::other)?;
            Ok(())
        });
    }
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    use nix::unistd::{Pid, getsid};

    use super::configure_daemon_command;

    #[test]
    fn daemon_command_starts_in_a_new_session() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 5"]);
        configure_daemon_command(&mut command);

        let mut child = command.spawn().unwrap();
        let pid = Pid::from_raw(child.id() as i32);
        assert_eq!(getsid(Some(pid)).unwrap(), pid);
        child.kill().unwrap();
        child.wait().unwrap();
    }
}
