pub mod cursor;
pub mod edit;
pub mod find;
pub mod info;
pub mod read;
pub mod search;
pub mod state;
pub mod structure;
pub mod types;
pub mod write;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::security::path::{
    FilesystemCapability, PathNamespace, RequestedPath, parse_requested_path,
    resolve_create_target, resolve_existing_target,
};
use crate::tools::{ToolCall, ToolError};

pub struct FileToolState {
    pub cursors: Mutex<cursor::CursorStore>,
    pub snapshots: Mutex<state::SnapshotStore>,
    write_locks: Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>,
}
impl FileToolState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            cursors: Mutex::new(cursor::CursorStore::default()),
            snapshots: Mutex::new(state::SnapshotStore::default()),
            write_locks: Mutex::new(HashMap::new()),
        })
    }

    pub fn write_lock(&self, path: &Path) -> Arc<Mutex<()>> {
        let mut locks = self.write_locks.lock().unwrap();
        locks
            .entry(path.to_path_buf())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }
}

pub fn resolve_existing(
    call: &ToolCall,
    raw: &str,
    write: bool,
) -> Result<(RequestedPath, std::path::PathBuf), ToolError> {
    let requested = parse_requested_path(raw)?;
    authorize(call, requested.namespace, write)?;
    let resolved = resolve_existing_target(&call.workspace, &requested)?;
    Ok((requested, resolved.canonical))
}
pub fn resolve_create(
    call: &ToolCall,
    raw: &str,
) -> Result<(RequestedPath, std::path::PathBuf), ToolError> {
    let requested = parse_requested_path(raw)?;
    authorize(call, requested.namespace, true)?;
    let resolved = resolve_create_target(&call.workspace, &requested)?;
    Ok((requested, resolved.canonical))
}

pub fn resolve_info(
    call: &ToolCall,
    raw: &str,
) -> Result<(RequestedPath, std::path::PathBuf), ToolError> {
    let requested = parse_requested_path(raw)?;
    authorize(call, requested.namespace, false)?;
    let path = requested.path(&call.workspace);
    std::fs::symlink_metadata(&path)
        .map_err(|error| ToolError::new("file.notFound", error.to_string()))?;

    if requested.namespace == PathNamespace::Workspace {
        if let Ok(target) = path.canonicalize() {
            let workspace = call
                .workspace
                .canonicalize()
                .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
            if target.strip_prefix(&workspace).is_err() {
                return Err(ToolError::new(
                    "file.pathEscapesWorkspace",
                    format!("path escapes workspace: {}", target.display()),
                ));
            }
        } else {
            let parent = path
                .parent()
                .ok_or_else(|| ToolError::new("file.invalidPath", "path has no parent"))?
                .canonicalize()
                .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
            let workspace = call
                .workspace
                .canonicalize()
                .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
            if parent.strip_prefix(&workspace).is_err() {
                return Err(ToolError::new(
                    "file.pathEscapesWorkspace",
                    format!("path escapes workspace: {}", parent.display()),
                ));
            }
        }
    }

    Ok((requested, path))
}
pub fn authorize(call: &ToolCall, namespace: PathNamespace, write: bool) -> Result<(), ToolError> {
    let capability = match (namespace, write) {
        (PathNamespace::Workspace, false) => FilesystemCapability::WorkspaceRead,
        (PathNamespace::Workspace, true) => FilesystemCapability::WorkspaceWrite,
        (PathNamespace::Absolute, false) => FilesystemCapability::AbsoluteRead,
        (PathNamespace::Absolute, true) => FilesystemCapability::AbsoluteWrite,
    };
    call.policy.check_capability(capability).map_err(|error| {
        ToolError::new(error.code, error.message)
            .with_details(error.details.unwrap_or(serde_json::Value::Null))
    })
}
