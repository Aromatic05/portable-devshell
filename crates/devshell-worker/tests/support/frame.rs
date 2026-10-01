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
    instance: &str,
    port: &str,
    packet: &Value,
) -> io::Result<Value> {
    writer.write_all(&encode_open("envelope"))?;
    writer.flush()?;

    let envelope = serde_json::json!({
        "source": { "host": "test", "port": port },
        "dest": { "host": format!("{instance}-worker"), "port": port },
        "packet": packet,
    });
    let body = serde_json::to_vec(&envelope)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    let mut encoded = Vec::with_capacity(4 + body.len());
    encoded.extend_from_slice(&(body.len() as u32).to_be_bytes());
    encoded.extend_from_slice(&body);

    let expected_id = packet.get("id").and_then(Value::as_str);
    let mut send_credit = 0_u32;
    let mut incoming = VecDeque::new();
    let mut offset = 0_usize;
    while offset < encoded.len() {
        while send_credit == 0 {
            pump_transport(reader, &mut incoming, &mut send_credit)?;
        }
        let byte_len = FRAME_MAX_DATA_SIZE
            .min(send_credit as usize)
            .min(encoded.len() - offset);
        writer.write_all(&encode_frame(
            FRAME_DATA,
            RPC_STREAM_ID,
            &encoded[offset..offset + byte_len],
        ))?;
        writer.flush()?;
        send_credit -= byte_len as u32;
        offset += byte_len;
    }

    loop {
        while let Some(envelope) = try_read_envelope(&mut incoming)? {
            let packet = &envelope["packet"];
            if matches!(packet["type"].as_str(), Some("reply" | "error"))
                && expected_id.is_none_or(|id| packet["id"] == id)
            {
                return Ok(packet.clone());
            }
        }
        pump_transport(reader, &mut incoming, &mut send_credit)?;
    }
}

pub struct TransportEndpointWriter<W: Write> {
    inner: W,
    instance: String,
}

impl<W: Write> TransportEndpointWriter<W> {
    pub fn new(mut inner: W, instance: &str) -> io::Result<Self> {
        inner.write_all(&encode_open("envelope"))?;
        inner.flush()?;
        Ok(Self {
            inner,
            instance: instance.to_string(),
        })
    }

    pub fn send(&mut self, port: &str, packet: &Value) -> io::Result<()> {
        let envelope = serde_json::json!({
            "source": { "host": "test", "port": port },
            "dest": { "host": format!("{}-worker", self.instance), "port": port },
            "packet": packet,
        });
        let body = serde_json::to_vec(&envelope)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        let mut encoded = Vec::with_capacity(4 + body.len());
        encoded.extend_from_slice(&(body.len() as u32).to_be_bytes());
        encoded.extend_from_slice(&body);
        for chunk in encoded.chunks(FRAME_MAX_DATA_SIZE) {
            self.inner
                .write_all(&encode_frame(FRAME_DATA, RPC_STREAM_ID, chunk))?;
        }
        self.inner.flush()
    }
}

pub struct TransportEndpointReader<R: Read> {
    inner: R,
    buffered: VecDeque<u8>,
    finished: bool,
}

impl<R: Read> TransportEndpointReader<R> {
    pub fn new(inner: R) -> Self {
        Self {
            inner,
            buffered: VecDeque::new(),
            finished: false,
        }
    }

    pub fn wait_ready(&mut self) -> io::Result<()> {
        loop {
            let Some((frame_type, stream_id, payload)) = read_transport_frame(&mut self.inner)?
            else {
                self.finished = true;
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "transport closed before envelope stream received send credit",
                ));
            };
            if stream_id != RPC_STREAM_ID {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("unexpected transport stream {stream_id}"),
                ));
            }
            match frame_type {
                FRAME_WINDOW => return Ok(()),
                FRAME_DATA => self.buffered.extend(payload),
                FRAME_FIN => {
                    self.finished = true;
                    return Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "envelope stream finished before receiving send credit",
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
        }
    }

    pub fn read_packet(&mut self) -> io::Result<Value> {
        loop {
            if let Some(envelope) = try_read_envelope(&mut self.buffered)? {
                return Ok(envelope["packet"].clone());
            }
            self.fill()?;
            if self.finished && self.buffered.is_empty() {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "envelope stream closed before packet",
                ));
            }
        }
    }

    fn fill(&mut self) -> io::Result<()> {
        while !self.finished {
            let Some((frame_type, stream_id, payload)) = read_transport_frame(&mut self.inner)?
            else {
                self.finished = true;
                return Ok(());
            };
            if stream_id != RPC_STREAM_ID {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("unexpected transport stream {stream_id}"),
                ));
            }
            match frame_type {
                FRAME_DATA => {
                    self.buffered.extend(payload);
                    return Ok(());
                }
                FRAME_WINDOW => {}
                FRAME_FIN => {
                    self.finished = true;
                    return Ok(());
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
        }
        Ok(())
    }
}

impl<R: Read> Read for TransportEndpointReader<R> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if output.is_empty() {
            return Ok(0);
        }
        if self.buffered.is_empty() && !self.finished {
            self.fill()?;
        }
        let count = output.len().min(self.buffered.len());
        for slot in &mut output[..count] {
            *slot = self.buffered.pop_front().expect("buffered byte");
        }
        Ok(count)
    }
}

fn encode_open(service: &str) -> Vec<u8> {
    let service = service.as_bytes();
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

fn try_read_envelope(buffer: &mut VecDeque<u8>) -> io::Result<Option<Value>> {
    if buffer.len() < 4 {
        return Ok(None);
    }
    let header = buffer.make_contiguous();
    let payload_len = u32::from_be_bytes(header[..4].try_into().expect("Envelope length")) as usize;
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
        return "Endpoint transport reset".to_string();
    }
    let code = u16::from_be_bytes(payload[..2].try_into().expect("reset code"));
    let message = String::from_utf8_lossy(&payload[2..]);
    format!("Endpoint transport reset {code}: {message}")
}
