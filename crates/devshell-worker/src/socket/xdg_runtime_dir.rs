use std::path::PathBuf;

use crate::storage::devshell_home;

pub fn xdg_runtime_dir() -> Result<PathBuf, String> {
    if let Some(runtime_dir) = std::env::var_os("XDG_RUNTIME_DIR")
        && !runtime_dir.is_empty()
    {
        return Ok(PathBuf::from(runtime_dir));
    }

    Ok(devshell_home()?.join("runtime"))
}
