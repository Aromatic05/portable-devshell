use std::fs::OpenOptions;
use std::os::windows::fs::OpenOptionsExt;
use std::path::Path;
use std::thread;
use std::time::Duration;

const ERROR_SHARING_VIOLATION: i32 = 32;
const ERROR_LOCK_VIOLATION: i32 = 33;

pub struct PlatformInstanceLock {
    _file: std::fs::File,
}

impl PlatformInstanceLock {
    pub fn acquire(path: &Path, nonblocking: bool) -> Result<Option<Self>, String> {
        loop {
            match OpenOptions::new()
                .create(true)
                .read(true)
                .write(true)
                .share_mode(0)
                .open(path)
            {
                Ok(file) => return Ok(Some(Self { _file: file })),
                Err(error) if is_lock_busy(&error) && nonblocking => return Ok(None),
                Err(error) if is_lock_busy(&error) => {
                    thread::sleep(Duration::from_millis(50));
                }
                Err(error) => {
                    return Err(format!("failed to lock {}: {error}", path.display()));
                }
            }
        }
    }
}

fn is_lock_busy(error: &std::io::Error) -> bool {
    matches!(
        error.raw_os_error(),
        Some(ERROR_SHARING_VIOLATION | ERROR_LOCK_VIOLATION)
    )
}
