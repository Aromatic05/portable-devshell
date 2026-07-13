use std::path::PathBuf;

pub fn user_home() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "HOME is not set and PORTABLE_DEVSHELL_HOME is not configured".to_string())
}
