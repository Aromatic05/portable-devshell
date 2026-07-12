use std::io::{self, Read, Write};

use serde_json::Value;

use crate::rpc::error::RpcError;
use crate::rpc::request::RpcRequest;
use crate::rpc::response::RpcResponse;

pub const PROTOCOL_VERSION: u32 = 2;
pub const MAX_FRAME_SIZE: usize = 16 * 1024 * 1024;

pub fn encode_json<T: serde::Serialize>(value: &T) -> Result<Vec<u8>, String> {
    let payload = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    encode_payload(&payload)
}

pub fn encode_payload(payload: &[u8]) -> Result<Vec<u8>, String> {
    if payload.len() > MAX_FRAME_SIZE {
        return Err(format!("frame exceeds {} bytes", MAX_FRAME_SIZE));
    }

    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(payload);
    Ok(frame)
}

pub fn decode_json<T: serde::de::DeserializeOwned>(frame: &[u8]) -> Result<T, String> {
    let payload = decode_payload(frame)?;
    serde_json::from_slice(payload).map_err(|error| error.to_string())
}

pub fn decode_payload(frame: &[u8]) -> Result<&[u8], String> {
    if frame.len() < 4 {
        return Err("frame header is incomplete".to_string());
    }

    let length = u32::from_be_bytes(frame[..4].try_into().unwrap()) as usize;
    if length > MAX_FRAME_SIZE {
        return Err(format!("frame exceeds {} bytes", MAX_FRAME_SIZE));
    }
    if frame.len() != length + 4 {
        return Err("frame length does not match payload".to_string());
    }

    Ok(&frame[4..])
}

pub fn decode_request_frame(frame: &[u8]) -> Result<RpcRequest, RequestDecodeError> {
    let payload = decode_payload(frame).map_err(|message| RequestDecodeError {
        id: String::new(),
        error: RpcError::new("rpc.invalidRequest", message),
    })?;
    let value: Value = serde_json::from_slice(payload).map_err(|error| RequestDecodeError {
        id: String::new(),
        error: RpcError::new(
            "rpc.invalidRequest",
            format!("invalid rpc request json: {error}"),
        ),
    })?;
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let request: RpcRequest =
        serde_json::from_value(value).map_err(|error| RequestDecodeError {
            id,
            error: RpcError::new(
                "rpc.invalidRequest",
                format!("invalid rpc request: {error}"),
            ),
        })?;
    if request.message_type != "request" {
        return Err(RequestDecodeError {
            id: request.id,
            error: RpcError::new("rpc.invalidRequest", "invalid rpc request type"),
        });
    }
    Ok(request)
}

pub fn write_response(writer: &mut impl Write, response: &RpcResponse) -> Result<(), String> {
    let frame = encode_json(response)?;
    write_frame(writer, &frame)
}

pub fn write_request_frame(writer: &mut impl Write, request: &RpcRequest) -> Result<(), String> {
    let frame = encode_json(request)?;
    write_frame(writer, &frame)
}

pub fn read_response(reader: &mut impl Read) -> Result<Option<RpcResponse>, String> {
    let frame = match read_frame(reader) {
        Ok(Some(frame)) => frame,
        Ok(None) => return Ok(None),
        Err(error) => return Err(error),
    };
    let response = decode_json::<RpcResponse>(&frame)?;
    if response.message_type != "response" {
        return Err("invalid rpc response type".to_string());
    }
    Ok(Some(response))
}

pub fn read_frame(reader: &mut impl Read) -> Result<Option<Vec<u8>>, String> {
    let mut header = [0_u8; 4];
    match reader.read_exact(&mut header) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => {
            return Ok(None);
        }
        Err(error) => return Err(error.to_string()),
    }

    let length = u32::from_be_bytes(header) as usize;
    if length > MAX_FRAME_SIZE {
        return Err(format!("rpc.frameTooLarge:{length}"));
    }

    let mut payload = vec![0_u8; length];
    reader
        .read_exact(&mut payload)
        .map_err(|error| error.to_string())?;
    let mut frame = header.to_vec();
    frame.extend_from_slice(&payload);
    Ok(Some(frame))
}

pub struct RequestDecodeError {
    pub id: String,
    pub error: RpcError,
}

pub fn write_frame(writer: &mut impl Write, frame: &[u8]) -> Result<(), String> {
    writer.write_all(frame).map_err(io_error)?;
    writer.flush().map_err(io_error)
}

fn io_error(error: io::Error) -> String {
    error.to_string()
}
