use crate::capability::rpc::error::RpcError;
use crate::instance::sandbox::SecurityPolicy;
use crate::instance::sandbox::path::{
    FilesystemCapability, PathNamespace, ResolvedPath, normalize_requested_path,
    parse_requested_path, resolve_existing_target,
};
use std::path::Path;

pub(super) fn resolve_cwd(
    workspace: &Path,
    policy: &dyn SecurityPolicy,
    value: Option<&str>,
) -> Result<ResolvedPath, RpcError> {
    if !workspace.is_absolute() {
        return Err(RpcError::new(
            "rpc.invalidContext",
            "terminal workspace must be an absolute path",
        ));
    }
    let raw = normalize_requested_path(value.unwrap_or("./"))?;
    let requested = parse_requested_path(&raw)?;
    let (read, write) = match requested.namespace {
        PathNamespace::Workspace => (
            FilesystemCapability::WorkspaceRead,
            FilesystemCapability::WorkspaceWrite,
        ),
        PathNamespace::Absolute => (
            FilesystemCapability::AbsoluteRead,
            FilesystemCapability::AbsoluteWrite,
        ),
    };
    policy
        .check_capability(read)
        .and_then(|_| policy.check_capability(write))
        .map_err(|error| RpcError {
            code: error.code,
            message: error.message,
            retryable: false,
            details: error.details,
        })?;
    let cwd = resolve_existing_target(workspace, &requested)?;
    if !cwd
        .metadata()
        .map_err(|error| {
            RpcError::new(
                "target.invalid",
                format!("Failed to inspect terminal working directory: {error}"),
            )
        })?
        .is_dir()
    {
        return Err(RpcError::new(
            "target.invalid",
            "Terminal working directory is not a directory.",
        ));
    }
    Ok(cwd)
}

#[cfg(all(test, windows))]
mod windows_cwd_tests {
    use crate::instance::sandbox::{SecurityMode, build_security_policy};

    use super::resolve_cwd;

    #[test]
    fn terminal_workspace_cwd_accepts_dot_backslash_syntax() {
        let workspace = crate::testing::temp_dir();
        let nested = workspace.path().join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        let policy = build_security_policy(SecurityMode::Disabled);

        let resolved = resolve_cwd(workspace.path(), policy.as_ref(), Some(".\\nested")).unwrap();

        assert_eq!(resolved.canonical, nested.canonicalize().unwrap());
    }
}
