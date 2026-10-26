use std::collections::HashSet;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use crate::daemon::process::platform;
use crate::tool::{ToolProcessGuard, ToolProcessRegistry};

#[derive(Default)]
pub struct ActiveProcessRegistry {
    idle: Condvar,
    state: Mutex<ActiveProcessState>,
}

#[derive(Default)]
struct ActiveProcessState {
    process_groups: HashSet<i32>,
    stopping: bool,
}

impl ActiveProcessRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(self: &Arc<Self>, process_group: i32) -> Result<ActiveProcessGuard, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "active process registry lock poisoned".to_string())?;

        if state.stopping {
            drop(state);
            let _ = platform::terminate_process_group(process_group, true);
            return Err("worker is stopping and cannot accept a new process".to_string());
        }

        if !state.process_groups.insert(process_group) {
            return Err(format!(
                "process group {process_group} is already registered"
            ));
        }

        Ok(ActiveProcessGuard {
            process_group: Some(process_group),
            registry: Arc::clone(self),
        })
    }

    pub fn stop_all(&self, timeout: Duration) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "active process registry lock poisoned".to_string())?;
        state.stopping = true;
        // Serialize signals with unregister, which must happen before reaping
        // the group leader. A detached PID snapshot could outlive that pin.
        let mut terminate_errors = Vec::new();
        for &process_group in &state.process_groups {
            if let Err(error) = platform::terminate_process_group(process_group, true) {
                terminate_errors.push(error);
            }
        }

        let deadline = Instant::now() + timeout;
        while !state.process_groups.is_empty() {
            let now = Instant::now();
            if now >= deadline {
                return Err(format!(
                    "timed out waiting for {} active process group(s) to stop",
                    state.process_groups.len()
                ));
            }

            let remaining = deadline.saturating_duration_since(now);
            let (next_state, wait_result) = self
                .idle
                .wait_timeout(state, remaining)
                .map_err(|_| "active process registry lock poisoned".to_string())?;
            state = next_state;

            if wait_result.timed_out() && !state.process_groups.is_empty() {
                return Err(format!(
                    "timed out waiting for {} active process group(s) to stop",
                    state.process_groups.len()
                ));
            }
        }

        if terminate_errors.is_empty() {
            Ok(())
        } else {
            Err(terminate_errors.join("; "))
        }
    }

    fn unregister(&self, process_group: i32) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.process_groups.remove(&process_group);
        if state.process_groups.is_empty() {
            self.idle.notify_all();
        }
    }
}

pub struct ActiveProcessGuard {
    process_group: Option<i32>,
    registry: Arc<ActiveProcessRegistry>,
}

impl ToolProcessGuard for ActiveProcessGuard {
    fn terminate_process_group(&self, force: bool) -> Result<(), String> {
        match self.process_group {
            Some(process_group) => platform::terminate_process_group(process_group, force),
            None => Ok(()),
        }
    }
}

impl ToolProcessRegistry for ActiveProcessRegistry {
    fn register(self: Arc<Self>, process_group: i32) -> Result<Box<dyn ToolProcessGuard>, String> {
        ActiveProcessRegistry::register(&self, process_group)
            .map(|guard| Box::new(guard) as Box<dyn ToolProcessGuard>)
    }
}

impl Drop for ActiveProcessGuard {
    fn drop(&mut self) {
        if let Some(process_group) = self.process_group.take() {
            self.registry.unregister(process_group);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use crate::tool::ToolProcessRegistry;

    use super::ActiveProcessRegistry;

    #[test]
    fn process_port_releases_registration_when_guard_drops() {
        let registry = Arc::new(ActiveProcessRegistry::new());
        let port: Arc<dyn ToolProcessRegistry> = registry.clone();
        let guard = port.register(200_001).unwrap();
        drop(guard);
        registry.stop_all(Duration::from_millis(10)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn shutdown_signals_an_unreaped_exited_group_before_unregister() {
        use nix::libc;
        use std::os::unix::process::CommandExt;
        use std::process::Command;
        use std::time::Instant;

        let mut child = Command::new("/bin/sh")
            .args(["-c", "exit 7"])
            .process_group(0)
            .spawn()
            .unwrap();
        let pid = child.id() as i32;
        let registry = Arc::new(ActiveProcessRegistry::new());
        let guard = ActiveProcessRegistry::register(&registry, pid).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            assert_eq!(
                unsafe {
                    libc::waitid(
                        libc::P_PID,
                        pid as libc::id_t,
                        &mut info,
                        libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                    )
                },
                0
            );
            if unsafe { info.si_pid() } == pid {
                break;
            }
            assert!(Instant::now() < deadline, "shell did not exit");
            std::thread::yield_now();
        }

        let stopping = Arc::clone(&registry);
        let shutdown = std::thread::spawn(move || stopping.stop_all(Duration::from_secs(5)));
        while !registry.state.lock().unwrap().stopping {
            assert!(Instant::now() < deadline, "shutdown did not start");
            std::thread::yield_now();
        }
        drop(guard);
        assert_eq!(child.wait().unwrap().code(), Some(7));
        shutdown.join().unwrap().unwrap();
    }
}
