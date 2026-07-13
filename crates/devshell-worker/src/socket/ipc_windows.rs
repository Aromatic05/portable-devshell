use std::fs::{File, OpenOptions};
use std::io::{Error, ErrorKind, Read, Result as IoResult, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::Mutex;
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::thread;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{
    ERROR_FILE_NOT_FOUND, ERROR_NO_DATA, ERROR_PIPE_BUSY, ERROR_PIPE_CONNECTED,
    INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE,
    PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};

pub fn endpoint_may_exist(_path: &Path) -> bool {
    true
}

pub struct LocalIpcListener {
    accepted: Mutex<Receiver<IoResult<File>>>,
}

impl LocalIpcListener {
    pub fn bind(path: &Path) -> IoResult<Self> {
        let first = create_pipe_instance(path)?;
        let path = path.to_path_buf();
        let (sender, accepted) = mpsc::channel();
        thread::Builder::new()
            .name("devshell-worker-pipe-accept".to_string())
            .spawn(move || accept_loop(path, first, sender))?;
        Ok(Self {
            accepted: Mutex::new(accepted),
        })
    }

    pub fn set_nonblocking(&self, _nonblocking: bool) -> IoResult<()> {
        Ok(())
    }

    pub fn accept(&self) -> IoResult<LocalIpcStream> {
        let accepted = self
            .accepted
            .lock()
            .map_err(|_| Error::other("named pipe listener lock poisoned"))?;
        match accepted.try_recv() {
            Ok(Ok(inner)) => Ok(LocalIpcStream { inner }),
            Ok(Err(error)) => Err(error),
            Err(TryRecvError::Empty) => Err(Error::new(
                ErrorKind::WouldBlock,
                "no named pipe client is ready",
            )),
            Err(TryRecvError::Disconnected) => Err(Error::new(
                ErrorKind::BrokenPipe,
                "named pipe accept thread stopped",
            )),
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
                    if matches!(
                        error.raw_os_error(),
                        Some(code)
                            if code == ERROR_PIPE_BUSY as i32
                                || code == ERROR_FILE_NOT_FOUND as i32
                    ) && Instant::now() < deadline =>
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

fn accept_loop(path: PathBuf, first: File, sender: Sender<IoResult<File>>) {
    let mut pending = first;
    loop {
        match connect_pipe(pending) {
            Ok(connected) => {
                if sender.send(Ok(connected)).is_err() {
                    return;
                }
            }
            Err(error) if error.raw_os_error() == Some(ERROR_NO_DATA as i32) => {}
            Err(error) => {
                let _ = sender.send(Err(error));
                return;
            }
        }

        pending = match create_pipe_instance(&path) {
            Ok(file) => file,
            Err(error) => {
                let _ = sender.send(Err(error));
                return;
            }
        };
    }
}

fn connect_pipe(file: File) -> IoResult<File> {
    let connected = unsafe { ConnectNamedPipe(file.as_raw_handle(), ptr::null_mut()) };
    if connected != 0 {
        return Ok(file);
    }

    let error = Error::last_os_error();
    if error.raw_os_error() == Some(ERROR_PIPE_CONNECTED as i32) {
        Ok(file)
    } else {
        Err(error)
    }
}

fn create_pipe_instance(path: &Path) -> IoResult<File> {
    let name = wide_path(path);
    let handle = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
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
