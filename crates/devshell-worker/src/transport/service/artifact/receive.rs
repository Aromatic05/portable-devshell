use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Deserialize;

use crate::capability::artifact::receive::ArtifactReceiveStore;

const RECEIVE_FLUSH_BYTES: usize = 512 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReceiveMetadata {
    receive_id: String,
    offset_bytes: u64,
}

pub(in crate::transport::service) struct ReceiveService {
    complete: Arc<AtomicBool>,
    input: Option<ReceiveInput>,
}

impl ReceiveService {
    pub(in crate::transport::service) fn open(
        metadata: &[u8],
        receives: Arc<ArtifactReceiveStore>,
    ) -> Result<Self, String> {
        let metadata: ReceiveMetadata = serde_json::from_slice(metadata)
            .map_err(|error| format!("artifact.receive metadata is invalid: {error}"))?;
        let actual_offset = receives
            .received_bytes(&metadata.receive_id)
            .map_err(tool_error)?;
        if actual_offset != metadata.offset_bytes {
            return Err(format!(
                "artifact.receive offset mismatch: expected {actual_offset}, received {}",
                metadata.offset_bytes
            ));
        }
        let complete = Arc::new(AtomicBool::new(false));
        Ok(Self {
            input: Some(ReceiveInput {
                buffer: Vec::with_capacity(RECEIVE_FLUSH_BYTES),
                complete: Arc::clone(&complete),
                offset_bytes: actual_offset,
                receive_id: metadata.receive_id,
                receives,
            }),
            complete,
        })
    }

    pub(in crate::transport::service) fn take_input(&mut self) -> Result<ReceiveInput, String> {
        self.input
            .take()
            .ok_or_else(|| "artifact.receive input is already attached.".to_string())
    }

    pub(in crate::transport::service) fn output_complete(&self) -> bool {
        self.complete.load(Ordering::Acquire)
    }

    pub(in crate::transport::service) fn reset(&mut self) {
        self.input.take();
    }
}

pub(in crate::transport::service) struct ReceiveInput {
    buffer: Vec<u8>,
    complete: Arc<AtomicBool>,
    offset_bytes: u64,
    receive_id: String,
    receives: Arc<ArtifactReceiveStore>,
}

impl ReceiveInput {
    pub(in crate::transport::service) fn write(&mut self, data: &[u8]) -> Result<(), String> {
        self.buffer.extend_from_slice(data);
        if self.buffer.len() >= RECEIVE_FLUSH_BYTES {
            self.flush()?;
        }
        Ok(())
    }

    pub(in crate::transport::service) fn finish(&mut self) -> Result<(), String> {
        self.flush()?;
        self.complete.store(true, Ordering::Release);
        Ok(())
    }

    fn flush(&mut self) -> Result<(), String> {
        if self.buffer.is_empty() {
            return Ok(());
        }
        let written = self
            .receives
            .write_bytes(&self.receive_id, self.offset_bytes, &self.buffer)
            .map_err(tool_error)?;
        self.offset_bytes = written.next_offset_bytes;
        self.buffer.clear();
        Ok(())
    }
}

fn tool_error(error: crate::tool::ToolError) -> String {
    format!("{}: {}", error.code, error.message)
}
