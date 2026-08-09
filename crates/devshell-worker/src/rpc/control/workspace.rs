use std::fs::OpenOptions;
use std::path::Path;
use std::sync::Arc;

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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspacePrepareResult {
    project_memory_agent_file: String,
    project_memory_directory: String,
    temporary_directory: String,
    workspace: String,
}

pub fn handler() -> Arc<dyn ControlHandler> {
    control_handler(|request| {
        let input: WorkspacePrepareInput = parse_params(request)?;
        serialize(prepare(Path::new(&input.workspace))?)
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

    let hash = format!("{:x}", Sha256::digest(workspace.as_os_str().as_encoded_bytes()));
    let project_memory_directory = devshell_home()
        .map_err(|error| RpcError::new("workspace.storageUnavailable", error))?
        .join("project-memory")
        .join(hash);
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

    let temporary_directory = tempfile::Builder::new()
        .prefix(&format!("{}-", temporary_prefix(&workspace)))
        .tempdir_in(std::env::temp_dir())
        .map_err(|error| RpcError::new("workspace.temporaryUnavailable", error.to_string()))?
        .keep();

    Ok(WorkspacePrepareResult {
        project_memory_agent_file: protocol_path(&project_memory_agent_file),
        project_memory_directory: protocol_path(&project_memory_directory),
        temporary_directory: protocol_path(&temporary_directory),
        workspace: protocol_path(&workspace),
    })
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
    use super::prepare;

    #[test]
    fn creates_stable_project_memory_and_unique_temporary_directories() {
        let workspace = crate::testing::temp_dir();
        let first = prepare(workspace.path()).unwrap();
        let second = prepare(workspace.path()).unwrap();

        assert_eq!(first.project_memory_directory, second.project_memory_directory);
        assert_ne!(first.temporary_directory, second.temporary_directory);
        assert!(std::path::Path::new(&first.project_memory_agent_file).is_file());
    }
}
