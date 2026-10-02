use std::collections::VecDeque;
use std::io::{self, Read, Write};

use serde_json::Value;

use crate::support::frame::{
    decode_reset_message, encode_frame, encode_open, read_transport_frame, try_read_envelope,
    FRAME_DATA, FRAME_FIN, FRAME_MAX_DATA_SIZE, FRAME_RESET, FRAME_WINDOW, RPC_STREAM_ID,
};

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
