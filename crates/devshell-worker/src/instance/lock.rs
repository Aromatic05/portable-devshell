use std::fs::OpenOptions;
use std::os::fd::AsRawFd;

use nix::libc;

use crate::storage::InstancePaths;

pub struct InstanceLock {
    file: std::fs::File,
}

impl InstanceLock {
    pub fn acquire(paths: &InstancePaths) -> Result<Self, String> {
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(&paths.lock_file)
            .map_err(|error| format!("failed to open {}: {error}", paths.lock_file.display()))?;

        let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
        if result != 0 {
            return Err(format!(
                "failed to lock {}: {}",
                paths.lock_file.display(),
                std::io::Error::last_os_error()
            ));
        }

        Ok(Self { file })
    }
}

impl Drop for InstanceLock {
    fn drop(&mut self) {
        unsafe {
            libc::flock(self.file.as_raw_fd(), libc::LOCK_UN);
        }
    }
}
