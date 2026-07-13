use std::io::{Read, Result as IoResult, Write};
use std::net::Shutdown;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;

pub fn endpoint_may_exist(path: &Path) -> bool {
    path.exists()
}

pub struct LocalIpcListener {
    inner: UnixListener,
}

impl LocalIpcListener {
    pub fn bind(path: &Path) -> IoResult<Self> {
        Ok(Self {
            inner: UnixListener::bind(path)?,
        })
    }

    pub fn set_nonblocking(&self, nonblocking: bool) -> IoResult<()> {
        self.inner.set_nonblocking(nonblocking)
    }

    pub fn accept(&self) -> IoResult<LocalIpcStream> {
        let (stream, _) = self.inner.accept()?;
        Ok(LocalIpcStream { inner: stream })
    }
}

pub struct LocalIpcStream {
    inner: UnixStream,
}

impl LocalIpcStream {
    pub fn connect(path: &Path) -> IoResult<Self> {
        Ok(Self {
            inner: UnixStream::connect(path)?,
        })
    }

    pub fn try_clone(&self) -> IoResult<Self> {
        Ok(Self {
            inner: self.inner.try_clone()?,
        })
    }

    pub fn set_nonblocking(&self, nonblocking: bool) -> IoResult<()> {
        self.inner.set_nonblocking(nonblocking)
    }

    pub fn shutdown_write(&self) -> IoResult<()> {
        self.inner.shutdown(Shutdown::Write)
    }

    pub fn shutdown_both(&self) -> IoResult<()> {
        self.inner.shutdown(Shutdown::Both)
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
