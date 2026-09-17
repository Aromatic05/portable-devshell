use std::io::Read;
use std::sync::Arc;

use serde::Deserialize;

use crate::capability::artifact::payload::{ArtifactPayloadReader, ArtifactPayloadStore};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PayloadMetadata {
    payload_id: String,
    offset_bytes: u64,
    max_bytes: usize,
}

pub(in crate::transport::service) struct PayloadService {
    output: Option<PayloadOutput>,
}

impl PayloadService {
    pub(in crate::transport::service) fn open(
        metadata: &[u8],
        payloads: Arc<ArtifactPayloadStore>,
    ) -> Result<Self, String> {
        let metadata: PayloadMetadata = serde_json::from_slice(metadata)
            .map_err(|error| format!("artifact.payload metadata is invalid: {error}"))?;
        let reader = payloads
            .open_reader(
                &metadata.payload_id,
                metadata.offset_bytes,
                metadata.max_bytes,
            )
            .map_err(tool_error)?;
        let total_bytes = u64::try_from(reader.total_bytes())
            .map_err(|_| "artifact payload length exceeds u64".to_string())?;
        Ok(Self {
            output: Some(PayloadOutput {
                header: total_bytes.to_be_bytes(),
                header_offset: 0,
                reader,
            }),
        })
    }

    pub(in crate::transport::service) fn take_output(&mut self) -> Result<PayloadOutput, String> {
        self.output
            .take()
            .ok_or_else(|| "artifact.payload output is already attached.".to_string())
    }

    pub(in crate::transport::service) fn reset(&mut self) {
        self.output.take();
    }
}

pub(in crate::transport::service) struct PayloadOutput {
    header: [u8; 8],
    header_offset: usize,
    reader: ArtifactPayloadReader,
}

impl Read for PayloadOutput {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        if self.header_offset < self.header.len() {
            let remaining = &self.header[self.header_offset..];
            let copied = remaining.len().min(buffer.len());
            buffer[..copied].copy_from_slice(&remaining[..copied]);
            self.header_offset += copied;
            return Ok(copied);
        }
        self.reader.read(buffer)
    }
}

fn tool_error(error: crate::tool::ToolError) -> String {
    format!("{}: {}", error.code, error.message)
}
