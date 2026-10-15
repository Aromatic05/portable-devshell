use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use sha2::{Digest, Sha256};

use crate::host::home::devshell_home;
use crate::instance::storage::ensure_dir;

#[derive(Debug)]
pub struct WorkspaceError {
    pub code: String,
    pub message: String,
}

impl WorkspaceError {
    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

#[derive(Debug)]
pub struct WorkspacePrepareResult {
    pub project_memory_agent_file: PathBuf,
    pub project_memory_directory: PathBuf,
    pub project_memory_present: bool,
    pub temporary_directory: PathBuf,
    pub workspace: PathBuf,
}

const CONTEXT_TEMP_ROOT: &str = "context-tmp";
const CONTEXT_TEMP_TTL: Duration = Duration::from_secs(24 * 60 * 60);

#[cfg(test)]
pub fn prepare(workspace: &Path) -> Result<WorkspacePrepareResult, WorkspaceError> {
    prepare_with_temporary_directory(workspace, None)
}

pub fn prepare_with_temporary_directory(
    workspace: &Path,
    previous_temporary_directory: Option<&Path>,
) -> Result<WorkspacePrepareResult, WorkspaceError> {
    if !workspace.is_absolute() {
        return Err(WorkspaceError::new(
            "workspace.invalid",
            "workspace must be an absolute path",
        ));
    }
    let workspace = workspace.canonicalize().map_err(|error| {
        WorkspaceError::new(
            "workspace.invalid",
            format!(
                "failed to resolve workspace {}: {error}",
                workspace.display()
            ),
        )
    })?;
    if !workspace.is_dir() {
        return Err(WorkspaceError::new(
            "workspace.invalid",
            format!("workspace is not a directory: {}", workspace.display()),
        ));
    }

    let project_memory_directory = workspace.join("var").join("agent-work");
    let project_memory_agent_file = project_memory_directory.join("INDEX.md");
    let project_memory_present = match project_memory_agent_file.metadata() {
        Ok(metadata) => metadata.is_file() && metadata.len() > 0,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => {
            return Err(WorkspaceError::new(
                "workspace.storageUnavailable",
                error.to_string(),
            ));
        }
    };

    let home = devshell_home()
        .map_err(|error| WorkspaceError::new("workspace.storageUnavailable", error))?;
    let context_temp_root = ensure_context_temp_root(&home)?;
    let workspace_temp_root = context_temp_workspace_path(&context_temp_root, &workspace);
    ensure_dir(&workspace_temp_root, 0o700)
        .map_err(|error| WorkspaceError::new("workspace.temporaryUnavailable", error))?;
    touch_temporary_directory(&workspace_temp_root)?;
    let temporary_directory =
        reuse_or_create_temporary_directory(&workspace_temp_root, previous_temporary_directory)?;
    gc_stale_context_temp(&context_temp_root, CONTEXT_TEMP_TTL);
    gc_stale_context_temp(&workspace_temp_root, CONTEXT_TEMP_TTL);

    Ok(WorkspacePrepareResult {
        project_memory_agent_file,
        project_memory_directory,
        project_memory_present,
        temporary_directory,
        workspace,
    })
}

fn reuse_or_create_temporary_directory(
    workspace_temp_root: &Path,
    previous: Option<&Path>,
) -> Result<PathBuf, WorkspaceError> {
    if let Some(previous) = previous {
        if previous.parent() != Some(workspace_temp_root)
            || !previous
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with("context-"))
        {
            return Err(WorkspaceError::new(
                "workspace.temporaryInvalid",
                "previous Context temporary directory is outside its Workspace",
            ));
        }
        match previous.canonicalize() {
            Ok(path) => {
                let canonical_root = workspace_temp_root.canonicalize().map_err(|error| {
                    WorkspaceError::new("workspace.temporaryUnavailable", error.to_string())
                })?;
                if path.parent() != Some(canonical_root.as_path()) {
                    return Err(WorkspaceError::new(
                        "workspace.temporaryInvalid",
                        "previous Context temporary directory belongs to another Workspace",
                    ));
                }
                touch_context_temporary_directory(&path)?;
                return Ok(previous.to_path_buf());
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(WorkspaceError::new(
                    "workspace.temporaryUnavailable",
                    error.to_string(),
                ));
            }
        }
    }
    tempfile::Builder::new()
        .prefix("context-")
        .tempdir_in(workspace_temp_root)
        .map(|directory| directory.keep())
        .map_err(|error| WorkspaceError::new("workspace.temporaryUnavailable", error.to_string()))
}

fn workspace_key(workspace: &Path) -> String {
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
    digest.update(workspace.to_string_lossy().as_bytes());
    format!("{:x}", digest.finalize())
}

pub fn context_temporary_workspace_directory(workspace: &Path) -> Result<PathBuf, WorkspaceError> {
    let workspace = workspace.canonicalize().map_err(|error| {
        WorkspaceError::new(
            "workspace.invalid",
            format!(
                "failed to resolve workspace {}: {error}",
                workspace.display()
            ),
        )
    })?;
    let home = devshell_home()
        .map_err(|error| WorkspaceError::new("workspace.temporaryUnavailable", error))?;
    let root = ensure_context_temp_root(&home)?;
    Ok(context_temp_workspace_path(&root, &workspace))
}

fn context_temp_workspace_path(root: &Path, workspace: &Path) -> PathBuf {
    let key = workspace_key(workspace);
    root.join(format!("{}-{}", temporary_prefix(workspace), &key[..16]))
}

pub fn touch_context_temporary_directory(path: &Path) -> Result<(), WorkspaceError> {
    let home = devshell_home()
        .map_err(|error| WorkspaceError::new("workspace.temporaryUnavailable", error))?;
    let root = ensure_context_temp_root(&home)?;
    let root = root.canonicalize().map_err(|error| {
        WorkspaceError::new("workspace.temporaryUnavailable", error.to_string())
    })?;
    let path = path.canonicalize().map_err(|error| {
        WorkspaceError::new("workspace.temporaryUnavailable", error.to_string())
    })?;
    if path.strip_prefix(&root).is_err() {
        return Err(WorkspaceError::new(
            "workspace.temporaryInvalid",
            format!(
                "temporary directory is outside the managed context root: {}",
                path.display()
            ),
        ));
    }
    touch_temporary_directory(&path)?;
    if let Some(parent) = path.parent() {
        touch_temporary_directory(parent)?;
    }
    Ok(())
}

fn touch_temporary_directory(path: &Path) -> Result<(), WorkspaceError> {
    if !path.is_dir() {
        return Err(WorkspaceError::new(
            "workspace.temporaryUnavailable",
            format!("temporary directory is unavailable: {}", path.display()),
        ));
    }
    filetime::set_file_mtime(
        path,
        filetime::FileTime::from_system_time(SystemTime::now()),
    )
    .map_err(|error| WorkspaceError::new("workspace.temporaryUnavailable", error.to_string()))
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

#[cfg(unix)]
fn ensure_context_temp_root(home: &Path) -> Result<PathBuf, WorkspaceError> {
    use std::os::unix::fs::symlink;

    ensure_dir(home, 0o700)
        .map_err(|error| WorkspaceError::new("workspace.temporaryUnavailable", error))?;
    let link = home.join(CONTEXT_TEMP_ROOT);
    let target = context_temp_target(home)?;

    if managed_link_points_to(&link, &target)? {
        return Ok(link);
    }
    remove_managed_context_temp_path(&link)?;
    match symlink(&target, &link) {
        Ok(()) => Ok(link),
        Err(error)
            if error.kind() == std::io::ErrorKind::AlreadyExists
                && managed_link_points_to(&link, &target)? =>
        {
            Ok(link)
        }
        Err(error) => Err(WorkspaceError::new(
            "workspace.temporaryUnavailable",
            format!(
                "failed to create managed temporary link {}: {error}",
                link.display()
            ),
        )),
    }
}

#[cfg(not(unix))]
fn ensure_context_temp_root(home: &Path) -> Result<PathBuf, WorkspaceError> {
    let root = home.join(CONTEXT_TEMP_ROOT);
    ensure_dir(&root, 0o700)
        .map_err(|error| WorkspaceError::new("workspace.temporaryUnavailable", error))?;
    Ok(root)
}

#[cfg(unix)]
fn context_temp_target(home: &Path) -> Result<PathBuf, WorkspaceError> {
    use std::os::unix::fs::MetadataExt;

    let owner = std::fs::metadata(home)
        .map_err(|error| WorkspaceError::new("workspace.temporaryUnavailable", error.to_string()))?
        .uid();
    #[cfg(target_os = "linux")]
    let base = linux_context_temp_base()?;
    #[cfg(not(target_os = "linux"))]
    let base = std::env::temp_dir();
    let parent = base.join(format!("devshell-worker-{owner}"));
    ensure_owned_runtime_directory(&parent, owner)?;
    let target = parent.join(CONTEXT_TEMP_ROOT);
    ensure_dir(&target, 0o700)
        .map_err(|error| WorkspaceError::new("workspace.temporaryUnavailable", error))?;
    Ok(target)
}

#[cfg(target_os = "linux")]
fn linux_context_temp_base() -> Result<PathBuf, WorkspaceError> {
    for candidate in [Path::new("/tmp"), Path::new("/dev/shm")] {
        if candidate.is_dir()
            && nix::sys::statfs::statfs(candidate)
                .is_ok_and(|status| status.filesystem_type() == nix::sys::statfs::TMPFS_MAGIC)
        {
            return Ok(candidate.to_path_buf());
        }
    }
    Err(WorkspaceError::new(
        "workspace.temporaryUnavailable",
        "neither /tmp nor /dev/shm provides tmpfs storage for Context temporary files",
    ))
}

#[cfg(unix)]
fn ensure_owned_runtime_directory(path: &Path, owner: u32) -> Result<(), WorkspaceError> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    match std::fs::create_dir(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let metadata = std::fs::symlink_metadata(path).map_err(|inspect_error| {
                WorkspaceError::new(
                    "workspace.temporaryUnavailable",
                    format!(
                        "failed to inspect runtime directory {}: {inspect_error}",
                        path.display()
                    ),
                )
            })?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() || metadata.uid() != owner {
                return Err(WorkspaceError::new(
                    "workspace.temporaryUnavailable",
                    format!(
                        "runtime directory is not a private directory owned by the worker user: {}",
                        path.display()
                    ),
                ));
            }
        }
        Err(error) => {
            return Err(WorkspaceError::new(
                "workspace.temporaryUnavailable",
                format!(
                    "failed to create runtime directory {}: {error}",
                    path.display()
                ),
            ));
        }
    }
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).map_err(|error| {
        WorkspaceError::new(
            "workspace.temporaryUnavailable",
            format!(
                "failed to secure runtime directory {}: {error}",
                path.display()
            ),
        )
    })
}

#[cfg(unix)]
fn managed_link_points_to(link: &Path, target: &Path) -> Result<bool, WorkspaceError> {
    let metadata = match std::fs::symlink_metadata(link) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(WorkspaceError::new(
                "workspace.temporaryUnavailable",
                format!(
                    "failed to inspect managed temporary path {}: {error}",
                    link.display()
                ),
            ));
        }
    };
    if !metadata.file_type().is_symlink() {
        return Ok(false);
    }
    std::fs::read_link(link)
        .map(|current| current == target)
        .map_err(|error| {
            WorkspaceError::new(
                "workspace.temporaryUnavailable",
                format!(
                    "failed to read managed temporary link {}: {error}",
                    link.display()
                ),
            )
        })
}

#[cfg(unix)]
fn remove_managed_context_temp_path(path: &Path) -> Result<(), WorkspaceError> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(WorkspaceError::new(
                "workspace.temporaryUnavailable",
                format!(
                    "failed to inspect managed temporary path {}: {error}",
                    path.display()
                ),
            ));
        }
    };
    let result = if metadata.is_dir() && !metadata.file_type().is_symlink() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    };
    match result {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(WorkspaceError::new(
            "workspace.temporaryUnavailable",
            format!(
                "failed to replace managed temporary path {}: {error}",
                path.display()
            ),
        )),
    }
}

fn temporary_prefix(workspace: &Path) -> String {
    let name = workspace
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("workspace");
    let sanitized: String = name
        .chars()
        .filter_map(|character| {
            character
                .is_ascii_alphanumeric()
                .then_some(character)
                .or_else(|| (character == '-' || character == '_').then_some(character))
        })
        .take(48)
        .collect();
    if sanitized.is_empty() {
        "workspace".to_string()
    } else {
        sanitized
    }
}

#[cfg(test)]
mod tests {
    use super::{
        SystemTime, gc_stale_context_temp, prepare, prepare_with_temporary_directory,
        touch_temporary_directory,
    };

    #[test]
    fn creates_stable_project_memory_and_unique_temporary_directories() {
        let workspace = crate::testing::temp_dir();
        let first = prepare(workspace.path()).unwrap();
        let second = prepare(workspace.path()).unwrap();

        assert_eq!(
            first.project_memory_directory,
            second.project_memory_directory
        );
        assert_ne!(first.temporary_directory, second.temporary_directory);
        assert!(!first.project_memory_present);

        let memory = workspace
            .path()
            .canonicalize()
            .unwrap()
            .join("var")
            .join("agent-work");
        std::fs::create_dir_all(&memory).unwrap();
        std::fs::write(memory.join("INDEX.md"), "# Agent work index\n").unwrap();
        let third = prepare(workspace.path()).unwrap();
        assert_eq!(third.project_memory_directory, memory);
        assert_eq!(third.project_memory_agent_file, memory.join("INDEX.md"));
        assert!(third.project_memory_present);
    }

    #[test]
    fn reuses_context_temporary_directory_on_repeated_workspace_prepare() {
        let workspace = crate::testing::temp_dir();
        let first = prepare(workspace.path()).unwrap();
        let repeated =
            prepare_with_temporary_directory(workspace.path(), Some(&first.temporary_directory))
                .unwrap();
        assert_eq!(first.temporary_directory, repeated.temporary_directory);
        assert!(repeated.temporary_directory.is_dir());

        let another = crate::testing::temp_dir();
        let invalid =
            prepare_with_temporary_directory(another.path(), Some(&first.temporary_directory))
                .unwrap_err();
        assert_eq!(invalid.code, "workspace.temporaryInvalid");

        std::fs::remove_dir(&first.temporary_directory).unwrap();
        let recovered =
            prepare_with_temporary_directory(workspace.path(), Some(&first.temporary_directory))
                .unwrap();
        assert_ne!(first.temporary_directory, recovered.temporary_directory);
    }

    #[test]
    fn groups_context_temporary_directories_by_workspace() {
        let first_workspace = crate::testing::temp_dir();
        let second_workspace = crate::testing::temp_dir();
        let first = prepare(first_workspace.path()).unwrap();
        let second = prepare(first_workspace.path()).unwrap();
        let other = prepare(second_workspace.path()).unwrap();

        assert_eq!(
            first.temporary_directory.parent(),
            second.temporary_directory.parent()
        );
        assert_ne!(
            first.temporary_directory.parent(),
            other.temporary_directory.parent()
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn context_temporary_storage_uses_tmpfs_outside_xdg_runtime() {
        let workspace = crate::testing::temp_dir();
        let prepared = prepare(workspace.path()).unwrap();
        let path = prepared.temporary_directory.canonicalize().unwrap();

        assert!(
            path.starts_with("/tmp/") || path.starts_with("/dev/shm/"),
            "unexpected context temporary path: {}",
            path.display()
        );
        assert_eq!(
            nix::sys::statfs::statfs(&path).unwrap().filesystem_type(),
            nix::sys::statfs::TMPFS_MAGIC
        );
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
        filetime::set_file_mtime(&stale, filetime::FileTime::from_system_time(stale_modified))
            .unwrap();

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
