use std::sync::Arc;

use serde_json::json;

use crate::rpc::router::{ControlHandler, control_handler, serialize};
use crate::tools::ToolRegistry;

pub fn handler(tools: Arc<ToolRegistry>) -> Arc<dyn ControlHandler> {
    control_handler(move |_| serialize(json!({ "tools": tools.catalog() })))
}
