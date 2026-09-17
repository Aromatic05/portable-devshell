use std::convert::TryFrom;

const PACKET_HEADER_SIZE: usize = 4;
const FRAME_HEADER_SIZE: usize = 6;
const OPEN_FIXED_SIZE: usize = 6;
const WINDOW_PAYLOAD_SIZE: usize = 4;
const RESET_CODE_SIZE: usize = 2;

pub const FRAME_PROTOCOL_VERSION: u8 = 1;
pub const FRAME_MAX_DATA_SIZE: usize = 64 * 1024;
pub const TRANSPORT_MAX_FRAME_SIZE: usize = 16 * 1024 * 1024;

pub const RESET_UNSUPPORTED_SERVICE: u16 = 1;
pub const RESET_SERVICE_FAILED: u16 = 3;
#[cfg(test)]
pub const RESET_CANCELLED: u16 = 4;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Frame {
    Open {
        stream_id: u32,
        receive_window: u32,
        service: String,
        metadata: Vec<u8>,
    },
    Data {
        stream_id: u32,
        data: Vec<u8>,
    },
    Window {
        stream_id: u32,
        credit_delta: u32,
    },
    Fin {
        stream_id: u32,
    },
    Reset {
        stream_id: u32,
        code: u16,
        message: String,
    },
}

impl Frame {
    pub fn stream_id(&self) -> u32 {
        match self {
            Self::Open { stream_id, .. }
            | Self::Data { stream_id, .. }
            | Self::Window { stream_id, .. }
            | Self::Fin { stream_id }
            | Self::Reset { stream_id, .. } => *stream_id,
        }
    }
}

#[derive(Debug)]
pub struct FrameDecoder {
    buffer: Vec<u8>,
    max_frame_size: usize,
}

impl Default for FrameDecoder {
    fn default() -> Self {
        Self::new(TRANSPORT_MAX_FRAME_SIZE)
    }
}

impl FrameDecoder {
    pub fn new(max_frame_size: usize) -> Self {
        Self {
            buffer: Vec::new(),
            max_frame_size,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.buffer.is_empty()
    }

    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Frame>, String> {
        if !bytes.is_empty() {
            self.buffer.extend_from_slice(bytes);
        }
        let mut frames = Vec::new();
        loop {
            if self.buffer.len() < PACKET_HEADER_SIZE {
                break;
            }
            let body_len = read_u32(&self.buffer, 0)? as usize;
            if body_len > self.max_frame_size {
                return Err(format!(
                    "Frame payload exceeds {} bytes.",
                    self.max_frame_size
                ));
            }
            let packet_len = PACKET_HEADER_SIZE
                .checked_add(body_len)
                .ok_or_else(|| "Frame packet length overflow.".to_string())?;
            if self.buffer.len() < packet_len {
                break;
            }
            let packet = self.buffer[..packet_len].to_vec();
            self.buffer.drain(..packet_len);
            frames.push(decode_frame(&packet)?);
        }
        Ok(frames)
    }
}

pub fn encode_frame(frame: &Frame) -> Result<Vec<u8>, String> {
    let stream_id = frame.stream_id();
    if stream_id == 0 {
        return Err("Frame streamId must be a positive u32.".to_string());
    }

    let (frame_type, payload) = match frame {
        Frame::Open {
            receive_window,
            service,
            metadata,
            ..
        } => {
            if *receive_window == 0 {
                return Err("OPEN receive window must be a positive u32.".to_string());
            }
            let service_bytes = service.as_bytes();
            if service_bytes.is_empty() {
                return Err("OPEN service must be a non-empty UTF-8 name.".to_string());
            }
            let service_len = u16::try_from(service_bytes.len())
                .map_err(|_| "OPEN service exceeds u16 length.".to_string())?;
            let mut payload =
                Vec::with_capacity(OPEN_FIXED_SIZE + service_bytes.len() + metadata.len());
            payload.extend_from_slice(&receive_window.to_be_bytes());
            payload.extend_from_slice(&service_len.to_be_bytes());
            payload.extend_from_slice(service_bytes);
            payload.extend_from_slice(metadata);
            (0x01, payload)
        }
        Frame::Data { data, .. } => {
            if data.len() > FRAME_MAX_DATA_SIZE {
                return Err(format!("DATA payload exceeds {FRAME_MAX_DATA_SIZE} bytes."));
            }
            (0x02, data.clone())
        }
        Frame::Window { credit_delta, .. } => {
            if *credit_delta == 0 {
                return Err("WINDOW credit must be a positive u32.".to_string());
            }
            (0x03, credit_delta.to_be_bytes().to_vec())
        }
        Frame::Fin { .. } => (0x04, Vec::new()),
        Frame::Reset { code, message, .. } => {
            if *code == 0 {
                return Err("RESET code must be a positive u16.".to_string());
            }
            let message = message.as_bytes();
            let mut payload = Vec::with_capacity(RESET_CODE_SIZE + message.len());
            payload.extend_from_slice(&code.to_be_bytes());
            payload.extend_from_slice(message);
            (0x05, payload)
        }
    };

    let body_len = FRAME_HEADER_SIZE
        .checked_add(payload.len())
        .ok_or_else(|| "Frame body length overflow.".to_string())?;
    if body_len > TRANSPORT_MAX_FRAME_SIZE {
        return Err(format!(
            "Frame payload exceeds {TRANSPORT_MAX_FRAME_SIZE} bytes."
        ));
    }
    let body_len_u32 =
        u32::try_from(body_len).map_err(|_| "Frame body exceeds u32 length.".to_string())?;
    let mut output = Vec::with_capacity(PACKET_HEADER_SIZE + body_len);
    output.extend_from_slice(&body_len_u32.to_be_bytes());
    output.push(FRAME_PROTOCOL_VERSION);
    output.push(frame_type);
    output.extend_from_slice(&stream_id.to_be_bytes());
    output.extend_from_slice(&payload);
    Ok(output)
}

pub fn decode_frame(packet: &[u8]) -> Result<Frame, String> {
    if packet.len() < PACKET_HEADER_SIZE {
        return Err("Frame packet header is incomplete.".to_string());
    }
    let body_len = read_u32(packet, 0)? as usize;
    if body_len > TRANSPORT_MAX_FRAME_SIZE {
        return Err(format!(
            "Frame payload exceeds {TRANSPORT_MAX_FRAME_SIZE} bytes."
        ));
    }
    if packet.len() != PACKET_HEADER_SIZE + body_len {
        return Err("Frame packet length does not match payload length.".to_string());
    }
    let body = &packet[PACKET_HEADER_SIZE..];
    if body.len() < FRAME_HEADER_SIZE {
        return Err("Frame header is incomplete.".to_string());
    }
    let version = body[0];
    if version != FRAME_PROTOCOL_VERSION {
        return Err(format!("Unsupported Frame protocol version {version}."));
    }
    let frame_type = body[1];
    let stream_id = read_u32(body, 2)?;
    if stream_id == 0 {
        return Err("Frame streamId must be a positive u32.".to_string());
    }
    let payload = &body[FRAME_HEADER_SIZE..];

    match frame_type {
        0x01 => decode_open(stream_id, payload),
        0x02 => {
            if payload.len() > FRAME_MAX_DATA_SIZE {
                return Err(format!("DATA payload exceeds {FRAME_MAX_DATA_SIZE} bytes."));
            }
            Ok(Frame::Data {
                stream_id,
                data: payload.to_vec(),
            })
        }
        0x03 => {
            if payload.len() != WINDOW_PAYLOAD_SIZE {
                return Err("WINDOW payload must be exactly 4 bytes.".to_string());
            }
            let credit_delta = read_u32(payload, 0)?;
            if credit_delta == 0 {
                return Err("WINDOW credit must be a positive u32.".to_string());
            }
            Ok(Frame::Window {
                stream_id,
                credit_delta,
            })
        }
        0x04 => {
            if !payload.is_empty() {
                return Err("FIN payload must be empty.".to_string());
            }
            Ok(Frame::Fin { stream_id })
        }
        0x05 => {
            if payload.len() < RESET_CODE_SIZE {
                return Err("RESET payload is incomplete.".to_string());
            }
            let code = read_u16(payload, 0)?;
            if code == 0 {
                return Err("RESET code must be a positive u16.".to_string());
            }
            let message = String::from_utf8(payload[RESET_CODE_SIZE..].to_vec())
                .map_err(|_| "RESET message must be valid UTF-8.".to_string())?;
            Ok(Frame::Reset {
                stream_id,
                code,
                message,
            })
        }
        _ => Err(format!("Unknown Frame type {frame_type}.")),
    }
}

fn decode_open(stream_id: u32, payload: &[u8]) -> Result<Frame, String> {
    if payload.len() < OPEN_FIXED_SIZE {
        return Err("OPEN payload is incomplete.".to_string());
    }
    let receive_window = read_u32(payload, 0)?;
    if receive_window == 0 {
        return Err("OPEN receive window must be a positive u32.".to_string());
    }
    let service_len = read_u16(payload, 4)? as usize;
    if service_len == 0 {
        return Err("OPEN service must not be empty.".to_string());
    }
    let service_end = OPEN_FIXED_SIZE
        .checked_add(service_len)
        .ok_or_else(|| "OPEN service length overflow.".to_string())?;
    if service_end > payload.len() {
        return Err("OPEN service length exceeds payload length.".to_string());
    }
    let service = String::from_utf8(payload[OPEN_FIXED_SIZE..service_end].to_vec())
        .map_err(|_| "OPEN service must be valid UTF-8.".to_string())?;
    Ok(Frame::Open {
        stream_id,
        receive_window,
        service,
        metadata: payload[service_end..].to_vec(),
    })
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16, String> {
    let end = offset
        .checked_add(2)
        .ok_or_else(|| "u16 offset overflow.".to_string())?;
    let source = bytes
        .get(offset..end)
        .ok_or_else(|| "u16 field is incomplete.".to_string())?;
    Ok(u16::from_be_bytes([source[0], source[1]]))
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, String> {
    let end = offset
        .checked_add(4)
        .ok_or_else(|| "u32 offset overflow.".to_string())?;
    let source = bytes
        .get(offset..end)
        .ok_or_else(|| "u32 field is incomplete.".to_string())?;
    Ok(u32::from_be_bytes([
        source[0], source[1], source[2], source[3],
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    #[test]
    fn matches_typescript_frame_v1_wire_vectors() {
        let vectors = [
            (
                Frame::Open {
                    stream_id: 1,
                    receive_window: 256,
                    service: "network.tcp".to_string(),
                    metadata: vec![0xaa, 0xbb],
                },
                "0000001901010000000100000100000b6e6574776f726b2e746370aabb",
            ),
            (
                Frame::Data {
                    stream_id: 2,
                    data: b"abc".to_vec(),
                },
                "00000009010200000002616263",
            ),
            (
                Frame::Window {
                    stream_id: 3,
                    credit_delta: 65_536,
                },
                "0000000a01030000000300010000",
            ),
            (Frame::Fin { stream_id: 4 }, "00000006010400000004"),
            (
                Frame::Reset {
                    stream_id: 5,
                    code: RESET_CANCELLED,
                    message: "stop".to_string(),
                },
                "0000000c010500000005000473746f70",
            ),
        ];

        for (frame, expected) in vectors {
            let encoded = encode_frame(&frame).expect("encode frame");
            assert_eq!(hex(&encoded), expected);
            assert_eq!(decode_frame(&encoded).expect("decode frame"), frame);
        }
    }

    #[test]
    fn decoder_restores_split_and_coalesced_frames() {
        let first = encode_frame(&Frame::Data {
            stream_id: 1,
            data: b"one".to_vec(),
        })
        .expect("encode first");
        let second = encode_frame(&Frame::Fin { stream_id: 1 }).expect("encode second");
        let mut joined = first.clone();
        joined.extend_from_slice(&second);
        let mut decoder = FrameDecoder::default();
        assert!(
            decoder
                .push(&joined[..3])
                .expect("partial header")
                .is_empty()
        );
        assert!(
            decoder
                .push(&joined[3..first.len() - 1])
                .expect("partial body")
                .is_empty()
        );
        assert_eq!(
            decoder.push(&joined[first.len() - 1..]).expect("finish"),
            vec![
                Frame::Data {
                    stream_id: 1,
                    data: b"one".to_vec(),
                },
                Frame::Fin { stream_id: 1 },
            ]
        );
        assert!(decoder.is_empty());
    }
}
