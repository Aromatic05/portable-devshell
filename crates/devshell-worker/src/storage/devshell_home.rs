use std::path::PathBuf;

#[cfg(unix)]
#[path = "home_unix.rs"]
mod platform;
#[cfg(windows)]
#[path = "home_windows.rs"]
mod platform;

pub fn devshell_home() -> Result<PathBuf, String> {
    if let Some(override_home) = std::env::var_os("PORTABLE_DEVSHELL_HOME") {
        return Ok(PathBuf::from(override_home));
    }

    Ok(platform::user_home()?.join(".devshell"))
}
