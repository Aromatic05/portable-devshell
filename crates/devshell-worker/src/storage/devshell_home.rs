use std::path::PathBuf;

pub fn devshell_home() -> Result<PathBuf, String> {
    if let Some(override_home) = std::env::var_os("PORTABLE_DEVSHELL_HOME") {
        return Ok(PathBuf::from(override_home));
    }

    let home = std::env::var_os("HOME")
        .ok_or_else(|| "HOME is not set and PORTABLE_DEVSHELL_HOME is not configured".to_string())?;
    Ok(PathBuf::from(home).join(".devshell"))
}
