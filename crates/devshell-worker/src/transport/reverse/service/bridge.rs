use std::io::{Read, Write};
use std::path::Path;
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::thread;

use crate::transport::socket::LocalIpcStream;

const OUTPUT_QUEUE_CAPACITY: usize = 64;

pub(super) struct ReverseServiceBridge {
    output: Option<Receiver<Result<Vec<u8>, String>>>,
    writer: Option<LocalIpcStream>,
}

impl ReverseServiceBridge {
    pub(super) fn new() -> Self {
        Self {
            output: None,
            writer: None,
        }
    }

    pub(super) fn prepare(&mut self, socket: &Path) -> Result<(), String> {
        self.close();
        let writer = LocalIpcStream::connect(socket)
            .map_err(|error| format!("failed to connect reverse Service bridge: {error}"))?;
        let mut reader = writer
            .try_clone()
            .map_err(|error| format!("failed to clone reverse Service bridge: {error}"))?;
        let (output_tx, output_rx) = mpsc::sync_channel(OUTPUT_QUEUE_CAPACITY);
        thread::spawn(move || {
            let mut buffer = vec![0_u8; 64 * 1024];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => {
                        let _ = output_tx.send(Err("reverse Service bridge closed".to_string()));
                        return;
                    }
                    Ok(read) => {
                        if output_tx.send(Ok(buffer[..read].to_vec())).is_err() {
                            return;
                        }
                    }
                    Err(error) => {
                        let _ = output_tx
                            .send(Err(format!("reverse Service bridge read failed: {error}")));
                        return;
                    }
                }
            }
        });
        self.writer = Some(writer);
        self.output = Some(output_rx);
        Ok(())
    }

    pub(super) fn send(&mut self, frame: &[u8]) -> Result<(), String> {
        let writer = self
            .writer
            .as_mut()
            .ok_or_else(|| "reverse Service bridge is not connected".to_string())?;
        writer
            .write_all(frame)
            .map_err(|error| format!("reverse Service bridge write failed: {error}"))?;
        writer
            .flush()
            .map_err(|error| format!("reverse Service bridge flush failed: {error}"))
    }

    pub(super) fn try_pop(&mut self) -> Result<Option<Vec<u8>>, String> {
        let Some(output) = self.output.as_ref() else {
            return Ok(None);
        };
        match output.try_recv() {
            Ok(Ok(frame)) => Ok(Some(frame)),
            Ok(Err(error)) => Err(error),
            Err(TryRecvError::Empty) => Ok(None),
            Err(TryRecvError::Disconnected) => {
                Err("reverse Service bridge output disconnected".to_string())
            }
        }
    }

    pub(super) fn close(&mut self) {
        if let Some(writer) = self.writer.take() {
            let _ = writer.shutdown_both();
        }
        self.output.take();
    }
}

impl Drop for ReverseServiceBridge {
    fn drop(&mut self) {
        self.close();
    }
}
