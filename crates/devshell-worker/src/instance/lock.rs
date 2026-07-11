use std::fs::OpenOptions;
use std::os::fd::AsRawFd;
use std::path::Path;

use nix::libc;

use crate::storage::InstancePaths;

pub struct InstanceLock {
    file: std::fs::File,
}

impl InstanceLock {
    pub fn acquire(paths: &InstancePaths) -> Result<Self, String> {
        Self::acquire_path(&paths.lock_file, false)?
            .ok_or_else(|| format!("failed to lock {}", paths.lock_file.display()))
    }

    pub fn acquire_daemon(paths: &InstancePaths) -> Result<Self, String> {
        Self::acquire_path(&paths.daemon_lock_file, false)?
            .ok_or_else(|| format!("failed to lock {}", paths.daemon_lock_file.display()))
    }

    pub fn try_acquire_daemon(paths: &InstancePaths) -> Result<Option<Self>, String> {
        Self::acquire_path(&paths.daemon_lock_file, true)
    }

    fn acquire_path(path: &Path, nonblocking: bool) -> Result<Option<Self>, String> {
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(path)
            .map_err(|error| format!("failed to open {}: {error}", path.display()))?;
        let operation = libc::LOCK_EX | if nonblocking { libc::LOCK_NB } else { 0 };
        let result = unsafe { libc::flock(file.as_raw_fd(), operation) };

        if result == 0 {
            return Ok(Some(Self { file }));
        }

        let error = std::io::Error::last_os_error();
        if nonblocking && error.kind() == std::io::ErrorKind::WouldBlock {
            return Ok(None);
        }

        Err(format!("failed to lock {}: {error}", path.display()))
    }
}

impl Drop for InstanceLock {
    fn drop(&mut self) {
        unsafe {
            libc::flock(self.file.as_raw_fd(), libc::LOCK_UN);
        }
    }
}
