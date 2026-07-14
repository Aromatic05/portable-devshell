use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcRequestContext {
    pub request_id: Option<String>,
    pub session_id: Option<String>,
    pub source: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcRequest {
    #[serde(rename = "type")]
    pub message_type: String,
    pub id: String,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
    #[serde(default)]
    pub context: Option<RpcRequestContext>,
}

impl RpcRequest {
    pub fn request(
        id: impl Into<String>,
        method: impl Into<String>,
        params: serde_json::Value,
    ) -> Self {
        Self {
            message_type: "request".to_string(),
            id: id.into(),
            method: method.into(),
            params,
            context: None,
        }
    }
}
