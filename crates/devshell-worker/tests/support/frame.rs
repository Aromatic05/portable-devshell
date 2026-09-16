use std::collections::VecDeque;
use std::io::{self, Read, Write};

use serde_json::Value;

const FRAME_PROTOCOL_VERSION: u8 = 1;
const FRAME_OPEN: u8 = 1;
const FRAME_DATA: u8 = 2;
const FRAME_WINDOW: u8 = 3;
const FRAME_FIN: u8 = 4;
const FRAME_RESET: u8 = 5;
const RPC_STREAM_ID: u32 = 1;
const FRAME_MAX_DATA_SIZE: usize = 64 * 1024;
const TEST_RECEIVE_WINDOW: u32 = u32::MAX;

pub(super) fn exchange_rpc(
    writer: &mut impl Write,
    reader: &mut impl Read,
    payload: &[u8],
    expected_id: Option<&str>,
) -> io::Result<Value> {
    writer.write_all(&encode_open())?;
    writer.flush()?;

    let mut rpc = Vec::with_capacity(4 + payload.len());
    rpc.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    rpc.extend_from_slice(payload);

    let mut send_credit = 0_u32;
    let mut incoming = VecDeque::new();
    let mut offset = 0_usize;
    while offset < rpc.len() {
        while send_credit == 0 {
            pump_transport(reader, &mut incoming, &mut send_credit)?;
        }
        let byte_len = FRAME_MAX_DATA_SIZE
            .min(send_credit as usize)
            .min(rpc.len() - offset);
        writer.write_all(&encode_frame(
            FRAME_DATA,
            RPC_STREAM_ID,
            &rpc[offset..offset + byte_len],
        ))?;
        writer.flush()?;
        send_credit -= byte_len as u32;
        offset += byte_len;
    }

    loop {
        while let Some(frame) = try_read_rpc_frame(&mut incoming)? {
            if frame["type"] == "response" && expected_id.is_none_or(|id| frame["id"] == id) {
                return Ok(frame);
            }
        }
        pump_transport(reader, &mut incoming, &mut send_credit)?;
    }
}

#[allow(dead_code)]
pub struct TransportRpcWriter<W: Write> {
    inner: W,
}

#[allow(dead_code)]
impl<W: Write> TransportRpcWriter<W> {
    pub fn new(mut inner: W) -> io::Result<Self> {
        inner.write_all(&encode_open())?;
        inner.flush()?;
        Ok(Self { inner })
    }
}

impl<W: Write> Write for TransportRpcWriter<W> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        for chunk in buffer.chunks(FRAME_MAX_DATA_SIZE) {
            self.inner
                .write_all(&encode_frame(FRAME_DATA, RPC_STREAM_ID, chunk))?;
        }
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

#[allow(dead_code)]
pub struct TransportRpcReader<R: Read> {
    inner: R,
    buffered: VecDeque<u8>,
    finished: bool,
}

#[allow(dead_code)]
impl<R: Read> TransportRpcReader<R> {
    pub fn new(inner: R) -> Self {
        Self {
            inner,
            buffered: VecDeque::new(),
            finished: false,
        }
    }

    fn fill(&mut self) -> io::Result<()> {
        while self.buffered.is_empty() && !self.finished {
            let Some((frame_type, stream_id, payload)) = read_transport_frame(&mut self.inner)?
            else {
                self.finished = true;
                break;
            };
            if stream_id != RPC_STREAM_ID {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("unexpected transport stream {stream_id}"),
                ));
            }
            match frame_type {
                FRAME_DATA => self.buffered.extend(payload),
                FRAME_WINDOW => {}
                FRAME_FIN => self.finished = true,
                FRAME_RESET => {
                    return Err(io::Error::new(
                        io::ErrorKind::ConnectionReset,
                        decode_reset_message(&payload),
                    ));
                }
                other => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("unexpected transport frame type {other}"),
                    ));
                }
            }
        }
        Ok(())
    }
}

impl<R: Read> Read for TransportRpcReader<R> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if output.is_empty() {
            return Ok(0);
        }
        self.fill()?;
        let count = output.len().min(self.buffered.len());
        for slot in &mut output[..count] {
            *slot = self.buffered.pop_front().expect("buffered byte");
        }
        Ok(count)
    }
}

fn encode_open() -> Vec<u8> {
    let service = b"worker.rpc";
    let mut payload = Vec::with_capacity(6 + service.len());
    payload.extend_from_slice(&TEST_RECEIVE_WINDOW.to_be_bytes());
    payload.extend_from_slice(&(service.len() as u16).to_be_bytes());
    payload.extend_from_slice(service);
    encode_frame(FRAME_OPEN, RPC_STREAM_ID, &payload)
}

fn encode_frame(frame_type: u8, stream_id: u32, payload: &[u8]) -> Vec<u8> {
    let body_len = 6 + payload.len();
    let mut output = Vec::with_capacity(4 + body_len);
    output.extend_from_slice(&(body_len as u32).to_be_bytes());
    output.push(FRAME_PROTOCOL_VERSION);
    output.push(frame_type);
    output.extend_from_slice(&stream_id.to_be_bytes());
    output.extend_from_slice(payload);
    output
}

fn read_transport_frame(reader: &mut impl Read) -> io::Result<Option<(u8, u32, Vec<u8>)>> {
    let mut length = [0_u8; 4];
    match reader.read_exact(&mut length) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let body_len = u32::from_be_bytes(length) as usize;
    if body_len < 6 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "transport frame header is incomplete",
        ));
    }
    let mut body = vec![0_u8; body_len];
    reader.read_exact(&mut body)?;
    if body[0] != FRAME_PROTOCOL_VERSION {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unexpected transport frame version {}", body[0]),
        ));
    }
    let frame_type = body[1];
    let stream_id = u32::from_be_bytes(body[2..6].try_into().expect("stream id"));
    Ok(Some((frame_type, stream_id, body[6..].to_vec())))
}

fn pump_transport(
    reader: &mut impl Read,
    incoming: &mut VecDeque<u8>,
    send_credit: &mut u32,
) -> io::Result<()> {
    let Some((frame_type, stream_id, payload)) = read_transport_frame(reader)? else {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "transport closed before RPC response",
        ));
    };
    if stream_id != RPC_STREAM_ID {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unexpected transport stream {stream_id}"),
        ));
    }
    match frame_type {
        FRAME_DATA => incoming.extend(payload),
        FRAME_WINDOW => {
            if payload.len() != 4 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "invalid transport WINDOW payload",
                ));
            }
            let delta = u32::from_be_bytes(payload[..4].try_into().expect("window credit"));
            *send_credit = send_credit.checked_add(delta).ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "transport send credit overflow")
            })?;
        }
        FRAME_FIN => {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "worker.rpc stream finished before matching response",
            ));
        }
        FRAME_RESET => {
            return Err(io::Error::new(
                io::ErrorKind::ConnectionReset,
                decode_reset_message(&payload),
            ));
        }
        other => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("unexpected transport frame type {other}"),
            ));
        }
    }
    Ok(())
}

fn try_read_rpc_frame(buffer: &mut VecDeque<u8>) -> io::Result<Option<Value>> {
    if buffer.len() < 4 {
        return Ok(None);
    }
    let header = buffer.make_contiguous();
    let payload_len = u32::from_be_bytes(header[..4].try_into().expect("RPC length")) as usize;
    if buffer.len() < 4 + payload_len {
        return Ok(None);
    }
    buffer.drain(..4);
    let payload = buffer.drain(..payload_len).collect::<Vec<_>>();
    serde_json::from_slice(&payload)
        .map(Some)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

fn decode_reset_message(payload: &[u8]) -> String {
    if payload.len() < 2 {
        return "worker.rpc transport reset".to_string();
    }
    let code = u16::from_be_bytes(payload[..2].try_into().expect("reset code"));
    let message = String::from_utf8_lossy(&payload[2..]);
    format!("worker.rpc transport reset {code}: {message}")
}
