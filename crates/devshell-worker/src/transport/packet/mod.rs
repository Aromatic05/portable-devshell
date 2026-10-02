pub mod stream;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug)]
pub enum Packet {
    Rpc(RpcPacket),
    Event,
    Stream(StreamPacket),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum RpcPacket {
    Request {
        id: String,
        method: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<Value>,
    },
    Reply {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<Value>,
    },
    Error {
        id: String,
        error: RpcError,
    },
    Cancel {
        id: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RpcError {
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct EventPacket {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum StreamPacket {
    Open {
        id: String,
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<Value>,
    },
    Data {
        id: String,
        seq: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<Value>,
    },
    Fin {
        id: String,
    },
    Close {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<Value>,
    },
    Cancel {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<StreamError>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct StreamError {
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,
}

pub fn decode(value: Value) -> Result<Packet, String> {
    let protocol = value
        .get("protocol")
        .and_then(Value::as_str)
        .ok_or_else(|| "Packet protocol is required.".to_string())?;
    match protocol {
        "rpc" => serde_json::from_value(value)
            .map(Packet::Rpc)
            .map_err(|error| error.to_string()),
        "event" => serde_json::from_value::<EventPacket>(value)
            .map(|_| Packet::Event)
            .map_err(|error| error.to_string()),
        "stream" => serde_json::from_value(value)
            .map(Packet::Stream)
            .map_err(|error| error.to_string()),
        _ => Err(format!("Unsupported Packet protocol {protocol}.")),
    }
}

pub fn encode<T: Serialize>(protocol: &str, packet: &T) -> Result<Value, String> {
    let Value::Object(mut value) = serde_json::to_value(packet).map_err(|error| error.to_string())?
    else {
        return Err("Packet must serialize to an object.".to_string());
    };
    value.insert("protocol".to_string(), Value::String(protocol.to_string()));
    Ok(Value::Object(value))
}

pub fn message_object(value: Option<Value>) -> Map<String, Value> {
    value
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}
