use std::sync::Arc;

use serde_json::json;

use crate::rpc::router::{ControlHandler, control_handler};

pub fn handler() -> Arc<dyn ControlHandler> {
    control_handler(|_| Ok(json!({ "pong": true })))
}
