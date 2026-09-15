use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::capability::rpc::error::RpcError;
use crate::capability::rpc::path::protocol_path;
use crate::capability::rpc::router::{ControlHandler, control_handler, parse_params, serialize};
use crate::instance::workspace::prepare::{self, WorkspaceError};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspacePrepareInput {
    workspace: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspaceTouchTemporaryInput {
    temporary_directory: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspacePrepareResult {
    project_memory_agent_file: String,
    project_memory_directory: String,
    project_memory_present: bool,
    temporary_directory: String,
    workspace: String,
}

pub fn prepare_handler() -> Arc<dyn ControlHandler> {
    control_handler(|request| {
        let input: WorkspacePrepareInput = parse_params(request)?;
        let result = prepare::prepare(Path::new(&input.workspace)).map_err(rpc_error)?;
        serialize(WorkspacePrepareResult {
            project_memory_agent_file: protocol_path(&result.project_memory_agent_file),
            project_memory_directory: protocol_path(&result.project_memory_directory),
            project_memory_present: result.project_memory_present,
            temporary_directory: protocol_path(&result.temporary_directory),
            workspace: protocol_path(&result.workspace),
        })
    })
}

pub fn touch_temporary_handler() -> Arc<dyn ControlHandler> {
    control_handler(|request| {
        let input: WorkspaceTouchTemporaryInput = parse_params(request)?;
        prepare::touch_context_temporary_directory(Path::new(&input.temporary_directory))
            .map_err(rpc_error)?;
        serialize(serde_json::json!({}))
    })
}

fn rpc_error(error: WorkspaceError) -> RpcError {
    RpcError::new(error.code, error.message)
}
