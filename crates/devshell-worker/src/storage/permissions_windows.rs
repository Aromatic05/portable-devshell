use std::fs;
use std::path::Path;

pub fn ensure_dir(path: &Path, _mode: u32) -> Result<(), String> {
    fs::create_dir_all(path)
        .map_err(|error| format!("failed to create directory {}: {error}", path.display()))
}

pub fn ensure_file_mode(_path: &Path, _mode: u32) -> Result<(), String> {
    Ok(())
}
