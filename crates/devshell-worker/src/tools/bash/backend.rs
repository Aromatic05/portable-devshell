#[cfg(unix)]
#[path = "backend_unix.rs"]
mod platform;
#[cfg(windows)]
#[path = "backend_windows.rs"]
mod platform;

pub use platform::spawn_shell;
