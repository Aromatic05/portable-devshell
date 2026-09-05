pub mod context_patch;
mod context_patch_stream;
pub mod cursor;
pub mod diff;
pub mod discover;
pub mod edit;
pub mod find;
pub mod info;
pub mod publish;
pub mod read;
pub mod search;
pub mod state;
pub mod structure;
pub mod types;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};

use crate::security::path::{
    parse_requested_path, resolve_create_target, resolve_entry, resolve_existing_target,
    FilesystemCapability, PathNamespace, RequestedPath, ResolvedEntry, ResolvedPath,
};
use crate::tools::{ToolCall, ToolError};

pub struct FileToolState {
    pub find_cursors: Mutex<cursor::CursorStore<find::FindContinuation>>,
    pub search_cursors: Mutex<cursor::CursorStore<search::SearchContinuation>>,
    pub context_snapshots: Mutex<state::ContextSnapshotStore>,
    snapshot_ordinal: AtomicU64,
    write_locks: Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>,
}
impl FileToolState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            find_cursors: Mutex::new(cursor::CursorStore::default()),
            search_cursors: Mutex::new(cursor::CursorStore::default()),
            context_snapshots: Mutex::new(state::ContextSnapshotStore::default()),
            snapshot_ordinal: AtomicU64::new(1),
            write_locks: Mutex::new(HashMap::new()),
        })
    }

    pub fn next_snapshot_ordinal(&self) -> u64 {
        self.snapshot_ordinal.fetch_add(1, Ordering::Relaxed)
    }

    pub fn write_lock(&self, path: &Path) -> Arc<Mutex<()>> {
        let mut locks = self.write_locks.lock().unwrap();
        locks.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = locks.get(path).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(Mutex::new(()));
        locks.insert(path.to_path_buf(), Arc::downgrade(&lock));
        lock
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::FileToolState;

    #[test]
    fn write_lock_registry_reuses_live_locks_and_prunes_released_paths() {
        let state = FileToolState::new();
        let first = state.write_lock(std::path::Path::new("/workspace/a"));
        let same = state.write_lock(std::path::Path::new("/workspace/a"));
        assert!(Arc::ptr_eq(&first, &same));
        drop((first, same));

        for index in 0..100 {
            drop(state.write_lock(std::path::Path::new(&format!("/workspace/stale-{index}"))));
        }
        let live = state.write_lock(std::path::Path::new("/workspace/live"));
        assert_eq!(state.write_locks.lock().unwrap().len(), 1);
        assert!(Arc::strong_count(&live) >= 1);
    }
}

pub fn resolve_existing(
    call: &ToolCall,
    raw: &str,
    write: bool,
) -> Result<(RequestedPath, ResolvedPath), ToolError> {
    let requested = parse_requested_path(raw)?;
    authorize(call, requested.namespace, write)?;
    let resolved = resolve_existing_target(&call.workspace, &requested)?;
    Ok((requested, resolved))
}
pub fn resolve_create(
    call: &ToolCall,
    raw: &str,
) -> Result<(RequestedPath, ResolvedPath), ToolError> {
    let requested = parse_requested_path(raw)?;
    authorize(call, requested.namespace, true)?;
    let resolved = resolve_create_target(&call.workspace, &requested)?;
    Ok((requested, resolved))
}

pub fn resolve_info(
    call: &ToolCall,
    raw: &str,
) -> Result<(RequestedPath, ResolvedEntry), ToolError> {
    let requested = parse_requested_path(raw)?;
    authorize(call, requested.namespace, false)?;
    let entry = resolve_entry(&call.workspace, &requested)?;
    Ok((requested, entry))
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
