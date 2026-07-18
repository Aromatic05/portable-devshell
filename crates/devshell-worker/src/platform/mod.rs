mod environment;
mod path;
use std::time::{SystemTime, UNIX_EPOCH};
#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

#[cfg(unix)]
pub use unix::{
    configure_daemon_command, process_is_running, terminate_process, terminate_process_group,
};
#[cfg(windows)]
pub use windows::{
    configure_child_process, process_is_running, spawn_daemon_process, terminate_process,
    terminate_process_group,
};

pub use environment::detect_environment;
pub use path::protocol_path;

pub(crate) fn unix_time_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
