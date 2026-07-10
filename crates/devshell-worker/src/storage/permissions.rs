use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

pub fn ensure_dir(path: &Path, mode: u32) -> Result<(), String> {
    fs::create_dir_all(path)
        .map_err(|error| format!("failed to create directory {}: {error}", path.display()))?;
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(|error| {
        format!(
            "failed to set permissions on directory {}: {error}",
            path.display()
        )
    })?;
    Ok(())
}

pub fn ensure_file_mode(path: &Path, mode: u32) -> Result<(), String> {
    if path.exists() {
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(|error| {
            format!(
                "failed to set permissions on file {}: {error}",
                path.display()
            )
        })?;
    }
    Ok(())
}
