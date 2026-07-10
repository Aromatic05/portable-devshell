use std::path::{Path, PathBuf};

use crate::security::path::{PathNamespace, RequestedPath};
use crate::tools::ToolError;

#[derive(Clone, Debug)]
pub struct ResolvedPath {
    pub canonical: PathBuf,
    pub display_path: String,
    pub namespace: PathNamespace,
}

pub fn resolve_existing_target(workspace: &Path, requested: &RequestedPath) -> Result<ResolvedPath, ToolError> {
    let candidate = requested.path(workspace);
    let canonical = candidate.canonicalize().map_err(|error| {
        let code = if error.kind() == std::io::ErrorKind::NotFound { "file.notFound" } else { "file.writeFailed" };
        ToolError::new(code, format!("failed to resolve {}: {error}", candidate.display()))
    })?;
    require_workspace_containment(workspace, requested.namespace, &canonical)?;
    Ok(ResolvedPath { canonical, display_path: requested.raw.clone(), namespace: requested.namespace })
}

pub fn resolve_create_target(workspace: &Path, requested: &RequestedPath) -> Result<ResolvedPath, ToolError> {
    let candidate = requested.path(workspace);
    if candidate.exists() || candidate.symlink_metadata().is_ok() {
        return resolve_existing_target(workspace, requested);
    }
    let mut ancestor = candidate.as_path();
    let mut tail = Vec::new();
    while ancestor.symlink_metadata().is_err() {
        let name = ancestor.file_name().ok_or_else(|| ToolError::new("file.invalidPath", "path has no existing parent"))?;
        tail.push(name.to_owned());
        ancestor = ancestor.parent().ok_or_else(|| ToolError::new("file.invalidPath", "path has no existing parent"))?;
    }
    let canonical_ancestor = ancestor.canonicalize().map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
    require_workspace_containment(workspace, requested.namespace, &canonical_ancestor)?;
    let canonical = tail.iter().rev().fold(canonical_ancestor, |path, segment| path.join(segment));
    Ok(ResolvedPath { canonical, display_path: requested.raw.clone(), namespace: requested.namespace })
}

fn require_workspace_containment(workspace: &Path, namespace: PathNamespace, target: &Path) -> Result<(), ToolError> {
    if namespace != PathNamespace::Workspace { return Ok(()); }
    let root = workspace.canonicalize().map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
    if target.strip_prefix(&root).is_err() {
        return Err(ToolError::new("file.pathEscapesWorkspace", format!("path escapes workspace: {}", target.display())));
    }
    Ok(())
}
