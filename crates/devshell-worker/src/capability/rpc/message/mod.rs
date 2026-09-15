pub mod codec;
pub mod path;

pub mod error {
    #[derive(Debug)]
    pub struct RpcError {
        pub code: String,
        pub message: String,
        pub retryable: bool,
        pub details: Option<serde_json::Value>,
    }

    impl RpcError {
        pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
            Self {
                code: code.into(),
                message: message.into(),
                retryable: false,
                details: None,
            }
        }

        pub fn with_details(mut self, details: serde_json::Value) -> Self {
            self.details = Some(details);
            self
        }
    }

    impl From<crate::tool::ToolError> for RpcError {
        fn from(error: crate::tool::ToolError) -> Self {
            Self {
                code: error.code,
                message: error.message,
                retryable: error.retryable,
                details: error.details,
            }
        }
    }
}

pub mod request {
    use serde::{Deserialize, Serialize};

    #[derive(Clone, Debug, Default, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct RpcRequestContext {
        pub request_id: Option<String>,
        pub operation_id: Option<String>,
        pub ctx_id: Option<String>,
        pub extension_id: Option<String>,
        pub source: Option<String>,
        pub workspace: Option<String>,
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
}

pub mod response {
    use serde::{Deserialize, Serialize};

    #[derive(Debug, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct RpcResponse {
        #[serde(rename = "type")]
        pub message_type: String,
        pub id: String,
        pub ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub result: Option<serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub error: Option<RpcErrorBody>,
    }

    #[derive(Debug, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct RpcErrorBody {
        pub code: String,
        pub message: String,
        pub retryable: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub details: Option<serde_json::Value>,
    }

    impl RpcResponse {
        pub fn success(id: impl Into<String>, result: serde_json::Value) -> Self {
            Self {
                message_type: "response".to_string(),
                id: id.into(),
                ok: true,
                result: Some(result),
                error: None,
            }
        }

        pub fn failure(
            id: impl Into<String>,
            error: crate::capability::rpc::error::RpcError,
        ) -> Self {
            Self {
                message_type: "response".to_string(),
                id: id.into(),
                ok: false,
                result: None,
                error: Some(RpcErrorBody {
                    code: error.code,
                    message: error.message,
                    retryable: error.retryable,
                    details: error.details,
                }),
            }
        }
    }
}
