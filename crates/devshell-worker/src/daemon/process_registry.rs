use std::collections::HashSet;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use crate::platform;

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

    pub fn register(
        self: &Arc<Self>,
        process_group: i32,
    ) -> Result<ActiveProcessGuard, String> {
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
        let process_groups = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "active process registry lock poisoned".to_string())?;
            state.stopping = true;
            state.process_groups.iter().copied().collect::<Vec<_>>()
        };

        let mut terminate_errors = Vec::new();
        for process_group in process_groups {
            if let Err(error) = platform::terminate_process_group(process_group, true) {
                terminate_errors.push(error);
            }
        }

        let deadline = Instant::now() + timeout;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "active process registry lock poisoned".to_string())?;

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

impl Drop for ActiveProcessGuard {
    fn drop(&mut self) {
        if let Some(process_group) = self.process_group.take() {
            self.registry.unregister(process_group);
        }
    }
}
