use std::fs;
use std::io::Write;
use std::path::Path;

use serde::{Serialize, de::DeserializeOwned};
use tempfile::Builder;
use uuid::Uuid;

use crate::tools::ToolError;

pub(super) fn clear_temp_files(path: &Path) -> Result<(), ToolError> {
    for entry in fs::read_dir(path).map_err(storage_error)? {
        let entry = entry.map_err(storage_error)?;
        if entry.file_type().map_err(storage_error)?.is_file() {
            fs::remove_file(entry.path()).map_err(storage_error)?;
        }
    }
    Ok(())
}

pub(super) fn ensure_private_dir(path: &Path) -> Result<(), ToolError> {
    crate::storage::permissions::ensure_dir(path, 0o700)
        .map_err(|error| ToolError::new("artifact.storageFailed", error))
}

pub(super) fn validate_uuid(value: &str, code: &str, message: &str) -> Result<(), ToolError> {
    let parsed = Uuid::parse_str(value).map_err(|_| ToolError::new(code, message))?;
    if parsed.to_string() != value {
        return Err(ToolError::new(code, message));
    }
    Ok(())
}

pub(super) fn read_json<T: DeserializeOwned>(
    path: &Path,
    code: &str,
    unavailable: &str,
    invalid: &str,
    validate: impl FnOnce(&T) -> bool,
) -> Result<T, ToolError> {
    let bytes = fs::read(path).map_err(|_| ToolError::new(code, unavailable))?;
    let metadata = serde_json::from_slice(&bytes).map_err(|_| ToolError::new(code, invalid))?;
    if !validate(&metadata) {
        return Err(ToolError::new(code, invalid));
    }
    Ok(metadata)
}

pub(super) fn write_json<T: Serialize>(
    root: &Path,
    target: &Path,
    prefix: &str,
    value: &T,
) -> Result<(), ToolError> {
    let mut temp = Builder::new()
        .prefix(prefix)
        .suffix(".tmp")
        .tempfile_in(root)
        .map_err(storage_error)?;
    serde_json::to_writer(&mut temp, value).map_err(storage_error)?;
    temp.flush().map_err(storage_error)?;
    temp.as_file().sync_all().map_err(storage_error)?;
    temp.persist(target)
        .map_err(|error| storage_error(error.error))?;
    Ok(())
}

fn storage_error(error: impl ToString) -> ToolError {
    ToolError::new("artifact.storageFailed", error.to_string())
}
