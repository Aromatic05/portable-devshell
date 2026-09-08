use std::sync::Arc;

use serde::Deserialize;

use crate::platform::protocol_path;
use crate::rpc::error::RpcError;
use crate::rpc::router::{ControlHandler, control_handler, parse_params};
use crate::storage::{ExtensionResourceError, ExtensionResourceStore};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExtensionResourcePrepareInput {
    extension_id: String,
    collection: String,
}

pub fn prepare(store: Arc<ExtensionResourceStore>) -> Arc<dyn ControlHandler> {
    control_handler(move |request| {
        let input: ExtensionResourcePrepareInput = parse_params(request)?;
        let directory = store
            .prepare(&input.extension_id, &input.collection)
            .map_err(map_error)?;
        Ok(serde_json::json!({
            "directory": protocol_path(&directory)
        }))
    })
}

fn map_error(error: ExtensionResourceError) -> RpcError {
    match error {
        ExtensionResourceError::Invalid(message) => {
            RpcError::new("extension.resourceInvalid", message)
        }
        ExtensionResourceError::Storage(message) => {
            RpcError::new("extension.resourceFailed", message)
        }
    }
}
