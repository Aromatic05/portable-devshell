use std::path::Path;

#[cfg(unix)]
#[path = "lock_unix.rs"]
mod platform;
#[cfg(windows)]
#[path = "lock_windows.rs"]
mod platform;

use platform::PlatformInstanceLock;

use crate::storage::InstancePaths;

pub struct InstanceLock {
    _platform: PlatformInstanceLock,
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
        Ok(
            PlatformInstanceLock::acquire(path, nonblocking)?.map(|platform| Self {
                _platform: platform,
            }),
        )
    }
}
