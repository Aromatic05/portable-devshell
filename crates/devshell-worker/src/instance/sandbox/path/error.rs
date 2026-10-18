/// Errors from Sandbox path validation and resolution, independent of Tool RPC.
#[derive(Clone, Debug)]
pub struct PathError {
    pub code: String,
    pub message: String,
}

impl PathError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}
