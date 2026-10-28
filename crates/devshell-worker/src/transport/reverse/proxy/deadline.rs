use std::net::{Shutdown, TcpStream};
use std::sync::mpsc::{self, Sender};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

// A single, joined watchdog owns a clone of the attempt socket. Unlike socket
// idle timeouts, shutdown enforces an absolute deadline even against trickle I/O.
// Synchronous OS DNS resolution remains outside this socket cancellation bound.
pub(crate) struct SocketDeadline {
    done: Sender<()>,
    worker: Option<JoinHandle<()>>,
}

impl SocketDeadline {
    pub(crate) fn new(
        stream: &TcpStream,
        deadline: Instant,
        stopping: impl Fn() -> bool + Send + 'static,
    ) -> Result<Self, String> {
        let socket = stream.try_clone().map_err(|error| error.to_string())?;
        let (done, receiver) = mpsc::channel();
        let worker = thread::spawn(move || {
            loop {
                if stopping() || Instant::now() >= deadline {
                    let _ = socket.shutdown(Shutdown::Both);
                    break;
                }
                match receiver.recv_timeout(
                    deadline
                        .saturating_duration_since(Instant::now())
                        .min(Duration::from_millis(50)),
                ) {
                    Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }
            }
        });
        Ok(Self {
            done,
            worker: Some(worker),
        })
    }
}

impl Drop for SocketDeadline {
    fn drop(&mut self) {
        let _ = self.done.send(());
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
