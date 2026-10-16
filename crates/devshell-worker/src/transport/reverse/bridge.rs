use std::collections::VecDeque;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, TryRecvError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use crate::capability::rpc::router::RpcRouter;
use crate::transport::endpoint::channel::LocalIpcStream;

const OUTPUT_QUEUE_CAPACITY: usize = 64;

pub(super) struct ReverseBridge {
    output: Mutex<Option<Receiver<Result<Vec<u8>, String>>>>,
    pending: Mutex<VecDeque<Vec<u8>>>,
    router: Arc<RpcRouter>,
    transport_endpoint: PathBuf,
    writer: Mutex<Option<LocalIpcStream>>,
}

impl ReverseBridge {
    pub(super) fn new(transport_endpoint: PathBuf, router: Arc<RpcRouter>) -> Self {
        Self {
            output: Mutex::new(None),
            pending: Mutex::new(VecDeque::new()),
            router,
            transport_endpoint,
            writer: Mutex::new(None),
        }
    }

    pub(super) fn is_stopping(&self) -> bool {
        self.router.shutdown_requested()
    }

    pub(super) fn prepare(&self) -> Result<(), String> {
        self.close();
        // Keep completed responses that were not acknowledged by the previous
        // transport generation. Only result frames are replayed here; never
        // re-execute the original tool call.
        let writer = LocalIpcStream::connect(&self.transport_endpoint).map_err(|error| {
            format!(
                "failed to connect reverse Endpoint bridge {}: {error}",
                self.transport_endpoint.display(),
            )
        })?;
        let mut reader = writer
            .try_clone()
            .map_err(|error| format!("failed to clone reverse Endpoint bridge: {error}"))?;
        let (output_tx, output_rx) = mpsc::sync_channel(OUTPUT_QUEUE_CAPACITY);
        thread::spawn(move || {
            let mut buffer = vec![0_u8; 64 * 1024];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => {
                        let _ = output_tx.send(Err("reverse Endpoint bridge closed".to_string()));
                        return;
                    }
                    Ok(read) => {
                        if output_tx.send(Ok(buffer[..read].to_vec())).is_err() {
                            return;
                        }
                    }
                    Err(error) => {
                        let _ = output_tx.send(Err(format!(
                            "reverse Endpoint bridge read failed: {error}",
                        )));
                        return;
                    }
                }
            }
        });
        *self
            .writer
            .lock()
            .map_err(|_| "reverse Endpoint writer lock poisoned".to_string())? = Some(writer);
        *self
            .output
            .lock()
            .map_err(|_| "reverse Endpoint output lock poisoned".to_string())? = Some(output_rx);
        Ok(())
    }

    pub(super) fn accept_inbound(&self, frame: &[u8]) -> Result<Option<Vec<u8>>, String> {
        {
            let mut writer = self
                .writer
                .lock()
                .map_err(|_| "reverse Endpoint writer lock poisoned".to_string())?;
            let writer = writer
                .as_mut()
                .ok_or_else(|| "reverse Endpoint bridge is not connected".to_string())?;
            writer
                .write_all(frame)
                .map_err(|error| format!("reverse Endpoint bridge write failed: {error}"))?;
            writer
                .flush()
                .map_err(|error| format!("reverse Endpoint bridge flush failed: {error}"))?;
        }
        self.try_pop_outbound()
    }

    pub(super) fn try_pop_outbound(&self) -> Result<Option<Vec<u8>>, String> {
        if let Some(frame) = self
            .pending
            .lock()
            .map_err(|_| "reverse pending queue lock poisoned".to_string())?
            .pop_front()
        {
            return Ok(Some(frame));
        }
        let output = self
            .output
            .lock()
            .map_err(|_| "reverse Endpoint output lock poisoned".to_string())?;
        let Some(output) = output.as_ref() else {
            return Ok(None);
        };
        match output.try_recv() {
            Ok(Ok(frame)) => Ok(Some(frame)),
            Ok(Err(error)) => Err(error),
            Err(TryRecvError::Empty) => Ok(None),
            Err(TryRecvError::Disconnected) => {
                Err("reverse Endpoint bridge output disconnected".to_string())
            }
        }
    }

    pub(super) fn wait_pop_outbound(&self, timeout: Duration) -> Result<Option<Vec<u8>>, String> {
        if let Some(frame) = self
            .pending
            .lock()
            .map_err(|_| "reverse pending queue lock poisoned".to_string())?
            .pop_front()
        {
            return Ok(Some(frame));
        }
        let output = self
            .output
            .lock()
            .map_err(|_| "reverse Endpoint output lock poisoned".to_string())?;
        let Some(output) = output.as_ref() else {
            return Ok(None);
        };
        match output.recv_timeout(timeout) {
            Ok(Ok(frame)) => Ok(Some(frame)),
            Ok(Err(error)) => Err(error),
            Err(RecvTimeoutError::Timeout) => Ok(None),
            Err(RecvTimeoutError::Disconnected) => {
                Err("reverse Endpoint bridge output disconnected".to_string())
            }
        }
    }

    pub(super) fn requeue_front(&self, frame: Vec<u8>) -> Result<(), String> {
        self.pending
            .lock()
            .map_err(|_| "reverse pending queue lock poisoned".to_string())?
            .push_front(frame);
        Ok(())
    }

    fn close(&self) {
        if let Ok(mut writer) = self.writer.lock()
            && let Some(writer) = writer.take()
        {
            let _ = writer.shutdown_both();
        }
        if let Ok(mut output) = self.output.lock() {
            output.take();
        }
    }
}

impl Drop for ReverseBridge {
    fn drop(&mut self) {
        self.close();
    }
}
