use std::path::PathBuf;

pub fn xdg_runtime_dir() -> Result<PathBuf, String> {
    let runtime_dir = std::env::var_os("XDG_RUNTIME_DIR")
        .ok_or_else(|| "XDG_RUNTIME_DIR is required for worker socket placement".to_string())?;
    Ok(PathBuf::from(runtime_dir))
}
