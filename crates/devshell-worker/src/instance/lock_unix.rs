use std::fs::OpenOptions;
use std::os::fd::AsRawFd;
use std::path::Path;

use nix::libc;

pub struct PlatformInstanceLock {
    file: std::fs::File,
}

impl PlatformInstanceLock {
    pub fn acquire(path: &Path, nonblocking: bool) -> Result<Option<Self>, String> {
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

impl Drop for PlatformInstanceLock {
    fn drop(&mut self) {
        unsafe {
            libc::flock(self.file.as_raw_fd(), libc::LOCK_UN);
        }
    }
}
