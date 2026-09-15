pub mod call;
pub mod session;

use std::sync::Arc;

use serde_json::json;

use crate::capability::rpc::router::{ControlHandler, control_handler, serialize};
use crate::tool::ToolRegistry;

pub fn list_handler(tools: Arc<ToolRegistry>) -> Arc<dyn ControlHandler> {
    control_handler(move |_| serialize(json!({ "tools": tools.catalog() })))
}
