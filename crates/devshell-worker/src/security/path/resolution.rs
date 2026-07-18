#[cfg(target_os = "linux")]
use std::os::fd::{AsRawFd, OwnedFd};
use std::path::{Path, PathBuf};
#[cfg(target_os = "linux")]
use std::sync::Arc;

use crate::security::path::{PathNamespace, RequestedPath};
use crate::tools::ToolError;

#[derive(Clone, Debug)]
pub struct ResolvedPath {
    pub canonical: PathBuf,
    access: PathBuf,
    target: PathBuf,
    #[cfg(target_os = "linux")]
    _anchors: Option<Arc<Vec<OwnedFd>>>,
}

impl ResolvedPath {
    pub fn access_path(&self) -> &Path {
        &self.access
    }

    pub fn target_path(&self) -> &Path {
        &self.target
    }

    pub fn join(&self, relative: &Path) -> Self {
        Self {
            canonical: self.canonical.join(relative),
            access: self.access.join(relative),
            target: self.target.join(relative),
            #[cfg(target_os = "linux")]
            _anchors: self._anchors.clone(),
        }
    }
}

pub fn resolve_existing_target(
    workspace: &Path,
    requested: &RequestedPath,
) -> Result<ResolvedPath, ToolError> {
    if requested.namespace == PathNamespace::Workspace {
        #[cfg(target_os = "linux")]
        {
            return resolve_workspace_existing(workspace, requested);
        }
    }

    let candidate = requested.path(workspace);
    let canonical = candidate.canonicalize().map_err(|error| {
        let code = if error.kind() == std::io::ErrorKind::NotFound {
            "file.notFound"
        } else {
            "file.writeFailed"
        };
        ToolError::new(
            code,
            format!("failed to resolve {}: {error}", candidate.display()),
        )
    })?;
    require_workspace_containment(workspace, requested.namespace, &canonical)?;
    Ok(plain(canonical))
}

pub fn resolve_create_target(
    workspace: &Path,
    requested: &RequestedPath,
) -> Result<ResolvedPath, ToolError> {
    let candidate = requested.path(workspace);
    if candidate.exists() || candidate.symlink_metadata().is_ok() {
        return resolve_existing_target(workspace, requested);
    }

    if requested.namespace == PathNamespace::Workspace {
        #[cfg(target_os = "linux")]
        {
            return resolve_workspace_create(workspace, requested);
        }
    }

    let mut ancestor = candidate.as_path();
    let mut tail = Vec::new();
    while ancestor.symlink_metadata().is_err() {
        let name = ancestor
            .file_name()
            .ok_or_else(|| ToolError::new("file.invalidPath", "path has no existing parent"))?;
        tail.push(name.to_owned());
        ancestor = ancestor
            .parent()
            .ok_or_else(|| ToolError::new("file.invalidPath", "path has no existing parent"))?;
    }
    let canonical_ancestor = ancestor
        .canonicalize()
        .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
    require_workspace_containment(workspace, requested.namespace, &canonical_ancestor)?;
    let canonical = tail
        .iter()
        .rev()
        .fold(canonical_ancestor, |path, segment| path.join(segment));
    Ok(plain(canonical))
}

fn plain(canonical: PathBuf) -> ResolvedPath {
    ResolvedPath {
        access: canonical.clone(),
        target: canonical.clone(),
        canonical,
        #[cfg(target_os = "linux")]
        _anchors: None,
    }
}

#[cfg(target_os = "linux")]
fn resolve_workspace_existing(
    workspace: &Path,
    requested: &RequestedPath,
) -> Result<ResolvedPath, ToolError> {
    use nix::fcntl::{OFlag, open, openat};
    use nix::sys::stat::Mode;

    let root = workspace
        .canonicalize()
        .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
    let root_fd = open(
        &root,
        OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW,
        Mode::empty(),
    )
    .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
    let segments = workspace_segments(requested)?;
    if segments.is_empty() {
        let access = descriptor_path(&root_fd);
        return Ok(ResolvedPath {
            canonical: root,
            target: access.clone(),
            access,
            _anchors: Some(Arc::new(vec![root_fd])),
        });
    }

    let mut anchors = vec![root_fd];
    for segment in &segments[..segments.len() - 1] {
        let current = anchors.last().expect("workspace root anchor exists");
        let next = openat(
            current,
            segment.as_os_str(),
            OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW,
            Mode::empty(),
        )
        .map_err(|error| map_resolution_error(error, requested))?;
        anchors.push(next);
    }
    let parent = anchors.last().expect("workspace parent anchor exists");
    let name = segments.last().expect("workspace target segment exists");
    let final_fd = openat(
        parent,
        name.as_os_str(),
        OFlag::O_RDONLY | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW,
        Mode::empty(),
    )
    .map_err(|error| map_resolution_error(error, requested))?;
    let access = descriptor_path(&final_fd);
    let target = descriptor_path(parent).join(name);
    anchors.push(final_fd);
    Ok(ResolvedPath {
        canonical: segments
            .iter()
            .fold(root, |path, segment| path.join(segment)),
        access,
        target,
        _anchors: Some(Arc::new(anchors)),
    })
}

#[cfg(target_os = "linux")]
fn resolve_workspace_create(
    workspace: &Path,
    requested: &RequestedPath,
) -> Result<ResolvedPath, ToolError> {
    use nix::fcntl::{OFlag, open, openat};
    use nix::sys::stat::Mode;

    let root = workspace
        .canonicalize()
        .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
    let segments = workspace_segments(requested)?;
    let (name, parents) = segments
        .split_last()
        .ok_or_else(|| ToolError::new("file.invalidPath", "workspace root cannot be created"))?;
    let root_fd = open(
        &root,
        OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW,
        Mode::empty(),
    )
    .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
    let mut anchors = vec![root_fd];
    for segment in parents {
        let current = anchors.last().expect("workspace root anchor exists");
        let next = openat(
            current,
            segment.as_os_str(),
            OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW,
            Mode::empty(),
        )
        .map_err(|error| map_resolution_error(error, requested))?;
        anchors.push(next);
    }
    let parent = anchors.last().expect("workspace parent anchor exists");
    let target = descriptor_path(parent).join(name);
    Ok(ResolvedPath {
        canonical: segments
            .iter()
            .fold(root, |path, segment| path.join(segment)),
        access: target.clone(),
        target,
        _anchors: Some(Arc::new(anchors)),
    })
}

#[cfg(target_os = "linux")]
fn workspace_segments(requested: &RequestedPath) -> Result<Vec<std::ffi::OsString>, ToolError> {
    let relative = requested
        .raw
        .strip_prefix("./")
        .ok_or_else(|| ToolError::new("file.invalidPath", "workspace path must start with ./"))?;
    if relative.is_empty() {
        return Ok(Vec::new());
    }
    Ok(Path::new(relative)
        .components()
        .map(|component| component.as_os_str().to_owned())
        .collect())
}

#[cfg(target_os = "linux")]
fn descriptor_path(fd: &OwnedFd) -> PathBuf {
    PathBuf::from("/proc/self/fd").join(fd.as_raw_fd().to_string())
}

#[cfg(target_os = "linux")]
fn map_resolution_error(error: nix::errno::Errno, requested: &RequestedPath) -> ToolError {
    let code = match error {
        nix::errno::Errno::ENOENT => "file.notFound",
        nix::errno::Errno::ELOOP => "file.pathEscapesWorkspace",
        _ => "file.writeFailed",
    };
    ToolError::new(
        code,
        format!(
            "failed to resolve {} without symbolic links: {error}",
            requested.raw
        ),
    )
}

fn require_workspace_containment(
    workspace: &Path,
    namespace: PathNamespace,
    target: &Path,
) -> Result<(), ToolError> {
    if namespace != PathNamespace::Workspace {
        return Ok(());
    }
    let root = workspace
        .canonicalize()
        .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
    if target.strip_prefix(&root).is_err() {
        return Err(ToolError::new(
            "file.pathEscapesWorkspace",
            format!("path escapes workspace: {}", target.display()),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;
    #[cfg(target_os = "linux")]
    use std::os::unix::fs::symlink;

    use tempfile::tempdir;

    use crate::security::path::parse_requested_path;

    use super::{resolve_create_target, resolve_existing_target};

    #[test]
    fn existing_workspace_path_resolves_inside_the_workspace() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("file.txt"), "inside").unwrap();
        let requested = parse_requested_path("./file.txt").unwrap();

        let resolved = resolve_existing_target(root.path(), &requested).unwrap();

        assert_eq!(
            fs::read_to_string(resolved.access_path()).unwrap(),
            "inside"
        );
        assert_eq!(
            resolved.canonical,
            root.path().canonicalize().unwrap().join("file.txt")
        );
    }

    #[test]
    fn create_workspace_path_resolves_inside_an_existing_parent() {
        let root = tempdir().unwrap();
        fs::create_dir(root.path().join("safe")).unwrap();
        let requested = parse_requested_path("./safe/new.txt").unwrap();

        let resolved = resolve_create_target(root.path(), &requested).unwrap();
        fs::write(resolved.target_path(), "inside").unwrap();

        assert_eq!(
            fs::read_to_string(root.path().join("safe/new.txt")).unwrap(),
            "inside"
        );
        assert_eq!(
            resolved.canonical,
            root.path().canonicalize().unwrap().join("safe/new.txt")
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn existing_workspace_path_remains_anchored_after_parent_swap() {
        let root = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::create_dir(root.path().join("safe")).unwrap();
        fs::write(root.path().join("safe/file.txt"), "inside").unwrap();
        fs::write(outside.path().join("file.txt"), "outside").unwrap();
        let requested = parse_requested_path("./safe/file.txt").unwrap();
        let resolved = resolve_existing_target(root.path(), &requested).unwrap();

        fs::rename(root.path().join("safe"), root.path().join("safe-old")).unwrap();
        symlink(outside.path(), root.path().join("safe")).unwrap();

        assert_eq!(
            fs::read_to_string(resolved.access_path()).unwrap(),
            "inside"
        );
        assert_ne!(
            fs::read_to_string(resolved.access_path()).unwrap(),
            "outside"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn create_workspace_path_remains_anchored_after_parent_swap() {
        let root = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::create_dir(root.path().join("safe")).unwrap();
        let requested = parse_requested_path("./safe/new.txt").unwrap();
        let resolved = resolve_create_target(root.path(), &requested).unwrap();

        fs::rename(root.path().join("safe"), root.path().join("safe-old")).unwrap();
        symlink(outside.path(), root.path().join("safe")).unwrap();
        fs::write(resolved.target_path(), "inside").unwrap();

        assert_eq!(
            fs::read_to_string(root.path().join("safe-old/new.txt")).unwrap(),
            "inside"
        );
        assert!(!outside.path().join("new.txt").exists());
    }
}
