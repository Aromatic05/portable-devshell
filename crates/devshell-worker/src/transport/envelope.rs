use prost::Message;

use crate::transport::packet::{self, Packet, StreamPacket};
use crate::transport::wire::generated as wire;

pub const ENVELOPE_MAX_SIZE: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct Address {
    pub host: String,
    pub port: String,
}

#[derive(Clone, Debug)]
pub struct Envelope {
    pub source: Address,
    pub dest: Address,
    pub packet: Packet,
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
        while offset < self.buffer.len() {
            let data = &self.buffer[offset..];
            let Some((delimiter, length)) = decode_delimiter(data)? else {
                break;
            };
            if length > ENVELOPE_MAX_SIZE {
                return Err(format!("Envelope exceeds {ENVELOPE_MAX_SIZE} bytes."));
            }
            if data.len() < delimiter + length {
                break;
            }
            let decoded = wire::Envelope::decode(&data[delimiter..delimiter + length])
                .map_err(|error| format!("Envelope protobuf is invalid: {error}"))?;
            envelopes.push(from_wire(decoded)?);
            offset += delimiter + length;
        }
        if offset > 0 {
            self.buffer.drain(..offset);
        }
        Ok(envelopes)
    }
}

pub fn encode(envelope: &Envelope) -> Result<Vec<u8>, String> {
    let wire = to_wire(envelope)?;
    if wire.encoded_len() > ENVELOPE_MAX_SIZE {
        return Err(format!("Envelope exceeds {ENVELOPE_MAX_SIZE} bytes."));
    }
    Ok(wire.encode_length_delimited_to_vec())
}

fn to_wire(envelope: &Envelope) -> Result<wire::Envelope, String> {
    Ok(wire::Envelope {
        source: Some(to_wire_address(&envelope.source)),
        dest: Some(to_wire_address(&envelope.dest)),
        packet: Some(to_wire_packet(&envelope.packet)?),
    })
}

fn from_wire(envelope: wire::Envelope) -> Result<Envelope, String> {
    Ok(Envelope {
        source: from_wire_address(
            envelope
                .source
                .ok_or_else(|| "Envelope source is missing.".to_string())?,
            "source",
        )?,
        dest: from_wire_address(
            envelope
                .dest
                .ok_or_else(|| "Envelope dest is missing.".to_string())?,
            "dest",
        )?,
        packet: from_wire_packet(
            envelope
                .packet
                .ok_or_else(|| "Envelope packet is missing.".to_string())?,
        )?,
    })
}

fn to_wire_packet(packet: &Packet) -> Result<wire::Packet, String> {
    let value = match packet {
        Packet::Stream(StreamPacket::Data {
            id,
            seq,
            message,
            bytes: Some(bytes),
        }) => {
            if message.is_some() {
                return Err("Stream DATA cannot contain both bytes and message.".to_string());
            }
            wire::packet::Value::StreamData(wire::StreamData {
                id: id.clone(),
                seq: *seq,
                data: bytes.clone(),
            })
        }
        _ => wire::packet::Value::Json(
            serde_json::to_vec(&packet::to_json(packet)?).map_err(|error| error.to_string())?,
        ),
    };
    Ok(wire::Packet { value: Some(value) })
}

fn from_wire_packet(packet: wire::Packet) -> Result<Packet, String> {
    match packet
        .value
        .ok_or_else(|| "Envelope packet value is missing.".to_string())?
    {
        wire::packet::Value::Json(value) => {
            let value = serde_json::from_slice(&value).map_err(|error| error.to_string())?;
            packet::from_json(value)
        }
        wire::packet::Value::StreamData(value) => {
            if value.id.is_empty() {
                return Err("Stream id must be a non-empty string.".to_string());
            }
            Ok(Packet::Stream(StreamPacket::Data {
                id: value.id,
                seq: value.seq,
                message: None,
                bytes: Some(value.data),
            }))
        }
    }
}

fn to_wire_address(address: &Address) -> wire::Address {
    wire::Address {
        host: address.host.clone(),
        port: address.port.clone(),
    }
}

fn from_wire_address(address: wire::Address, name: &str) -> Result<Address, String> {
    if address.host.is_empty() {
        return Err(format!("Envelope {name}.host must be a non-empty string."));
    }
    if address.port.is_empty() {
        return Err(format!("Envelope {name}.port must be a non-empty string."));
    }
    Ok(Address {
        host: address.host,
        port: address.port,
    })
}

fn decode_delimiter(data: &[u8]) -> Result<Option<(usize, usize)>, String> {
    let delimiter = data
        .iter()
        .take(10)
        .position(|byte| byte & 0x80 == 0)
        .map(|index| index + 1);
    let Some(delimiter) = delimiter else {
        if data.len() < 10 {
            return Ok(None);
        }
        return Err("Envelope protobuf length delimiter is invalid.".to_string());
    };
    let length = prost::decode_length_delimiter(&data[..delimiter])
        .map_err(|error| format!("Envelope protobuf length is invalid: {error}"))?;
    Ok(Some((delimiter, length)))
}
