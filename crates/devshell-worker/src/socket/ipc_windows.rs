use std::fs::{File, OpenOptions};
use std::io::{Error, ErrorKind, Read, Result as IoResult, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

pub fn endpoint_may_exist(_path: &Path) -> bool {
    true
}

use windows_sys::Win32::Foundation::{
    ERROR_NO_DATA, ERROR_PIPE_BUSY, ERROR_PIPE_CONNECTED, ERROR_PIPE_LISTENING,
    INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, PIPE_NOWAIT, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE,
    PIPE_UNLIMITED_INSTANCES, PIPE_WAIT, SetNamedPipeHandleState,
};

pub struct LocalIpcListener {
    path: PathBuf,
    pending: Mutex<Option<File>>,
}

impl LocalIpcListener {
    pub fn bind(path: &Path) -> IoResult<Self> {
        Ok(Self {
            path: path.to_path_buf(),
            pending: Mutex::new(None),
        })
    }

    pub fn set_nonblocking(&self, _nonblocking: bool) -> IoResult<()> {
        Ok(())
    }

    pub fn accept(&self) -> IoResult<LocalIpcStream> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| Error::other("named pipe listener lock poisoned"))?;
        if pending.is_none() {
            *pending = Some(create_pipe_instance(&self.path)?);
        }

        let handle = pending
            .as_ref()
            .expect("pending named pipe must exist")
            .as_raw_handle();
        let connected = unsafe { ConnectNamedPipe(handle, ptr::null_mut()) };
        if connected != 0 {
            return connected_stream(&mut pending);
        }

        let error = Error::last_os_error();
        match error.raw_os_error() {
            Some(code) if code == ERROR_PIPE_CONNECTED as i32 => connected_stream(&mut pending),
            Some(code) if code == ERROR_PIPE_LISTENING as i32 => {
                Err(Error::new(ErrorKind::WouldBlock, "named pipe is listening"))
            }
            Some(code) if code == ERROR_NO_DATA as i32 => {
                pending.take();
                Err(Error::new(
                    ErrorKind::WouldBlock,
                    "named pipe client disconnected before accept",
                ))
            }
            _ => {
                pending.take();
                Err(error)
            }
        }
    }
}

pub struct LocalIpcStream {
    inner: File,
}

impl LocalIpcStream {
    pub fn connect(path: &Path) -> IoResult<Self> {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match OpenOptions::new().read(true).write(true).open(path) {
                Ok(inner) => return Ok(Self { inner }),
                Err(error)
                    if error.raw_os_error() == Some(ERROR_PIPE_BUSY as i32)
                        && Instant::now() < deadline =>
                {
                    thread::sleep(Duration::from_millis(25));
                }
                Err(error) => return Err(error),
            }
        }
    }

    pub fn try_clone(&self) -> IoResult<Self> {
        Ok(Self {
            inner: self.inner.try_clone()?,
        })
    }

    pub fn set_nonblocking(&self, _nonblocking: bool) -> IoResult<()> {
        Ok(())
    }

    pub fn shutdown_write(&self) -> IoResult<()> {
        Ok(())
    }

    pub fn shutdown_both(&self) -> IoResult<()> {
        Ok(())
    }
}

impl Read for LocalIpcStream {
    fn read(&mut self, buffer: &mut [u8]) -> IoResult<usize> {
        self.inner.read(buffer)
    }
}

impl Write for LocalIpcStream {
    fn write(&mut self, buffer: &[u8]) -> IoResult<usize> {
        self.inner.write(buffer)
    }

    fn flush(&mut self) -> IoResult<()> {
        self.inner.flush()
    }
}

fn connected_stream(pending: &mut Option<File>) -> IoResult<LocalIpcStream> {
    let file = pending.take().expect("connected named pipe must exist");
    let mode = PIPE_READMODE_BYTE | PIPE_WAIT;
    let result =
        unsafe { SetNamedPipeHandleState(file.as_raw_handle(), &mode, ptr::null(), ptr::null()) };
    if result == 0 {
        return Err(Error::last_os_error());
    }
    Ok(LocalIpcStream { inner: file })
}

fn create_pipe_instance(path: &Path) -> IoResult<File> {
    let name = wide_path(path);
    let handle = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_NOWAIT,
            PIPE_UNLIMITED_INSTANCES,
            64 * 1024,
            64 * 1024,
            0,
            ptr::null(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_handle(handle) })
}

fn wide_path(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}
