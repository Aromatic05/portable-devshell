use std::fs::OpenOptions;
use std::io::Write;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::instance::storage::InstancePaths;
use crate::instance::storage::ensure_file_mode;

pub fn append_log(paths: &InstancePaths, message: &str) -> Result<(), String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&paths.log_file)
        .map_err(|error| format!("failed to open {}: {error}", paths.log_file.display()))?;
    ensure_file_mode(&paths.log_file, 0o600)?;
    writeln!(file, "[{timestamp}] {message}").map_err(|error| error.to_string())
}
