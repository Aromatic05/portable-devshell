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

impl From<crate::tools::ToolError> for RpcError {
    fn from(error: crate::tools::ToolError) -> Self {
        Self {
            code: error.code,
            message: error.message,
            retryable: error.retryable,
            details: error.details,
        }
    }
}
