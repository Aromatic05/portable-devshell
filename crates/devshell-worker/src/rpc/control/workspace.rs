use std::fs::OpenOptions;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::platform::protocol_path;
use crate::rpc::error::RpcError;
use crate::rpc::router::{ControlHandler, control_handler, parse_params, serialize};
use crate::storage::{devshell_home, permissions::{ensure_dir, ensure_file_mode}};

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
    temporary_directory: String,
    workspace: String,
}

const CONTEXT_TEMP_ROOT: &str = "context-tmp";
const CONTEXT_TEMP_TTL: Duration = Duration::from_secs(24 * 60 * 60);

pub fn prepare_handler() -> Arc<dyn ControlHandler> {
    control_handler(|request| {
        let input: WorkspacePrepareInput = parse_params(request)?;
        serialize(prepare(Path::new(&input.workspace))?)
    })
}

pub fn touch_temporary_handler() -> Arc<dyn ControlHandler> {
    control_handler(|request| {
        let input: WorkspaceTouchTemporaryInput = parse_params(request)?;
        touch_context_temporary_directory(Path::new(&input.temporary_directory))?;
        serialize(serde_json::json!({}))
    })
}

fn prepare(workspace: &Path) -> Result<WorkspacePrepareResult, RpcError> {
    let workspace = workspace.canonicalize().map_err(|error| {
        RpcError::new(
            "workspace.invalid",
            format!("failed to resolve workspace {}: {error}", workspace.display()),
        )
    })?;
    if !workspace.is_dir() {
        return Err(RpcError::new(
            "workspace.invalid",
            format!("workspace is not a directory: {}", workspace.display()),
        ));
    }

    let hash = project_memory_key(&workspace);
    let home = devshell_home()
        .map_err(|error| RpcError::new("workspace.storageUnavailable", error))?;
    let project_memory_directory = home.join("project-memory").join(hash);
    ensure_dir(&project_memory_directory, 0o700)
        .map_err(|error| RpcError::new("workspace.storageUnavailable", error))?;
    let project_memory_agent_file = project_memory_directory.join("AGENT.md");
    OpenOptions::new()
        .create(true)
        .write(true)
        .open(&project_memory_agent_file)
        .map_err(|error| RpcError::new("workspace.storageUnavailable", error.to_string()))?;
    ensure_file_mode(&project_memory_agent_file, 0o600)
        .map_err(|error| RpcError::new("workspace.storageUnavailable", error))?;

    let context_temp_root = home.join(CONTEXT_TEMP_ROOT);
    ensure_dir(&context_temp_root, 0o700)
        .map_err(|error| RpcError::new("workspace.temporaryUnavailable", error.to_string()))?;
    gc_stale_context_temp(&context_temp_root, CONTEXT_TEMP_TTL);

    let temporary_directory = tempfile::Builder::new()
        .prefix(&format!("{}-", temporary_prefix(&workspace)))
        .tempdir_in(&context_temp_root)
        .map_err(|error| RpcError::new("workspace.temporaryUnavailable", error.to_string()))?
        .keep();

    Ok(WorkspacePrepareResult {
        project_memory_agent_file: protocol_path(&project_memory_agent_file),
        project_memory_directory: protocol_path(&project_memory_directory),
        temporary_directory: protocol_path(&temporary_directory),
        workspace: protocol_path(&workspace),
    })
}

fn project_memory_key(workspace: &Path) -> String {
    let mut digest = Sha256::new();
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        digest.update(workspace.as_os_str().as_bytes());
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        for unit in workspace.as_os_str().encode_wide() {
            digest.update(unit.to_le_bytes());
        }
    }
    #[cfg(not(any(unix, windows)))]
    digest.update(protocol_path(workspace).as_bytes());
    format!("{:x}", digest.finalize())
}

fn touch_context_temporary_directory(path: &Path) -> Result<(), RpcError> {
    let root = devshell_home()
        .map_err(|error| RpcError::new("workspace.temporaryUnavailable", error))?
        .join(CONTEXT_TEMP_ROOT);
    ensure_dir(&root, 0o700)
        .map_err(|error| RpcError::new("workspace.temporaryUnavailable", error.to_string()))?;
    let root = root.canonicalize()
        .map_err(|error| RpcError::new("workspace.temporaryUnavailable", error.to_string()))?;
    let path = path.canonicalize()
        .map_err(|error| RpcError::new("workspace.temporaryUnavailable", error.to_string()))?;
    if path.strip_prefix(&root).is_err() {
        return Err(RpcError::new(
            "workspace.temporaryInvalid",
            format!("temporary directory is outside the managed context root: {}", path.display()),
        ));
    }
    touch_temporary_directory(&path)
}

fn touch_temporary_directory(path: &Path) -> Result<(), RpcError> {
    if !path.is_dir() {
        return Err(RpcError::new(
            "workspace.temporaryUnavailable",
            format!("temporary directory is unavailable: {}", path.display()),
        ));
    }
    filetime::set_file_mtime(
        path,
        filetime::FileTime::from_system_time(SystemTime::now()),
    )
        .map_err(|error| RpcError::new("workspace.temporaryUnavailable", error.to_string()))
}

fn gc_stale_context_temp(root: &Path, ttl: Duration) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let Ok(modified) = entry.metadata().and_then(|metadata| metadata.modified()) else {
            continue;
        };
        if now.duration_since(modified).is_ok_and(|age| age >= ttl) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

fn temporary_prefix(workspace: &Path) -> String {
    let name = workspace.file_name().and_then(|value| value.to_str()).unwrap_or("workspace");
    let sanitized: String = name.chars().filter_map(|character| {
        character.is_ascii_alphanumeric().then_some(character).or_else(|| (character == '-' || character == '_').then_some(character))
    }).take(48).collect();
    if sanitized.is_empty() { "workspace".to_string() } else { sanitized }
}

#[cfg(test)]
mod tests {
    use super::{gc_stale_context_temp, prepare, touch_temporary_directory, SystemTime};

    #[test]
    fn creates_stable_project_memory_and_unique_temporary_directories() {
        let workspace = crate::testing::temp_dir();
        let first = prepare(workspace.path()).unwrap();
        let second = prepare(workspace.path()).unwrap();

        assert_eq!(first.project_memory_directory, second.project_memory_directory);
        assert_ne!(first.temporary_directory, second.temporary_directory);
        assert!(std::path::Path::new(&first.project_memory_agent_file).is_file());
    }

    #[test]
    fn gc_removes_stale_context_temp_directories() {
        let root = crate::testing::temp_dir();
        let stale = root.path().join("stale-0001");
        let fresh = root.path().join("fresh-0002");
        std::fs::create_dir_all(&stale).unwrap();
        std::fs::create_dir_all(&fresh).unwrap();
        let stale_modified = SystemTime::now()
            .checked_sub(std::time::Duration::from_secs(2 * 60 * 60))
            .unwrap();
        filetime::set_file_mtime(&stale, filetime::FileTime::from_system_time(stale_modified)).unwrap();

        gc_stale_context_temp(root.path(), std::time::Duration::from_secs(60 * 60));

        assert!(!stale.exists());
        assert!(fresh.exists());
    }

    #[test]
    fn touching_an_active_context_temp_directory_prevents_gc() {
        let root = crate::testing::temp_dir();
        let active = root.path().join("active-0001");
        std::fs::create_dir_all(&active).unwrap();
        let old = SystemTime::now()
            .checked_sub(std::time::Duration::from_secs(2 * 60 * 60))
            .unwrap();
        filetime::set_file_mtime(&active, filetime::FileTime::from_system_time(old)).unwrap();

        touch_temporary_directory(&active).unwrap();
        gc_stale_context_temp(root.path(), std::time::Duration::from_secs(60 * 60));

        assert!(active.exists());
    }

    #[test]
    fn gc_leaves_non_directory_entries_alone() {
        let root = crate::testing::temp_dir();
        let stale_dir = root.path().join("stale-0001");
        let loose_file = root.path().join("loose.txt");
        std::fs::create_dir_all(&stale_dir).unwrap();
        std::fs::write(&loose_file, "not a directory").unwrap();
        let old = SystemTime::now()
            .checked_sub(std::time::Duration::from_secs(2 * 60 * 60))
            .unwrap();
        filetime::set_file_mtime(&stale_dir, filetime::FileTime::from_system_time(old)).unwrap();
        filetime::set_file_mtime(&loose_file, filetime::FileTime::from_system_time(old)).unwrap();

        gc_stale_context_temp(root.path(), std::time::Duration::from_secs(60 * 60));

        assert!(!stale_dir.exists());
        assert!(loose_file.exists());
    }
}
