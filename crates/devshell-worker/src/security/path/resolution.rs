use std::ffi::OsString;
use std::fs::{self, File, Metadata};
use std::io;
#[cfg(target_os = "linux")]
use std::os::fd::{AsRawFd, OwnedFd};
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
use std::path::{Path, PathBuf};
use std::sync::Arc;
#[cfg(unix)]
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};

use cap_std::fs::{Dir as CapabilityDir, OpenOptions as CapabilityOpenOptions};
#[cfg(unix)]
use cap_std::fs::{MetadataExt as _, Permissions as CapabilityPermissions};
#[cfg(windows)]
use cap_std::ambient_authority;

use crate::security::path::{PathNamespace, RequestedPath};
use crate::tools::ToolError;

#[derive(Clone, Debug)]
enum AnchoredAccess {
    File(Arc<File>),
    Directory(Arc<CapabilityDir>),
    Relative {
        directory: Arc<CapabilityDir>,
        path: PathBuf,
    },
}

#[derive(Clone, Debug)]
struct AnchoredTarget {
    directory: Arc<CapabilityDir>,
    path: PathBuf,
}

#[derive(Clone, Debug)]
pub struct ResolvedMetadata {
    is_file: bool,
    is_dir: bool,
    is_symlink: bool,
    len: u64,
    modified_at_seconds: i64,
    #[cfg(unix)]
    mode: u32,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
}

impl ResolvedMetadata {
    pub fn is_file(&self) -> bool {
        self.is_file
    }

    pub fn is_dir(&self) -> bool {
        self.is_dir
    }

    pub fn is_symlink(&self) -> bool {
        self.is_symlink
    }

    pub fn len(&self) -> u64 {
        self.len
    }

    #[cfg(unix)]
    pub fn mode(&self) -> u32 {
        self.mode
    }

    pub fn modified_at_seconds(&self) -> i64 {
        self.modified_at_seconds
    }

    #[cfg(unix)]
    pub fn device_and_inode(&self) -> (u64, u64) {
        (self.device, self.inode)
    }

    fn from_std(metadata: Metadata) -> Self {
        let file_type = metadata.file_type();
        Self {
            is_file: metadata.is_file(),
            is_dir: metadata.is_dir(),
            is_symlink: file_type.is_symlink(),
            len: metadata.len(),
            modified_at_seconds: system_time_seconds(metadata.modified()),
            #[cfg(unix)]
            mode: metadata.mode(),
            #[cfg(unix)]
            device: metadata.dev(),
            #[cfg(unix)]
            inode: metadata.ino(),
        }
    }

    fn from_capability(metadata: cap_std::fs::Metadata) -> Self {
        let file_type = metadata.file_type();
        Self {
            is_file: metadata.is_file(),
            is_dir: metadata.is_dir(),
            is_symlink: file_type.is_symlink(),
            len: metadata.len(),
            modified_at_seconds: system_time_seconds(metadata.modified().map(|time| time.into_std())),
            #[cfg(unix)]
            mode: metadata.mode(),
            #[cfg(unix)]
            device: metadata.dev(),
            #[cfg(unix)]
            inode: metadata.ino(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct ResolvedDirectory {
    path: PathBuf,
    capability: Option<Arc<CapabilityDir>>,
}

impl ResolvedDirectory {
    pub fn metadata(&self, relative: &Path, follow_symlinks: bool) -> io::Result<ResolvedMetadata> {
        if let Some(directory) = &self.capability {
            let metadata = if relative.as_os_str().is_empty() {
                directory.dir_metadata()?
            } else if follow_symlinks {
                directory.metadata(relative)?
            } else {
                directory.symlink_metadata(relative)?
            };
            return Ok(ResolvedMetadata::from_capability(metadata));
        }

        let path = self.path.join(relative);
        let metadata = if relative.as_os_str().is_empty() || follow_symlinks {
            fs::metadata(path)?
        } else {
            fs::symlink_metadata(path)?
        };
        Ok(ResolvedMetadata::from_std(metadata))
    }

    pub fn entries(&self) -> io::Result<Vec<OsString>> {
        if let Some(directory) = &self.capability {
            return directory
                .entries()?
                .map(|entry| entry.map(|entry| entry.file_name()))
                .collect();
        }

        fs::read_dir(&self.path)?
            .map(|entry| entry.map(|entry| entry.file_name()))
            .collect()
    }

    pub fn open_file(&self, relative: &Path) -> io::Result<File> {
        if let Some(directory) = &self.capability {
            return directory.open(relative).map(|file| file.into_std());
        }
        File::open(self.path.join(relative))
    }

    pub fn open_directory(&self, relative: &Path) -> io::Result<Self> {
        if let Some(directory) = &self.capability {
            let opened = if relative.as_os_str().is_empty() {
                directory.try_clone()?
            } else {
                directory.open_dir(relative)?
            };
            return Ok(Self {
                path: self.path.join(relative),
                capability: Some(Arc::new(opened)),
            });
        }

        let path = self.path.join(relative);
        if !path.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::NotADirectory,
                "path is not a directory",
            ));
        }
        Ok(Self {
            path,
            capability: None,
        })
    }

    pub fn create_dir(&self, relative: &Path) -> io::Result<()> {
        if let Some(directory) = &self.capability {
            return directory.create_dir(relative);
        }
        fs::create_dir(self.path.join(relative))
    }

    pub fn create_dir_all(&self, relative: &Path) -> io::Result<()> {
        if let Some(directory) = &self.capability {
            return directory.create_dir_all(relative);
        }
        fs::create_dir_all(self.path.join(relative))
    }

    pub fn create_file_new(&self, relative: &Path) -> io::Result<File> {
        if let Some(directory) = &self.capability {
            let mut options = CapabilityOpenOptions::new();
            options.write(true).create_new(true);
            return directory
                .open_with(relative, &options)
                .map(|file| file.into_std());
        }
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(self.path.join(relative))
    }

    pub fn remove_file(&self, relative: &Path) -> io::Result<()> {
        if let Some(directory) = &self.capability {
            return directory.remove_file(relative);
        }
        fs::remove_file(self.path.join(relative))
    }

    pub fn remove_dir_all(&self, relative: &Path) -> io::Result<()> {
        if let Some(directory) = &self.capability {
            return directory.remove_dir_all(relative);
        }
        fs::remove_dir_all(self.path.join(relative))
    }

    pub fn rename(&self, source: &Path, target_directory: &Self, target: &Path) -> io::Result<()> {
        if let (Some(source_directory), Some(target_capability)) =
            (&self.capability, &target_directory.capability)
        {
            return source_directory.rename(source, target_capability, target);
        }
        fs::rename(self.path.join(source), target_directory.path.join(target))
    }

    pub fn hard_link(
        &self,
        source: &Path,
        target_directory: &Self,
        target: &Path,
    ) -> io::Result<()> {
        if let (Some(source_directory), Some(target_capability)) =
            (&self.capability, &target_directory.capability)
        {
            return source_directory.hard_link(source, target_capability, target);
        }
        fs::hard_link(self.path.join(source), target_directory.path.join(target))
    }

    pub fn set_permissions(&self, relative: &Path, mode: u32) -> io::Result<()> {
        #[cfg(unix)]
        if let Some(directory) = &self.capability {
            return directory.set_permissions(
                relative,
                CapabilityPermissions::from_std(fs::Permissions::from_mode(mode)),
            );
        }

        #[cfg(unix)]
        {
            return fs::set_permissions(self.path.join(relative), fs::Permissions::from_mode(mode));
        }
        #[cfg(not(unix))]
        {
            let _ = (relative, mode);
            Ok(())
        }
    }

    pub fn sync_all(&self) -> io::Result<()> {
        #[cfg(unix)]
        if let Some(directory) = &self.capability {
            use nix::fcntl::{OFlag, openat};
            use nix::sys::stat::Mode;

            let descriptor = openat(
                directory.as_ref(),
                Path::new("."),
                OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC,
                Mode::empty(),
            )
            .map_err(io::Error::from)?;
            return File::from(descriptor).sync_all();
        }
        #[cfg(windows)]
        {
            return Ok(());
        }
        #[cfg(not(windows))]
        File::open(&self.path)?.sync_all()
    }

    pub fn set_modified_time(&self, relative: &Path, seconds: i64) -> io::Result<()> {
        #[cfg(windows)]
        if let Some(directory) = &self.capability {
            let time = filetime::FileTime::from_unix_time(seconds, 0);
            let metadata = if relative.as_os_str().is_empty() {
                directory.dir_metadata()?
            } else {
                directory.metadata(relative)?
            };
            let handle = if metadata.is_dir() {
                if relative.as_os_str().is_empty() {
                    directory.try_clone()?.into_std_file()
                } else {
                    directory.open_dir(relative)?.into_std_file()
                }
            } else {
                directory.open(relative)?.into_std()
            };
            return filetime::set_file_handle_times(&handle, None, Some(time));
        }
        #[cfg(unix)]
        if let Some(directory) = &self.capability {
            let timestamp = if seconds >= 0 {
                UNIX_EPOCH + Duration::from_secs(seconds as u64)
            } else {
                UNIX_EPOCH - Duration::from_secs(seconds.unsigned_abs())
            };
            let start = directory.try_clone()?.into_std_file();
            return cap_primitives::fs::set_times(
                &start,
                relative,
                None,
                Some(cap_primitives::fs::SystemTimeSpec::Absolute(
                    cap_primitives::time::SystemTime::from_std(timestamp),
                )),
            );
        }

        let time = filetime::FileTime::from_unix_time(seconds, 0);
        filetime::set_file_mtime(self.path.join(relative), time)
    }
}

#[derive(Clone, Debug)]
pub struct ResolvedTarget {
    path: PathBuf,
    directory: ResolvedDirectory,
    relative: PathBuf,
    #[cfg(windows)]
    _anchor_guards: Arc<Vec<Arc<CapabilityDir>>>,
}

impl ResolvedTarget {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn is_anchored(&self) -> bool {
        #[cfg(unix)]
        {
            return self.directory.capability.is_some();
        }
        #[cfg(not(unix))]
        {
            false
        }
    }

    pub fn metadata(&self, follow_symlinks: bool) -> io::Result<Option<ResolvedMetadata>> {
        match self.directory.metadata(&self.relative, follow_symlinks) {
            Ok(metadata) => Ok(Some(metadata)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub fn open_file(&self) -> io::Result<File> {
        self.directory.open_file(&self.relative)
    }

    pub fn open_directory(&self) -> io::Result<ResolvedDirectory> {
        self.directory.open_directory(&self.relative)
    }

    pub fn create_file_new(&self) -> io::Result<File> {
        self.directory.create_file_new(&self.relative)
    }

    pub fn create_dir(&self) -> io::Result<()> {
        self.directory.create_dir(&self.relative)
    }

    pub fn remove(&self) -> io::Result<()> {
        let Some(metadata) = self.metadata(false)? else {
            return Ok(());
        };
        if metadata.is_dir() && !metadata.is_symlink() {
            self.directory.remove_dir_all(&self.relative)
        } else {
            self.directory.remove_file(&self.relative)
        }
    }

    pub fn rename_to(&self, target: &Self) -> io::Result<()> {
        self.directory
            .rename(&self.relative, &target.directory, &target.relative)
    }

    pub fn hard_link_to(&self, target: &Self) -> io::Result<()> {
        self.directory
            .hard_link(&self.relative, &target.directory, &target.relative)
    }

    pub fn sibling(&self, name: &str) -> io::Result<Self> {
        let relative = self
            .relative
            .parent()
            .map(|parent| parent.join(name))
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "target has no parent"))?;
        let path = self
            .path
            .parent()
            .map(|parent| parent.join(name))
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "target has no parent"))?;
        Ok(Self {
            path,
            directory: self.directory.clone(),
            relative,
            #[cfg(windows)]
            _anchor_guards: self._anchor_guards.clone(),
        })
    }

    pub fn sync_parent(&self) -> io::Result<()> {
        self.directory.sync_all()
    }

    pub fn set_permissions(&self, mode: u32) -> io::Result<()> {
        self.directory.set_permissions(&self.relative, mode)
    }
}

fn system_time_seconds(time: io::Result<SystemTime>) -> i64 {
    let Ok(time) = time else {
        return 0;
    };
    match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => i64::try_from(duration.as_secs()).unwrap_or(i64::MAX),
        Err(error) => -i64::try_from(error.duration().as_secs()).unwrap_or(i64::MAX),
    }
}

#[derive(Clone, Debug)]
pub struct ResolvedPath {
    pub canonical: PathBuf,
    access: PathBuf,
    target: PathBuf,
    anchored_access: Option<AnchoredAccess>,
    anchored_target: Option<AnchoredTarget>,
    #[cfg(windows)]
    _anchor_guards: Arc<Vec<Arc<CapabilityDir>>>,
}

impl ResolvedPath {
    pub fn access_path(&self) -> &Path {
        &self.access
    }

    pub fn metadata(&self) -> io::Result<ResolvedMetadata> {
        if let Some(access) = &self.anchored_access {
            return match access {
                AnchoredAccess::File(file) => {
                    file.try_clone()?.metadata().map(ResolvedMetadata::from_std)
                }
                AnchoredAccess::Directory(directory) => directory
                    .dir_metadata()
                    .map(ResolvedMetadata::from_capability),
                AnchoredAccess::Relative { directory, path } => directory
                    .metadata(path)
                    .map(ResolvedMetadata::from_capability),
            };
        }
        fs::metadata(&self.access).map(ResolvedMetadata::from_std)
    }

    pub fn open_file(&self) -> io::Result<File> {
        if let Some(access) = &self.anchored_access {
            return match access {
                AnchoredAccess::File(_) => {
                    let target = self.anchored_target.as_ref().ok_or_else(|| {
                        io::Error::new(
                            io::ErrorKind::InvalidInput,
                            "anchored file has no parent capability",
                        )
                    })?;
                    target
                        .directory
                        .open(&target.path)
                        .map(|file| file.into_std())
                }
                AnchoredAccess::Directory(_) => Err(io::Error::new(
                    io::ErrorKind::IsADirectory,
                    "path is a directory",
                )),
                AnchoredAccess::Relative { directory, path } => {
                    directory.open(path).map(|file| file.into_std())
                }
            };
        }
        File::open(&self.access)
    }

    pub fn open_directory(&self) -> io::Result<ResolvedDirectory> {
        if let Some(access) = &self.anchored_access {
            return match access {
                AnchoredAccess::File(_) => Err(io::Error::new(
                    io::ErrorKind::NotADirectory,
                    "path is not a directory",
                )),
                AnchoredAccess::Directory(directory) => Ok(ResolvedDirectory {
                    path: self.canonical.clone(),
                    capability: Some(directory.clone()),
                }),
                AnchoredAccess::Relative { directory, path } => Ok(ResolvedDirectory {
                    path: self.canonical.clone(),
                    capability: Some(Arc::new(directory.open_dir(path)?)),
                }),
            };
        }
        if !self.access.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::NotADirectory,
                "path is not a directory",
            ));
        }
        Ok(ResolvedDirectory {
            path: self.access.clone(),
            capability: None,
        })
    }

    pub fn target(&self) -> io::Result<ResolvedTarget> {
        if let Some(target) = &self.anchored_target {
            return Ok(ResolvedTarget {
                path: self.canonical.clone(),
                directory: ResolvedDirectory {
                    path: self
                        .canonical
                        .parent()
                        .unwrap_or(self.canonical.as_path())
                        .to_path_buf(),
                    capability: Some(target.directory.clone()),
                },
                relative: target.path.clone(),
                #[cfg(windows)]
                _anchor_guards: self._anchor_guards.clone(),
            });
        }

        let parent = self
            .target
            .parent()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "target has no parent"))?;
        let name = self.target.file_name().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "target has no file name")
        })?;
        Ok(ResolvedTarget {
            path: self.canonical.clone(),
            directory: ResolvedDirectory {
                path: parent.to_path_buf(),
                capability: None,
            },
            relative: PathBuf::from(name),
            #[cfg(windows)]
            _anchor_guards: self._anchor_guards.clone(),
        })
    }

    #[cfg(unix)]
    pub fn cloned_directory_file(&self) -> io::Result<Option<File>> {
        let Some(access) = &self.anchored_access else {
            return Ok(None);
        };
        match access {
            AnchoredAccess::Directory(directory) => {
                Ok(Some(directory.try_clone()?.into_std_file()))
            }
            AnchoredAccess::Relative { directory, path } => {
                Ok(Some(directory.open_dir(path)?.into_std_file()))
            }
            AnchoredAccess::File(_) => Ok(None),
        }
    }

    pub fn join(&self, relative: &Path) -> Self {
        let (anchored_access, anchored_target) = match &self.anchored_access {
            Some(AnchoredAccess::Directory(directory)) => (
                Some(AnchoredAccess::Relative {
                    directory: directory.clone(),
                    path: relative.to_path_buf(),
                }),
                Some(AnchoredTarget {
                    directory: directory.clone(),
                    path: relative.to_path_buf(),
                }),
            ),
            Some(AnchoredAccess::Relative { directory, path }) => {
                let joined = path.join(relative);
                (
                    Some(AnchoredAccess::Relative {
                        directory: directory.clone(),
                        path: joined.clone(),
                    }),
                    Some(AnchoredTarget {
                        directory: directory.clone(),
                        path: joined,
                    }),
                )
            }
            _ => (None, None),
        };

        Self {
            canonical: self.canonical.join(relative),
            access: self.access.join(relative),
            target: self.target.join(relative),
            anchored_access,
            anchored_target,
            #[cfg(windows)]
            _anchor_guards: self._anchor_guards.clone(),
        }
    }
}

pub fn resolve_existing_target(
    workspace: &Path,
    requested: &RequestedPath,
) -> Result<ResolvedPath, ToolError> {
    if requested.namespace == PathNamespace::Workspace {
        #[cfg(any(unix, windows))]
        {
            return resolve_workspace_existing(workspace, requested);
        }
    }

    let candidate = requested.path(workspace);
    let canonical = candidate.canonicalize().map_err(|error| {
        let code = if error.kind() == io::ErrorKind::NotFound {
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
        #[cfg(any(unix, windows))]
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
        anchored_access: None,
        anchored_target: None,
        #[cfg(windows)]
        _anchor_guards: Arc::new(Vec::new()),
    }
}

#[cfg(unix)]
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
        #[cfg(target_os = "linux")]
        let access = descriptor_path(&root_fd);
        #[cfg(not(target_os = "linux"))]
        let access = root.clone();
        let directory = Arc::new(CapabilityDir::from_std_file(File::from(root_fd)));
        return Ok(ResolvedPath {
            canonical: root,
            target: access.clone(),
            access,
            anchored_access: Some(AnchoredAccess::Directory(directory)),
            anchored_target: None,
        });
    }

    let mut parent_fd = root_fd;
    for segment in &segments[..segments.len() - 1] {
        parent_fd = openat(
            &parent_fd,
            segment.as_os_str(),
            OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW,
            Mode::empty(),
        )
        .map_err(|error| map_resolution_error(error, requested))?;
    }
    let name = segments.last().expect("workspace target segment exists");
    let final_fd = openat(
        &parent_fd,
        name.as_os_str(),
        OFlag::O_RDONLY | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW,
        Mode::empty(),
    )
    .map_err(|error| map_resolution_error(error, requested))?;
    let canonical = segments
        .iter()
        .fold(root, |path, segment| path.join(segment));
    #[cfg(target_os = "linux")]
    let access = descriptor_path(&final_fd);
    #[cfg(not(target_os = "linux"))]
    let access = canonical.clone();
    #[cfg(target_os = "linux")]
    let target = descriptor_path(&parent_fd).join(name);
    #[cfg(not(target_os = "linux"))]
    let target = canonical.clone();

    let parent_directory = Arc::new(CapabilityDir::from_std_file(File::from(parent_fd)));
    let final_file = File::from(final_fd);
    let anchored_access = if final_file
        .metadata()
        .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?
        .is_dir()
    {
        AnchoredAccess::Directory(Arc::new(CapabilityDir::from_std_file(final_file)))
    } else {
        AnchoredAccess::File(Arc::new(final_file))
    };
    Ok(ResolvedPath {
        canonical,
        access,
        target,
        anchored_access: Some(anchored_access),
        anchored_target: Some(AnchoredTarget {
            directory: parent_directory,
            path: PathBuf::from(name),
        }),
    })
}

#[cfg(unix)]
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
    let mut parent_fd = open(
        &root,
        OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW,
        Mode::empty(),
    )
    .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
    for segment in parents {
        parent_fd = openat(
            &parent_fd,
            segment.as_os_str(),
            OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW,
            Mode::empty(),
        )
        .map_err(|error| map_resolution_error(error, requested))?;
    }
    let canonical = segments
        .iter()
        .fold(root, |path, segment| path.join(segment));
    #[cfg(target_os = "linux")]
    let target = descriptor_path(&parent_fd).join(name);
    #[cfg(not(target_os = "linux"))]
    let target = canonical.clone();
    let parent_directory = Arc::new(CapabilityDir::from_std_file(File::from(parent_fd)));
    Ok(ResolvedPath {
        canonical: canonical.clone(),
        access: target.clone(),
        target,
        anchored_access: None,
        anchored_target: Some(AnchoredTarget {
            directory: parent_directory,
            path: PathBuf::from(name),
        }),
    })
}

#[cfg(windows)]
fn resolve_workspace_existing(
    workspace: &Path,
    requested: &RequestedPath,
) -> Result<ResolvedPath, ToolError> {
    let root = workspace
        .canonicalize()
        .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
    let segments = workspace_segments(requested)?;
    let root_directory = Arc::new(
        CapabilityDir::open_ambient_dir(&root, ambient_authority())
            .map_err(|error| map_capability_resolution_error(error, requested))?,
    );
    let mut guards = vec![root_directory.clone()];
    let mut parent = root_directory;
    if segments.is_empty() {
        return Ok(ResolvedPath {
            canonical: root.clone(),
            target: root.clone(),
            access: root,
            anchored_access: Some(AnchoredAccess::Directory(parent)),
            anchored_target: None,
            _anchor_guards: Arc::new(guards),
        });
    }

    for segment in &segments[..segments.len() - 1] {
        reject_workspace_symlink(&parent, segment, requested)?;
        let next = Arc::new(
            parent
                .open_dir(segment)
                .map_err(|error| map_capability_resolution_error(error, requested))?,
        );
        guards.push(next.clone());
        parent = next;
    }
    let name = segments.last().expect("workspace target segment exists");
    reject_workspace_symlink(&parent, name, requested)?;
    let metadata = parent
        .metadata(name)
        .map_err(|error| map_capability_resolution_error(error, requested))?;
    let canonical = segments
        .iter()
        .fold(root, |path, segment| path.join(segment));
    let parent_directory = parent;
    let anchored_access = if metadata.is_dir() {
        let directory = Arc::new(
            parent_directory
                .open_dir(name)
                .map_err(|error| map_capability_resolution_error(error, requested))?,
        );
        guards.push(directory.clone());
        AnchoredAccess::Directory(directory)
    } else {
        AnchoredAccess::File(Arc::new(
            parent_directory
                .open(name)
                .map_err(|error| map_capability_resolution_error(error, requested))?
                .into_std(),
        ))
    };
    Ok(ResolvedPath {
        canonical: canonical.clone(),
        access: canonical.clone(),
        target: canonical,
        anchored_access: Some(anchored_access),
        anchored_target: Some(AnchoredTarget {
            directory: parent_directory,
            path: PathBuf::from(name),
        }),
        _anchor_guards: Arc::new(guards),
    })
}

#[cfg(windows)]
fn resolve_workspace_create(
    workspace: &Path,
    requested: &RequestedPath,
) -> Result<ResolvedPath, ToolError> {
    let root = workspace
        .canonicalize()
        .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
    let segments = workspace_segments(requested)?;
    let (name, parents) = segments
        .split_last()
        .ok_or_else(|| ToolError::new("file.invalidPath", "workspace root cannot be created"))?;
    let root_directory = Arc::new(
        CapabilityDir::open_ambient_dir(&root, ambient_authority())
            .map_err(|error| map_capability_resolution_error(error, requested))?,
    );
    let mut guards = vec![root_directory.clone()];
    let mut parent = root_directory;
    for segment in parents {
        reject_workspace_symlink(&parent, segment, requested)?;
        let next = Arc::new(
            parent
                .open_dir(segment)
                .map_err(|error| map_capability_resolution_error(error, requested))?,
        );
        guards.push(next.clone());
        parent = next;
    }
    let canonical = segments
        .iter()
        .fold(root, |path, segment| path.join(segment));
    Ok(ResolvedPath {
        canonical: canonical.clone(),
        access: canonical.clone(),
        target: canonical,
        anchored_access: None,
        anchored_target: Some(AnchoredTarget {
            directory: parent,
            path: PathBuf::from(name),
        }),
        _anchor_guards: Arc::new(guards),
    })
}

#[cfg(windows)]
fn reject_workspace_symlink(
    directory: &CapabilityDir,
    path: &Path,
    requested: &RequestedPath,
) -> Result<(), ToolError> {
    let metadata = directory
        .symlink_metadata(path)
        .map_err(|error| map_capability_resolution_error(error, requested))?;
    if metadata.file_type().is_symlink() {
        return Err(ToolError::new(
            "file.pathEscapesWorkspace",
            format!("workspace path contains a symbolic link or reparse point: {}", requested.raw),
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn map_capability_resolution_error(error: io::Error, requested: &RequestedPath) -> ToolError {
    let code = if error.kind() == io::ErrorKind::NotFound {
        "file.notFound"
    } else {
        "file.writeFailed"
    };
    ToolError::new(
        code,
        format!("failed to resolve {} within workspace: {error}", requested.raw),
    )
}

#[cfg(any(unix, windows))]
fn workspace_segments(requested: &RequestedPath) -> Result<Vec<OsString>, ToolError> {
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

#[cfg(unix)]
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
    use std::io::{Read as _, Write as _};
    #[cfg(unix)]
    use std::os::unix::fs::symlink;

    use crate::security::path::parse_requested_path;

    use super::{resolve_create_target, resolve_existing_target};

    #[test]
    fn existing_workspace_path_resolves_inside_the_workspace() {
        let root = crate::testing::temp_dir();
        fs::write(root.path().join("file.txt"), "inside").unwrap();
        let requested = parse_requested_path("./file.txt").unwrap();

        let resolved = resolve_existing_target(root.path(), &requested).unwrap();
        let mut content = String::new();
        resolved
            .open_file()
            .unwrap()
            .read_to_string(&mut content)
            .unwrap();

        assert_eq!(content, "inside");
        assert_eq!(
            resolved.canonical,
            root.path().canonicalize().unwrap().join("file.txt")
        );
    }

    #[test]
    fn create_workspace_path_resolves_inside_an_existing_parent() {
        let root = crate::testing::temp_dir();
        fs::create_dir(root.path().join("safe")).unwrap();
        let requested = parse_requested_path("./safe/new.txt").unwrap();

        let resolved = resolve_create_target(root.path(), &requested).unwrap();
        resolved
            .target()
            .unwrap()
            .create_file_new()
            .unwrap()
            .write_all(b"inside")
            .unwrap();

        assert_eq!(
            fs::read_to_string(root.path().join("safe/new.txt")).unwrap(),
            "inside"
        );
        assert_eq!(
            resolved.canonical,
            root.path().canonicalize().unwrap().join("safe/new.txt")
        );
    }

    #[cfg(unix)]
    #[test]
    fn existing_workspace_path_remains_anchored_after_parent_replacement() {
        let root = crate::testing::temp_dir();
        fs::create_dir(root.path().join("safe")).unwrap();
        fs::write(root.path().join("safe/file.txt"), "inside").unwrap();
        let requested = parse_requested_path("./safe/file.txt").unwrap();
        let resolved = resolve_existing_target(root.path(), &requested).unwrap();

        fs::rename(root.path().join("safe"), root.path().join("safe-old")).unwrap();
        fs::create_dir(root.path().join("safe")).unwrap();
        fs::write(root.path().join("safe/file.txt"), "replacement").unwrap();

        let mut content = String::new();
        resolved
            .open_file()
            .unwrap()
            .read_to_string(&mut content)
            .unwrap();
        assert_eq!(content, "inside");
    }

    #[cfg(unix)]
    #[test]
    fn create_workspace_path_remains_anchored_after_parent_replacement() {
        let root = crate::testing::temp_dir();
        fs::create_dir(root.path().join("safe")).unwrap();
        let requested = parse_requested_path("./safe/new.txt").unwrap();
        let resolved = resolve_create_target(root.path(), &requested).unwrap();

        fs::rename(root.path().join("safe"), root.path().join("safe-old")).unwrap();
        fs::create_dir(root.path().join("safe")).unwrap();
        resolved
            .target()
            .unwrap()
            .create_file_new()
            .unwrap()
            .write_all(b"inside")
            .unwrap();

        assert_eq!(
            fs::read_to_string(root.path().join("safe-old/new.txt")).unwrap(),
            "inside"
        );
        assert!(!root.path().join("safe/new.txt").exists());
    }

    #[cfg(windows)]
    #[test]
    fn resolved_workspace_directory_pins_every_ancestor_name_on_windows() {
        let root = crate::testing::temp_dir();
        fs::create_dir_all(root.path().join("first/second/third")).unwrap();
        let requested = parse_requested_path("./first/second/third").unwrap();
        let resolved = resolve_existing_target(root.path(), &requested).unwrap();

        let rename = fs::rename(root.path().join("first"), root.path().join("first-old"));
        assert!(
            rename.is_err(),
            "a resolved workspace directory must keep ancestor names stable while its path may be used as a process cwd"
        );
        drop(resolved);

        let create_root = crate::testing::temp_dir();
        fs::create_dir_all(create_root.path().join("first/second")).unwrap();
        let requested = parse_requested_path("./first/second/new.txt").unwrap();
        let pending = resolve_create_target(create_root.path(), &requested).unwrap();
        let target = pending.target().unwrap();
        drop(pending);
        let rename = fs::rename(
            create_root.path().join("first"),
            create_root.path().join("first-old"),
        );
        assert!(
            rename.is_err(),
            "a ResolvedTarget must keep every ancestor name stable even after its source ResolvedPath is dropped"
        );
        drop(target);
    }

    #[cfg(unix)]
    #[test]
    fn existing_workspace_path_remains_anchored_after_parent_swap() {
        let root = crate::testing::temp_dir();
        let outside = crate::testing::temp_dir();
        fs::create_dir(root.path().join("safe")).unwrap();
        fs::write(root.path().join("safe/file.txt"), "inside").unwrap();
        fs::write(outside.path().join("file.txt"), "outside").unwrap();
        let requested = parse_requested_path("./safe/file.txt").unwrap();
        let resolved = resolve_existing_target(root.path(), &requested).unwrap();

        fs::rename(root.path().join("safe"), root.path().join("safe-old")).unwrap();
        symlink(outside.path(), root.path().join("safe")).unwrap();

        let mut content = String::new();
        resolved
            .open_file()
            .unwrap()
            .read_to_string(&mut content)
            .unwrap();
        assert_eq!(content, "inside");
    }

    #[cfg(unix)]
    #[test]
    fn create_workspace_path_remains_anchored_after_parent_swap() {
        let root = crate::testing::temp_dir();
        let outside = crate::testing::temp_dir();
        fs::create_dir(root.path().join("safe")).unwrap();
        let requested = parse_requested_path("./safe/new.txt").unwrap();
        let resolved = resolve_create_target(root.path(), &requested).unwrap();

        fs::rename(root.path().join("safe"), root.path().join("safe-old")).unwrap();
        symlink(outside.path(), root.path().join("safe")).unwrap();
        resolved
            .target()
            .unwrap()
            .create_file_new()
            .unwrap()
            .write_all(b"inside")
            .unwrap();

        assert_eq!(
            fs::read_to_string(root.path().join("safe-old/new.txt")).unwrap(),
            "inside"
        );
        assert!(!outside.path().join("new.txt").exists());
    }
}
