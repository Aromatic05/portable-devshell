use std::fs::OpenOptions;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::storage::InstancePaths;

pub fn append_log(paths: &InstancePaths, message: &str) -> Result<(), String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(&paths.log_file)
        .map_err(|error| format!("failed to open {}: {error}", paths.log_file.display()))?;
    writeln!(file, "[{timestamp}] {message}").map_err(|error| error.to_string())
}
