pub mod edit;
pub mod find;
pub mod info;
pub mod read;
pub mod search;
pub mod state;
pub mod types;
pub mod write;

use std::sync::{Arc, Mutex};

use crate::security::path::{FilesystemCapability, PathNamespace, RequestedPath, parse_requested_path, resolve_create_target, resolve_existing_target};
use crate::tools::{ToolCall, ToolError};

pub struct FileToolState { pub snapshots: Mutex<state::SnapshotStore> }
impl FileToolState { pub fn new() -> Arc<Self> { Arc::new(Self { snapshots: Mutex::new(state::SnapshotStore::default()) }) } }

pub fn resolve_existing(call: &ToolCall, raw: &str, write: bool) -> Result<(RequestedPath, std::path::PathBuf), ToolError> {
    let requested = parse_requested_path(raw)?;
    authorize(call, requested.namespace, write)?;
    let resolved = resolve_existing_target(&call.workspace, &requested)?;
    Ok((requested, resolved.canonical))
}
pub fn resolve_create(call: &ToolCall, raw: &str) -> Result<(RequestedPath, std::path::PathBuf), ToolError> {
    let requested = parse_requested_path(raw)?;
    authorize(call, requested.namespace, true)?;
    let resolved = resolve_create_target(&call.workspace, &requested)?;
    Ok((requested, resolved.canonical))
}
pub fn authorize(call: &ToolCall, namespace: PathNamespace, write: bool) -> Result<(), ToolError> {
    let capability = match (namespace, write) {
        (PathNamespace::Workspace, false) => FilesystemCapability::WorkspaceRead,
        (PathNamespace::Workspace, true) => FilesystemCapability::WorkspaceWrite,
        (PathNamespace::Absolute, false) => FilesystemCapability::AbsoluteRead,
        (PathNamespace::Absolute, true) => FilesystemCapability::AbsoluteWrite,
    };
    call.policy.check_capability(capability).map_err(|error| ToolError::new(error.code, error.message).with_details(error.details.unwrap_or(serde_json::Value::Null)))
}
