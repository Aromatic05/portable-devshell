use std::os::unix::process::CommandExt;
use std::process::Command;

use nix::errno::Errno;
use nix::sys::signal::{Signal, kill};
use nix::unistd::{Pid, setsid};

pub fn process_is_running(pid: u32) -> bool {
    match kill(Pid::from_raw(pid as i32), None) {
        Ok(()) | Err(Errno::EPERM) => {
            // kill(pid, 0) also succeeds for zombies. In particular, a start
            // CLI waiting for Reverse Ready can still be the exited daemon's
            // parent, so waiting for that CLI to reap it would deadlock stop.
            #[cfg(target_os = "linux")]
            if let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) {
                return !proc_stat_has_exited(&stat);
            }
            #[cfg(target_os = "macos")]
            if let Some(exited) = macos_process_has_exited(pid) {
                return !exited;
            }
            // An unreadable process state is not evidence of termination.
            true
        }
        Err(_) => false,
    }
}

#[cfg(target_os = "macos")]
fn macos_process_has_exited(pid: u32) -> Option<bool> {
    use nix::libc;

    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of_val(&info) as libc::c_int;
    // XNU requires a nonzero arg to include zombies for PROC_PIDTBSDINFO.
    // Unlike waitid, this also works in a separate stop CLI, which is not the
    // daemon's parent. Never reap another caller's child to test liveness.
    let count = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDTBSDINFO,
            1,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    };
    (count == size && info.pbi_pid == pid).then_some(info.pbi_status == libc::SZOMB)
}

#[cfg(target_os = "linux")]
fn proc_stat_has_exited(stat: &str) -> bool {
    // comm is parenthesized and can itself contain spaces and parentheses.
    matches!(
        stat.rsplit_once(") ")
            .and_then(|(_, rest)| rest.as_bytes().first()),
        Some(b'Z' | b'X')
    )
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
        #[cfg(target_os = "macos")]
        Err(Errno::EPERM) if group_contains_only_exited_child(pid) => Ok(()),
        Err(error) => Err(format!(
            "failed to terminate process group {pid} with {signal:?}: {error}"
        )),
    }
}

#[cfg(target_os = "macos")]
fn group_contains_only_exited_child(pid: i32) -> bool {
    use nix::libc;

    // XNU killpg1 filters SZOMB and returns EPERM when no target is found.
    // EPERM also means permission denied for live members: only accept the
    // narrowly proven case of our unreaped child being the group's sole member.
    // The caller must keep that child unreaped throughout this check.
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    loop {
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                pid as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if result == 0 {
            break;
        }
        if std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
            return false;
        }
    }
    if unsafe { info.si_pid() } != pid {
        return false;
    }

    // libproc includes zombies and returns a PID count here. Two slots suffice:
    // a full/truncated list, an empty list or a query failure must all fail closed.
    let mut members = [0 as libc::pid_t; 2];
    let count = unsafe {
        libc::proc_listpgrppids(
            pid,
            members.as_mut_ptr().cast(),
            std::mem::size_of_val(&members) as libc::c_int,
        )
    };
    count == 1 && members[0] == pid
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

    #[cfg(target_os = "linux")]
    #[test]
    fn process_state_handles_parentheses_and_preserves_live_or_unknown_states() {
        assert!(super::proc_stat_has_exited(
            "123 (worker (with ) spaces)) Z 1 2 3"
        ));
        assert!(super::proc_stat_has_exited("123 (worker) X 1 2 3"));
        for state in ["R", "S", "D", "T", "t", "I", ""] {
            assert!(!super::proc_stat_has_exited(&format!(
                "123 (worker) {state} 1 2 3"
            )));
        }
        assert!(!super::proc_stat_has_exited("unreadable"));
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn terminated_unreaped_child_is_stopped_before_parent_waits() {
        use nix::libc;
        use nix::sys::signal::kill;

        for force in [false, true] {
            let mut child = Command::new("/bin/sleep").arg("60").spawn().unwrap();
            let pid = child.id();
            assert!(super::process_is_running(pid));
            super::terminate_process(pid, force).unwrap();

            // Observe exit without reaping, matching a daemon whose start CLI
            // still waits for Ready while a separate stop CLI waits for exit.
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            loop {
                let result = unsafe {
                    libc::waitid(
                        libc::P_PID,
                        pid as libc::id_t,
                        &mut info,
                        libc::WEXITED | libc::WNOWAIT,
                    )
                };
                if result == 0 {
                    break;
                }
                assert_eq!(
                    std::io::Error::last_os_error().kind(),
                    std::io::ErrorKind::Interrupted
                );
            }
            assert_eq!(unsafe { info.si_pid() }, pid as i32);
            assert!(kill(Pid::from_raw(pid as i32), None).is_ok());
            assert!(!super::process_is_running(pid));
            assert!(!child.wait().unwrap().success());
            assert!(!super::process_is_running(pid));
        }
    }

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

    #[cfg(target_os = "macos")]
    #[test]
    fn live_process_group_is_not_an_exited_child_exception() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "exec sleep 60"]);
        configure_daemon_command(&mut command);
        let mut child = command.spawn().unwrap();
        let pid = child.id() as i32;

        assert!(!super::group_contains_only_exited_child(pid));
        super::terminate_process_group(pid, true).unwrap();
        assert!(!child.wait().unwrap().success());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn exited_leader_with_a_live_member_is_not_an_exited_child_exception() {
        use nix::libc;
        use std::io::{BufRead, BufReader, Read};
        use std::process::Stdio;

        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 5 & printf 'ready\\n'; exit 7"]);
        command.stdout(Stdio::piped());
        configure_daemon_command(&mut command);
        let mut child = command.spawn().unwrap();
        let pid = Pid::from_raw(child.id() as i32);
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let mut ready = String::new();
        output.read_line(&mut ready).unwrap();
        assert_eq!(ready, "ready\n");
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        assert_eq!(
            unsafe {
                libc::waitid(
                    libc::P_PID,
                    pid.as_raw() as libc::id_t,
                    &mut info,
                    libc::WEXITED | libc::WNOWAIT,
                )
            },
            0
        );
        assert_eq!(unsafe { info.si_pid() }, pid.as_raw());
        assert!(!super::group_contains_only_exited_child(pid.as_raw()));
        let started = std::time::Instant::now();
        super::terminate_process_group(pid.as_raw(), true).unwrap();
        assert_eq!(child.wait().unwrap().code(), Some(7));
        let mut remaining = String::new();
        output.read_to_string(&mut remaining).unwrap();
        assert!(remaining.is_empty());
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
    }
}
