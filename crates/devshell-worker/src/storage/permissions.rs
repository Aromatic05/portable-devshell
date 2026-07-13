#[cfg(unix)]
#[path = "permissions_unix.rs"]
mod platform;
#[cfg(windows)]
#[path = "permissions_windows.rs"]
mod platform;

pub use platform::{ensure_dir, ensure_file_mode};
