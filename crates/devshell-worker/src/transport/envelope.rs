use serde::{Deserialize, Serialize};

pub const ENVELOPE_MAX_SIZE: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Address {
    pub host: String,
    pub port: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Envelope {
    pub source: Address,
    pub dest: Address,
    pub packet: serde_json::Value,
}

#[derive(Default)]
pub struct EnvelopeDecoder {
    buffer: Vec<u8>,
}

impl EnvelopeDecoder {
    pub fn push(&mut self, data: &[u8]) -> Result<Vec<Envelope>, String> {
        self.buffer.extend_from_slice(data);
        let mut envelopes = Vec::new();
        let mut offset = 0;
        while self.buffer.len().saturating_sub(offset) >= 4 {
            let length = u32::from_be_bytes(
                self.buffer[offset..offset + 4]
                    .try_into()
                    .map_err(|_| "Envelope length is invalid.".to_string())?,
            ) as usize;
            if length > ENVELOPE_MAX_SIZE {
                return Err(format!("Envelope exceeds {ENVELOPE_MAX_SIZE} bytes."));
            }
            if self.buffer.len() - offset < 4 + length {
                break;
            }
            envelopes.push(
                serde_json::from_slice(&self.buffer[offset + 4..offset + 4 + length])
                    .map_err(|error| format!("Envelope JSON is invalid: {error}"))?,
            );
            offset += 4 + length;
        }
        if offset > 0 {
            self.buffer.drain(..offset);
        }
        Ok(envelopes)
    }
}

pub fn encode(envelope: &Envelope) -> Result<Vec<u8>, String> {
    let body = serde_json::to_vec(envelope).map_err(|error| error.to_string())?;
    if body.len() > ENVELOPE_MAX_SIZE {
        return Err(format!("Envelope exceeds {ENVELOPE_MAX_SIZE} bytes."));
    }
    let length = u32::try_from(body.len()).map_err(|error| error.to_string())?;
    let mut encoded = Vec::with_capacity(4 + body.len());
    encoded.extend_from_slice(&length.to_be_bytes());
    encoded.extend_from_slice(&body);
    Ok(encoded)
}
