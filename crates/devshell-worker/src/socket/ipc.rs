#[cfg(unix)]
#[path = "ipc_unix.rs"]
mod platform;
#[cfg(windows)]
#[path = "ipc_windows.rs"]
mod platform;

pub use platform::{LocalIpcListener, LocalIpcStream, endpoint_may_exist};
