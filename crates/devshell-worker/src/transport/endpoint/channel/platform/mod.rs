#[cfg(unix)]
#[path = "unix.rs"]
mod sys;
#[cfg(windows)]
#[path = "windows.rs"]
mod sys;

pub use sys::{LocalIpcListener, LocalIpcStream, endpoint_may_exist};
