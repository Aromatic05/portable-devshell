use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use filetime::FileTime;
use serde::{Deserialize, Serialize};
use tempfile::Builder;
use uuid::Uuid;

use crate::security::SecurityPolicy;
use crate::security::path::{
    FilesystemCapability, PathNamespace, parse_requested_path, resolve_create_target,
};
use crate::tools::ToolError;
use crate::tools::artifact::payload::{ArtifactPayloadDescriptor, ArtifactPayloadType};
use crate::tools::artifact::storage;

const METADATA_VERSION: u32 = 1;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactReceiveBeginInput {
    pub descriptor: ArtifactPayloadDescriptor,
    #[serde(default)]
    pub overwrite: bool,
    pub target_path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactReceiveBeginResult {
    pub receive_id: String,
    pub next_offset_bytes: u64,
    #[cfg(test)]
    #[serde(skip)]
    pub temporary_path: PathBuf,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactReceiveWriteResult {
    pub receive_id: String,
    pub next_offset_bytes: u64,
    pub received_bytes: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactReceiveFinishResult {
    pub receive_id: String,
    pub target_path: String,
    pub bytes: usize,
    pub blake3: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum ArtifactReceivePhase {
    Receiving,
    Verifying,
    Committing,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactReceiveMetadata {
    version: u32,
    receive_id: String,
    descriptor: ArtifactPayloadDescriptor,
    overwrite: bool,
    target_path: PathBuf,
    temporary_path: PathBuf,
    staged_path: Option<PathBuf>,
    backup_path: Option<PathBuf>,
    received_bytes: usize,
    phase: ArtifactReceivePhase,
}

#[derive(Clone, Debug)]
struct RestoredManifestEntry {
    entry_type: RestoredEntryType,
    relative_path: String,
    mode: u32,
    size: u64,
    modified_at_seconds: u64,
    content_blake3: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RestoredEntryType {
    Directory,
    File,
}

pub struct ArtifactReceiveStore {
    root: PathBuf,
    guard: Mutex<()>,
}

impl ArtifactReceiveStore {
    pub fn new(root: PathBuf) -> Result<Arc<Self>, ToolError> {
        crate::storage::permissions::ensure_dir(&root, 0o700)
            .map_err(|error| ToolError::new("artifact.storageFailed", error))?;
        let store = Arc::new(Self {
            root,
            guard: Mutex::new(()),
        });
        {
            let _guard = store
                .guard
                .lock()
                .map_err(|_| ToolError::new("artifact.storageFailed", "receive lock poisoned"))?;
            store.recover_locked()?;
        }
        Ok(store)
    }

    pub fn begin(
        &self,
        workspace: &Path,
        policy: &dyn SecurityPolicy,
        input: ArtifactReceiveBeginInput,
    ) -> Result<ArtifactReceiveBeginResult, ToolError> {
        validate_descriptor(&input.descriptor)?;
        let requested = parse_requested_path(&input.target_path)?;
        let capability = match requested.namespace {
            PathNamespace::Workspace => FilesystemCapability::WorkspaceWrite,
            PathNamespace::Absolute => FilesystemCapability::AbsoluteWrite,
        };
        policy
            .check_capability(capability)
            .map_err(|error| ToolError {
                code: error.code,
                message: error.message,
                retryable: false,
                details: error.details,
            })?;
        let target_path = resolve_create_target(workspace, &requested)?.canonical;
        reject_symlink_target(&target_path)?;
        if target_path.symlink_metadata().is_ok() && !input.overwrite {
            return Err(ToolError::new(
                "artifact.targetExists",
                "artifact destination already exists",
            ));
        }
        let parent = target_path
            .parent()
            .ok_or_else(|| ToolError::new("artifact.invalidTarget", "target has no parent"))?;
        fs::create_dir_all(parent)
            .map_err(|error| ToolError::new("artifact.receiveFailed", error.to_string()))?;

        let _guard = self
            .guard
            .lock()
            .map_err(|_| ToolError::new("artifact.storageFailed", "receive lock poisoned"))?;
        let receive_id = Uuid::new_v4().to_string();
        let temporary = Builder::new()
            .prefix(&format!(".devshell-receive-{receive_id}-"))
            .suffix(".payload")
            .tempfile_in(parent)
            .map_err(|error| ToolError::new("artifact.receiveFailed", error.to_string()))?;
        let (_, temporary_path) = temporary
            .keep()
            .map_err(|error| ToolError::new("artifact.receiveFailed", error.error.to_string()))?;
        let metadata = ArtifactReceiveMetadata {
            version: METADATA_VERSION,
            receive_id: receive_id.clone(),
            descriptor: input.descriptor,
            overwrite: input.overwrite,
            target_path,
            temporary_path: temporary_path.clone(),
            staged_path: None,
            backup_path: None,
            received_bytes: 0,
            phase: ArtifactReceivePhase::Receiving,
        };
        if let Err(error) = self.write_metadata(&metadata) {
            let _ = fs::remove_file(&temporary_path);
            return Err(error);
        }
        Ok(ArtifactReceiveBeginResult {
            receive_id,
            next_offset_bytes: 0,
            #[cfg(test)]
            temporary_path,
        })
    }

    pub fn write(
        &self,
        receive_id: &str,
        offset_bytes: u64,
        content: String,
    ) -> Result<ArtifactReceiveWriteResult, ToolError> {
        validate_id(receive_id)?;
        let bytes = STANDARD.decode(content).map_err(|error| {
            ToolError::new(
                "artifact.payloadInvalid",
                format!("invalid base64 chunk: {error}"),
            )
        })?;
        let _guard = self
            .guard
            .lock()
            .map_err(|_| ToolError::new("artifact.storageFailed", "receive lock poisoned"))?;
        let mut metadata = self.load_metadata(receive_id)?;
        if metadata.phase != ArtifactReceivePhase::Receiving {
            return Err(ToolError::new(
                "artifact.receiveStateConflict",
                "artifact receive is not accepting chunks",
            ));
        }
        if offset_bytes != metadata.received_bytes as u64 {
            return Err(ToolError::new(
                "artifact.receiveOffsetMismatch",
                format!(
                    "expected offset {}, received {offset_bytes}",
                    metadata.received_bytes
                ),
            ));
        }
        if metadata.received_bytes.saturating_add(bytes.len()) > metadata.descriptor.payload_bytes {
            return Err(ToolError::new(
                "artifact.payloadInvalid",
                "received payload exceeds declared size",
            ));
        }
        let mut file = OpenOptions::new()
            .write(true)
            .open(&metadata.temporary_path)
            .map_err(|error| ToolError::new("artifact.receiveFailed", error.to_string()))?;
        file.seek(SeekFrom::Start(offset_bytes))
            .map_err(|error| ToolError::new("artifact.receiveFailed", error.to_string()))?;
        file.write_all(&bytes)
            .map_err(|error| ToolError::new("artifact.receiveFailed", error.to_string()))?;
        file.sync_data()
            .map_err(|error| ToolError::new("artifact.receiveFailed", error.to_string()))?;
        metadata.received_bytes = metadata.received_bytes.saturating_add(bytes.len());
        self.write_metadata(&metadata)?;
        Ok(ArtifactReceiveWriteResult {
            receive_id: receive_id.to_string(),
            next_offset_bytes: metadata.received_bytes as u64,
            received_bytes: metadata.received_bytes,
        })
    }

    pub fn finish(&self, receive_id: &str) -> Result<ArtifactReceiveFinishResult, ToolError> {
        validate_id(receive_id)?;
        let _guard = self
            .guard
            .lock()
            .map_err(|_| ToolError::new("artifact.storageFailed", "receive lock poisoned"))?;
        let mut metadata = self.load_metadata(receive_id)?;
        if metadata.phase != ArtifactReceivePhase::Receiving {
            return Err(ToolError::new(
                "artifact.receiveStateConflict",
                "artifact receive cannot be finished from its current state",
            ));
        }
        if metadata.received_bytes != metadata.descriptor.payload_bytes {
            return Err(ToolError::new(
                "artifact.payloadInvalid",
                format!(
                    "received {} bytes but expected {}",
                    metadata.received_bytes, metadata.descriptor.payload_bytes
                ),
            ));
        }
        metadata.phase = ArtifactReceivePhase::Verifying;
        self.write_metadata(&metadata)?;
        let (bytes, blake3) = hash_file(&metadata.temporary_path)?;
        if bytes != metadata.descriptor.payload_bytes
            || blake3 != metadata.descriptor.payload_blake3
        {
            return Err(ToolError::new(
                "artifact.payloadInvalid",
                "received payload checksum does not match descriptor",
            ));
        }

        let staged_path = match metadata.descriptor.payload_type {
            ArtifactPayloadType::DirectoryArchive => {
                let staged = sibling_path(
                    &metadata.target_path,
                    &format!(".devshell-receive-{receive_id}.dir"),
                )?;
                remove_path_if_exists(&staged)?;
                fs::create_dir(&staged)
                    .map_err(|error| ToolError::new("artifact.receiveFailed", error.to_string()))?;
                if let Err(error) = extract_directory(&metadata, &staged) {
                    let _ = fs::remove_dir_all(&staged);
                    return Err(error);
                }
                Some(staged)
            }
            ArtifactPayloadType::Stdout
            | ArtifactPayloadType::Stderr
            | ArtifactPayloadType::File => None,
        };
        metadata.staged_path = staged_path.clone();
        self.write_metadata(&metadata)?;

        let source_path = staged_path
            .as_deref()
            .unwrap_or(metadata.temporary_path.as_path())
            .to_path_buf();
        self.commit_locked(&mut metadata, &source_path)?;
        let target_path = metadata.target_path.display().to_string();
        let _ = fs::remove_file(&metadata.temporary_path);
        let _ = fs::remove_file(self.metadata_path(receive_id));
        Ok(ArtifactReceiveFinishResult {
            receive_id: receive_id.to_string(),
            target_path,
            bytes,
            blake3,
        })
    }

    pub fn abort(&self, receive_id: &str) -> Result<(), ToolError> {
        validate_id(receive_id)?;
        let _guard = self
            .guard
            .lock()
            .map_err(|_| ToolError::new("artifact.storageFailed", "receive lock poisoned"))?;
        let metadata = match self.load_metadata(receive_id) {
            Ok(metadata) => metadata,
            Err(error) if error.code == "artifact.receiveNotFound" => return Ok(()),
            Err(error) => return Err(error),
        };
        self.rollback_and_remove_locked(&metadata)
    }

    fn commit_locked(
        &self,
        metadata: &mut ArtifactReceiveMetadata,
        source_path: &Path,
    ) -> Result<(), ToolError> {
        reject_symlink_target(&metadata.target_path)?;
        let target_exists = metadata.target_path.symlink_metadata().is_ok();
        if target_exists && !metadata.overwrite {
            return Err(ToolError::new(
                "artifact.targetExists",
                "artifact destination already exists",
            ));
        }
        metadata.phase = ArtifactReceivePhase::Committing;

        let incoming_directory =
            metadata.descriptor.payload_type == ArtifactPayloadType::DirectoryArchive;
        let direct_file_replace = target_exists
            && metadata.overwrite
            && !incoming_directory
            && metadata.target_path.is_file();
        if direct_file_replace {
            self.write_metadata(metadata)?;
            fs::rename(source_path, &metadata.target_path)
                .map_err(|error| ToolError::new("artifact.commitFailed", error.to_string()))?;
            sync_parent(&metadata.target_path)?;
            return Ok(());
        }

        if target_exists {
            let backup = sibling_path(
                &metadata.target_path,
                &format!(".devshell-receive-{}.backup", metadata.receive_id),
            )?;
            remove_path_if_exists(&backup)?;
            metadata.backup_path = Some(backup.clone());
            self.write_metadata(metadata)?;
            fs::rename(&metadata.target_path, &backup)
                .map_err(|error| ToolError::new("artifact.commitFailed", error.to_string()))?;
            if let Err(error) = fs::rename(source_path, &metadata.target_path) {
                let _ = fs::rename(&backup, &metadata.target_path);
                return Err(ToolError::new("artifact.commitFailed", error.to_string()));
            }
            sync_parent(&metadata.target_path)?;
            remove_path_if_exists(&backup)?;
            metadata.backup_path = None;
            return Ok(());
        }

        self.write_metadata(metadata)?;
        if incoming_directory || metadata.overwrite {
            fs::rename(source_path, &metadata.target_path)
                .map_err(|error| ToolError::new("artifact.commitFailed", error.to_string()))?;
        } else {
            fs::hard_link(source_path, &metadata.target_path).map_err(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    ToolError::new(
                        "artifact.targetExists",
                        "artifact destination already exists",
                    )
                } else {
                    ToolError::new("artifact.commitFailed", error.to_string())
                }
            })?;
            fs::remove_file(source_path)
                .map_err(|error| ToolError::new("artifact.commitFailed", error.to_string()))?;
        }
        sync_parent(&metadata.target_path)
    }

    fn recover_locked(&self) -> Result<(), ToolError> {
        for entry in fs::read_dir(&self.root)
            .map_err(|error| ToolError::new("artifact.storageFailed", error.to_string()))?
        {
            let entry = entry
                .map_err(|error| ToolError::new("artifact.storageFailed", error.to_string()))?;
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let metadata = fs::read(&path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<ArtifactReceiveMetadata>(&bytes).ok());
            let Some(metadata) = metadata else {
                let _ = fs::remove_file(&path);
                continue;
            };
            self.rollback_and_remove_locked(&metadata)?;
        }
        Ok(())
    }

    fn rollback_and_remove_locked(
        &self,
        metadata: &ArtifactReceiveMetadata,
    ) -> Result<(), ToolError> {
        if let Some(backup) = &metadata.backup_path {
            let target_exists = metadata.target_path.symlink_metadata().is_ok();
            let backup_exists = backup.symlink_metadata().is_ok();
            if backup_exists && !target_exists {
                fs::rename(backup, &metadata.target_path).map_err(|error| {
                    ToolError::new("artifact.recoveryFailed", error.to_string())
                })?;
            } else if backup_exists && target_exists {
                remove_path_if_exists(backup)?;
            }
        }
        let _ = fs::remove_file(&metadata.temporary_path);
        if let Some(staged) = &metadata.staged_path {
            remove_path_if_exists(staged)?;
        }
        let _ = fs::remove_file(self.metadata_path(&metadata.receive_id));
        Ok(())
    }

    fn load_metadata(&self, receive_id: &str) -> Result<ArtifactReceiveMetadata, ToolError> {
        storage::read_json(
            &self.metadata_path(receive_id),
            "artifact.receiveNotFound",
            "artifact receive is unavailable",
            "artifact receive metadata is invalid",
            |metadata: &ArtifactReceiveMetadata| {
                metadata.version == METADATA_VERSION && metadata.receive_id == receive_id
            },
        )
    }

    fn write_metadata(&self, metadata: &ArtifactReceiveMetadata) -> Result<(), ToolError> {
        storage::write_json(
            &self.root,
            &self.metadata_path(&metadata.receive_id),
            "receive-metadata-",
            metadata,
        )
    }

    fn metadata_path(&self, receive_id: &str) -> PathBuf {
        self.root.join(format!("{receive_id}.json"))
    }
}

fn extract_directory(
    metadata: &ArtifactReceiveMetadata,
    staged_path: &Path,
) -> Result<(), ToolError> {
    let file = File::open(&metadata.temporary_path)
        .map_err(|error| ToolError::new("artifact.receiveFailed", error.to_string()))?;
    let decoder = zstd::stream::read::Decoder::new(file)
        .map_err(|error| ToolError::new("artifact.payloadInvalid", error.to_string()))?;
    let mut archive = tar::Archive::new(decoder);
    let mut entries = Vec::new();
    let mut seen = HashSet::new();
    let mut logical_bytes = 0usize;
    let mut directory_metadata = Vec::new();

    for entry in archive
        .entries()
        .map_err(|error| ToolError::new("artifact.payloadInvalid", error.to_string()))?
    {
        let mut entry =
            entry.map_err(|error| ToolError::new("artifact.payloadInvalid", error.to_string()))?;
        let entry_type = entry.header().entry_type();
        let restored_type = if entry_type.is_dir() {
            RestoredEntryType::Directory
        } else if entry_type.is_file() {
            RestoredEntryType::File
        } else {
            return Err(ToolError::new(
                "artifact.directoryUnsafe",
                "directory archive contains unsupported entry type",
            ));
        };
        let path = entry
            .path()
            .map_err(|error| ToolError::new("artifact.payloadInvalid", error.to_string()))?
            .into_owned();
        validate_archive_path(&path)?;
        let relative_path = path
            .to_str()
            .ok_or_else(|| {
                ToolError::new(
                    "artifact.directoryUnsafe",
                    "archive contains non-UTF-8 path",
                )
            })?
            .replace(std::path::MAIN_SEPARATOR, "/");
        if !seen.insert(relative_path.clone()) {
            return Err(ToolError::new(
                "artifact.directoryUnsafe",
                format!("archive contains duplicate entry: {relative_path}"),
            ));
        }
        let mode = entry
            .header()
            .mode()
            .map_err(|error| ToolError::new("artifact.payloadInvalid", error.to_string()))?
            & 0o777;
        let modified_at_seconds = entry
            .header()
            .mtime()
            .map_err(|error| ToolError::new("artifact.payloadInvalid", error.to_string()))?;
        let size = entry
            .header()
            .size()
            .map_err(|error| ToolError::new("artifact.payloadInvalid", error.to_string()))?;
        let output_path = staged_path.join(&path);
        if restored_type == RestoredEntryType::Directory {
            if size != 0 {
                return Err(ToolError::new(
                    "artifact.payloadInvalid",
                    "directory archive entry has non-zero size",
                ));
            }
            fs::create_dir_all(&output_path)
                .map_err(|error| ToolError::new("artifact.receiveFailed", error.to_string()))?;
            directory_metadata.push((
                output_path,
                mode,
                modified_at_seconds,
                relative_path.clone(),
            ));
            entries.push(RestoredManifestEntry {
                entry_type: restored_type,
                relative_path,
                mode,
                size,
                modified_at_seconds,
                content_blake3: None,
            });
            continue;
        }

        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| ToolError::new("artifact.receiveFailed", error.to_string()))?;
        }
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&output_path)
            .map_err(|error| ToolError::new("artifact.receiveFailed", error.to_string()))?;
        let mut hasher = blake3::Hasher::new();
        let mut written = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let count = entry
                .read(&mut buffer)
                .map_err(|error| ToolError::new("artifact.payloadInvalid", error.to_string()))?;
            if count == 0 {
                break;
            }
            output
                .write_all(&buffer[..count])
                .map_err(|error| ToolError::new("artifact.receiveFailed", error.to_string()))?;
            hasher.update(&buffer[..count]);
            written = written.saturating_add(count as u64);
        }
        if written != size {
            return Err(ToolError::new(
                "artifact.payloadInvalid",
                format!("archive entry size mismatch: {relative_path}"),
            ));
        }
        output
            .sync_all()
            .map_err(|error| ToolError::new("artifact.receiveFailed", error.to_string()))?;
        set_mode(&output_path, mode)?;
        filetime::set_file_mtime(
            &output_path,
            FileTime::from_unix_time(modified_at_seconds as i64, 0),
        )
        .map_err(|error| ToolError::new("artifact.receiveFailed", error.to_string()))?;
        logical_bytes = logical_bytes.saturating_add(size as usize);
        entries.push(RestoredManifestEntry {
            entry_type: restored_type,
            relative_path,
            mode,
            size,
            modified_at_seconds,
            content_blake3: Some(hasher.finalize().to_hex().to_string()),
        });
    }

    directory_metadata.sort_by(|left, right| {
        right
            .3
            .matches('/')
            .count()
            .cmp(&left.3.matches('/').count())
    });
    for (path, mode, modified_at_seconds, _) in directory_metadata {
        set_mode(&path, mode)?;
        filetime::set_file_mtime(
            &path,
            FileTime::from_unix_time(modified_at_seconds as i64, 0),
        )
        .map_err(|error| ToolError::new("artifact.receiveFailed", error.to_string()))?;
    }

    entries.sort_by(|left, right| {
        left.relative_path
            .as_bytes()
            .cmp(right.relative_path.as_bytes())
    });
    let manifest_blake3 = hash_manifest(&entries);
    let descriptor = &metadata.descriptor;
    if descriptor.entry_count != Some(entries.len())
        || descriptor.logical_bytes != Some(logical_bytes)
        || descriptor.manifest_blake3.as_deref() != Some(manifest_blake3.as_str())
    {
        return Err(ToolError::new(
            "artifact.payloadInvalid",
            "restored directory manifest does not match descriptor",
        ));
    }
    sync_tree(staged_path)?;
    Ok(())
}

fn hash_manifest(entries: &[RestoredManifestEntry]) -> String {
    let mut hasher = blake3::Hasher::new();
    for entry in entries {
        hasher.update(&[match entry.entry_type {
            RestoredEntryType::Directory => 0,
            RestoredEntryType::File => 1,
        }]);
        let path = entry.relative_path.as_bytes();
        hasher.update(&(path.len() as u64).to_be_bytes());
        hasher.update(path);
        hasher.update(&entry.mode.to_be_bytes());
        hasher.update(&entry.size.to_be_bytes());
        hasher.update(&entry.modified_at_seconds.to_be_bytes());
        match &entry.content_blake3 {
            Some(value) => {
                hasher.update(&(value.len() as u64).to_be_bytes());
                hasher.update(value.as_bytes());
            }
            None => {
                hasher.update(&0u64.to_be_bytes());
            }
        }
    }
    hasher.finalize().to_hex().to_string()
}

fn hash_file(path: &Path) -> Result<(usize, String), ToolError> {
    let mut file = File::open(path)
        .map_err(|error| ToolError::new("artifact.receiveFailed", error.to_string()))?;
    let mut hasher = blake3::Hasher::new();
    let mut bytes = 0usize;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| ToolError::new("artifact.receiveFailed", error.to_string()))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
        bytes = bytes.saturating_add(count);
    }
    Ok((bytes, hasher.finalize().to_hex().to_string()))
}

fn validate_descriptor(descriptor: &ArtifactPayloadDescriptor) -> Result<(), ToolError> {
    if descriptor.name.is_empty()
        || descriptor.media_type.is_empty()
        || descriptor.payload_blake3.len() != 64
        || !descriptor
            .payload_blake3
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(ToolError::new(
            "artifact.payloadInvalid",
            "artifact payload descriptor is invalid",
        ));
    }
    if descriptor.payload_type == ArtifactPayloadType::DirectoryArchive
        && (descriptor.entry_count.is_none()
            || descriptor.logical_bytes.is_none()
            || descriptor
                .manifest_blake3
                .as_deref()
                .is_none_or(|value| value.len() != 64))
    {
        return Err(ToolError::new(
            "artifact.payloadInvalid",
            "directory payload descriptor is incomplete",
        ));
    }
    Ok(())
}

fn reject_symlink_target(path: &Path) -> Result<(), ToolError> {
    if path
        .symlink_metadata()
        .is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        return Err(ToolError::new(
            "artifact.directoryUnsafe",
            "artifact destination must not be a symbolic link",
        ));
    }
    Ok(())
}

fn validate_archive_path(path: &Path) -> Result<(), ToolError> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(ToolError::new(
            "artifact.directoryUnsafe",
            "directory archive contains an unsafe path",
        ));
    }
    Ok(())
}

fn validate_id(value: &str) -> Result<(), ToolError> {
    storage::validate_uuid(value, "artifact.invalidReceiveId", "receiveId is invalid")
}

fn sibling_path(target: &Path, name: &str) -> Result<PathBuf, ToolError> {
    target
        .parent()
        .map(|parent| parent.join(name))
        .ok_or_else(|| ToolError::new("artifact.invalidTarget", "target has no parent"))
}

fn remove_path_if_exists(path: &Path) -> Result<(), ToolError> {
    let metadata = match path.symlink_metadata() {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(ToolError::new("artifact.receiveFailed", error.to_string()));
        }
    };
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        fs::remove_dir_all(path)
            .map_err(|error| ToolError::new("artifact.receiveFailed", error.to_string()))
    } else {
        fs::remove_file(path)
            .map_err(|error| ToolError::new("artifact.receiveFailed", error.to_string()))
    }
}

fn sync_parent(path: &Path) -> Result<(), ToolError> {
    let parent = path
        .parent()
        .ok_or_else(|| ToolError::new("artifact.commitFailed", "target has no parent"))?;
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| ToolError::new("artifact.commitFailed", error.to_string()))
}

fn sync_tree(root: &Path) -> Result<(), ToolError> {
    let mut directories = vec![root.to_path_buf()];
    let mut index = 0;
    while index < directories.len() {
        let directory = directories[index].clone();
        index += 1;
        for entry in fs::read_dir(&directory)
            .map_err(|error| ToolError::new("artifact.receiveFailed", error.to_string()))?
        {
            let entry = entry
                .map_err(|error| ToolError::new("artifact.receiveFailed", error.to_string()))?;
            let metadata = entry
                .file_type()
                .map_err(|error| ToolError::new("artifact.receiveFailed", error.to_string()))?;
            if metadata.is_dir() {
                directories.push(entry.path());
            } else if metadata.is_file() {
                File::open(entry.path())
                    .and_then(|file| file.sync_all())
                    .map_err(|error| ToolError::new("artifact.receiveFailed", error.to_string()))?;
            }
        }
    }
    for directory in directories.into_iter().rev() {
        File::open(directory)
            .and_then(|file| file.sync_all())
            .map_err(|error| ToolError::new("artifact.receiveFailed", error.to_string()))?;
    }
    Ok(())
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> Result<(), ToolError> {
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .map_err(|error| ToolError::new("artifact.receiveFailed", error.to_string()))
}

#[cfg(windows)]
fn set_mode(_path: &Path, _mode: u32) -> Result<(), ToolError> {
    Ok(())
}

#[cfg(test)]
mod recovery_tests {
    use std::fs;

    use base64::{Engine as _, engine::general_purpose::STANDARD};

    use super::{
        ArtifactReceiveBeginInput, ArtifactReceivePhase, ArtifactReceiveStore, sibling_path,
    };
    use crate::security::policy::DisabledSecurityPolicy;
    use crate::tools::artifact::payload::{ArtifactPayloadDescriptor, ArtifactPayloadType};

    #[test]
    fn startup_restores_backup_when_commit_was_interrupted() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let target = workspace.join("result.bin");
        fs::write(&target, b"original").unwrap();
        let receive_root = root.path().join("receives");
        let bytes = b"replacement";
        let store = ArtifactReceiveStore::new(receive_root.clone()).unwrap();
        let begun = store
            .begin(
                &workspace,
                &DisabledSecurityPolicy,
                ArtifactReceiveBeginInput {
                    descriptor: ArtifactPayloadDescriptor {
                        payload_type: ArtifactPayloadType::File,
                        name: "result.bin".to_string(),
                        media_type: "application/octet-stream".to_string(),
                        payload_bytes: bytes.len(),
                        payload_blake3: blake3::hash(bytes).to_hex().to_string(),
                        logical_bytes: None,
                        entry_count: None,
                        manifest_blake3: None,
                    },
                    overwrite: true,
                    target_path: "./result.bin".to_string(),
                },
            )
            .unwrap();
        store
            .write(&begun.receive_id, 0, STANDARD.encode(bytes))
            .unwrap();

        let mut metadata = store.load_metadata(&begun.receive_id).unwrap();
        let backup = sibling_path(
            &metadata.target_path,
            &format!(".devshell-receive-{}.backup", begun.receive_id),
        )
        .unwrap();
        metadata.phase = ArtifactReceivePhase::Committing;
        metadata.backup_path = Some(backup.clone());
        store.write_metadata(&metadata).unwrap();
        fs::rename(&target, &backup).unwrap();
        assert!(!target.exists());
        drop(store);

        drop(ArtifactReceiveStore::new(receive_root).unwrap());
        assert_eq!(fs::read(&target).unwrap(), b"original");
        assert!(!backup.exists());
        assert!(!begun.temporary_path.exists());
    }
}
