use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use tempfile::{Builder, NamedTempFile};
use uuid::Uuid;

use crate::platform::unix_time_millis;
use crate::security::SecurityPolicy;
use crate::security::path::{
    FilesystemCapability, PathNamespace, ResolvedDirectory, ResolvedMetadata, ResolvedPath,
    parse_requested_path, resolve_existing_target,
};
use crate::tools::{ToolCancellation, ToolError};
use crate::tools::artifact::storage;
use crate::tools::artifact::store::{ArtifactLease, ArtifactStore};
use crate::tools::artifact::types::ArtifactStream;

const METADATA_VERSION: u32 = 1;
const MAX_READ_BYTES: usize = 1024 * 1024;
const ZSTD_LEVEL: i32 = 3;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ArtifactPayloadType {
    Stdout,
    Stderr,
    File,
    DirectoryArchive,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactPayloadDescriptor {
    #[serde(rename = "type")]
    pub payload_type: ArtifactPayloadType,
    pub name: String,
    pub media_type: String,
    pub payload_bytes: usize,
    pub payload_blake3: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logical_bytes: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest_blake3: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactPayloadOpenResult {
    pub payload_id: String,
    pub descriptor: ArtifactPayloadDescriptor,
    pub expires_at_ms: u128,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactPayloadReadResult {
    pub payload_id: String,
    pub offset_bytes: u64,
    pub returned_bytes: usize,
    pub total_bytes: usize,
    pub content: String,
    pub encoding: &'static str,
    pub eof: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_offset_bytes: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum ArtifactPayloadBacking {
    ArtifactLease { lease_id: String },
    OwnedFile,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactPayloadMetadata {
    version: u32,
    payload_id: String,
    descriptor: ArtifactPayloadDescriptor,
    expires_at_ms: u128,
    backing: ArtifactPayloadBacking,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct DirectoryEntry {
    relative_path: String,
    entry_type: DirectoryEntryType,
    mode: u32,
    modified_at_seconds: u64,
    size: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DirectoryEntryType {
    Directory,
    File,
}

pub struct ArtifactPayloadStore {
    root: PathBuf,
    temp_dir: PathBuf,
    artifacts: Arc<ArtifactStore>,
    guard: Mutex<()>,
}

impl ArtifactPayloadStore {
    pub fn new(root: PathBuf, artifacts: Arc<ArtifactStore>) -> Result<Arc<Self>, ToolError> {
        let temp_dir = root.join("tmp");
        fs::create_dir_all(&temp_dir)
            .map_err(|error| ToolError::new("artifact.storageFailed", error.to_string()))?;
        storage::ensure_private_dir(&root)?;
        storage::ensure_private_dir(&temp_dir)?;
        storage::clear_temp_files(&temp_dir)?;
        let store = Arc::new(Self {
            root,
            temp_dir,
            artifacts,
            guard: Mutex::new(()),
        });
        Ok(store)
    }

    pub fn schedule_maintenance(self: &Arc<Self>) {
        let store = Arc::downgrade(self);
        thread::spawn(move || {
            thread::sleep(Duration::from_secs(1));
            if let Some(store) = store.upgrade() {
                let _ = store.collect_stale();
            }
        });
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, ()>, ToolError> {
        self.guard
            .lock()
            .map_err(|_| ToolError::new("artifact.storageFailed", "payload lock poisoned"))
    }

    pub fn open_handle(
        &self,
        handle: &str,
        expires_at_ms: u128,
    ) -> Result<ArtifactPayloadOpenResult, ToolError> {
        validate_expiration(expires_at_ms)?;
        let _guard = self.lock()?;

        let payload_id = Uuid::new_v4().to_string();
        let lease = self.artifacts.acquire_lease(handle, expires_at_ms)?;
        let descriptor = descriptor_from_lease(&lease);
        let metadata = ArtifactPayloadMetadata {
            version: METADATA_VERSION,
            payload_id: payload_id.clone(),
            descriptor: descriptor.clone(),
            expires_at_ms,
            backing: ArtifactPayloadBacking::ArtifactLease {
                lease_id: lease.lease_id.clone(),
            },
        };
        if let Err(error) = self.write_metadata(&metadata) {
            let _ = self.artifacts.release_lease(&lease.lease_id);
            return Err(error);
        }

        Ok(ArtifactPayloadOpenResult {
            payload_id,
            descriptor,
            expires_at_ms,
        })
    }

    #[cfg(test)]
    pub fn open_path(
        &self,
        workspace: &Path,
        raw_path: &str,
        policy: &dyn SecurityPolicy,
        expires_at_ms: u128,
    ) -> Result<ArtifactPayloadOpenResult, ToolError> {
        self.open_path_cancellable(
            workspace,
            raw_path,
            policy,
            expires_at_ms,
            &ToolCancellation::default(),
        )
    }

    pub fn open_path_cancellable(
        &self,
        workspace: &Path,
        raw_path: &str,
        policy: &dyn SecurityPolicy,
        expires_at_ms: u128,
        cancellation: &ToolCancellation,
    ) -> Result<ArtifactPayloadOpenResult, ToolError> {
        cancellation.check()?;
        validate_expiration(expires_at_ms)?;
        let requested = parse_requested_path(raw_path)?;
        let capability = match requested.namespace {
            PathNamespace::Workspace => FilesystemCapability::WorkspaceRead,
            PathNamespace::Absolute => FilesystemCapability::AbsoluteRead,
        };
        policy
            .check_capability(capability)
            .map_err(ToolError::from)?;
        let requested_path = requested.path(workspace);
        let requested_metadata = fs::symlink_metadata(&requested_path).map_err(|error| {
            ToolError::new(
                if error.kind() == std::io::ErrorKind::NotFound {
                    "file.notFound"
                } else {
                    "artifact.readFailed"
                },
                format!("failed to inspect {}: {error}", requested_path.display()),
            )
        })?;
        if requested_metadata.file_type().is_symlink() {
            return Err(ToolError::new(
                "artifact.directoryUnsafe",
                "artifact source path must not be a symbolic link",
            ));
        }
        let resolved = resolve_existing_target(workspace, &requested)?;
        self.open_resolved_path_cancellable(&resolved, expires_at_ms, cancellation)
    }

    #[cfg(test)]
    fn open_resolved_path(
        &self,
        resolved: &ResolvedPath,
        expires_at_ms: u128,
    ) -> Result<ArtifactPayloadOpenResult, ToolError> {
        self.open_resolved_path_cancellable(
            resolved,
            expires_at_ms,
            &ToolCancellation::default(),
        )
    }

    fn open_resolved_path_cancellable(
        &self,
        resolved: &ResolvedPath,
        expires_at_ms: u128,
        cancellation: &ToolCancellation,
    ) -> Result<ArtifactPayloadOpenResult, ToolError> {
        cancellation.check()?;
        let metadata = resolved
            .metadata()
            .map_err(|error| ToolError::new("artifact.readFailed", error.to_string()))?;

        let _guard = self.lock()?;

        let payload_id = Uuid::new_v4().to_string();
        let descriptor = if metadata.is_file() {
            self.create_file_payload(
                &payload_id,
                resolved
                    .open_file()
                    .map_err(|error| ToolError::new("artifact.readFailed", error.to_string()))?,
                &resolved.canonical,
                cancellation,
            )?
        } else if metadata.is_dir() {
            self.create_directory_payload(
                &payload_id,
                resolved
                    .open_directory()
                    .map_err(|error| ToolError::new("artifact.readFailed", error.to_string()))?,
                &resolved.canonical,
                cancellation,
            )?
        } else {
            return Err(ToolError::new(
                "artifact.directoryUnsafe",
                "artifact source must be a regular file or directory",
            ));
        };
        cancellation.check()?;
        let payload_metadata = ArtifactPayloadMetadata {
            version: METADATA_VERSION,
            payload_id: payload_id.clone(),
            descriptor: descriptor.clone(),
            expires_at_ms,
            backing: ArtifactPayloadBacking::OwnedFile,
        };
        if let Err(error) = self.write_metadata(&payload_metadata) {
            let _ = fs::remove_file(self.data_path(&payload_id));
            return Err(error);
        }

        Ok(ArtifactPayloadOpenResult {
            payload_id,
            descriptor,
            expires_at_ms,
        })
    }

    pub fn read(
        &self,
        payload_id: &str,
        offset_bytes: u64,
        max_bytes: usize,
    ) -> Result<ArtifactPayloadReadResult, ToolError> {
        let (bytes, total_bytes) = self.read_bytes(payload_id, offset_bytes, max_bytes)?;
        let next = offset_bytes.saturating_add(bytes.len() as u64);
        let eof = next >= total_bytes as u64;
        Ok(ArtifactPayloadReadResult {
            payload_id: payload_id.to_string(),
            offset_bytes,
            returned_bytes: bytes.len(),
            total_bytes,
            content: STANDARD.encode(bytes),
            encoding: "base64",
            eof,
            next_offset_bytes: (!eof).then_some(next),
        })
    }

    pub(crate) fn read_bytes(
        &self,
        payload_id: &str,
        offset_bytes: u64,
        max_bytes: usize,
    ) -> Result<(Vec<u8>, usize), ToolError> {
        validate_id(payload_id)?;
        if max_bytes == 0 || max_bytes > MAX_READ_BYTES {
            return Err(ToolError::new(
                "tool.invalidArguments",
                format!("maxBytes must be between 1 and {MAX_READ_BYTES}"),
            ));
        }
        let _guard = self.lock()?;
        let metadata = self.load_metadata(payload_id)?;
        if metadata.expires_at_ms <= unix_time_millis() {
            return Err(ToolError::new(
                "artifact.payloadExpired",
                "artifact payload has expired",
            ));
        }
        let total_bytes = metadata.descriptor.payload_bytes;
        if offset_bytes > total_bytes as u64 {
            return Err(ToolError::new(
                "artifact.invalidOffset",
                "offsetBytes exceeds payload size",
            ));
        }
        let data_path = self.resolve_data_path(&metadata)?;
        let mut file = File::open(data_path)
            .map_err(|error| ToolError::new("artifact.readFailed", error.to_string()))?;
        file.seek(SeekFrom::Start(offset_bytes))
            .map_err(|error| ToolError::new("artifact.readFailed", error.to_string()))?;
        let requested = total_bytes
            .saturating_sub(offset_bytes as usize)
            .min(max_bytes);
        let mut bytes = vec![0; requested];
        file.read_exact(&mut bytes)
            .map_err(|error| ToolError::new("artifact.readFailed", error.to_string()))?;
        Ok((bytes, total_bytes))
    }

    pub fn close(&self, payload_id: &str) -> Result<(), ToolError> {
        validate_id(payload_id)?;
        let _guard = self.lock()?;
        let metadata = match self.load_metadata(payload_id) {
            Ok(metadata) => metadata,
            Err(error) if error.code == "artifact.payloadNotFound" => return Ok(()),
            Err(error) => return Err(error),
        };
        self.remove_payload_locked(&metadata)
    }

    fn create_file_payload(
        &self,
        payload_id: &str,
        mut source: File,
        display_path: &Path,
        cancellation: &ToolCancellation,
    ) -> Result<ArtifactPayloadDescriptor, ToolError> {
        cancellation.check()?;
        let name = utf8_file_name(display_path)?;
        if !source
            .metadata()
            .map_err(|error| ToolError::new("artifact.readFailed", error.to_string()))?
            .is_file()
        {
            return Err(ToolError::new(
                "artifact.directoryUnsafe",
                "artifact file source changed type during snapshot",
            ));
        }
        let mut temp = self.new_temp("payload-file-")?;
        let (payload_bytes, payload_blake3) =
            copy_and_hash(&mut source, &mut temp, cancellation)?;
        temp.flush()
            .map_err(|error| ToolError::new("artifact.storageFailed", error.to_string()))?;
        temp.as_file()
            .sync_all()
            .map_err(|error| ToolError::new("artifact.storageFailed", error.to_string()))?;
        temp.persist(self.data_path(payload_id))
            .map_err(|error| ToolError::new("artifact.storageFailed", error.error.to_string()))?;
        Ok(ArtifactPayloadDescriptor {
            payload_type: ArtifactPayloadType::File,
            name,
            media_type: "application/octet-stream".to_string(),
            payload_bytes,
            payload_blake3,
            logical_bytes: None,
            entry_count: None,
            manifest_blake3: None,
        })
    }

    fn create_directory_payload(
        &self,
        payload_id: &str,
        source: ResolvedDirectory,
        display_path: &Path,
        cancellation: &ToolCancellation,
    ) -> Result<ArtifactPayloadDescriptor, ToolError> {
        cancellation.check()?;
        let source_name = utf8_file_name(display_path).unwrap_or_else(|_| "directory".to_string());
        let entries = collect_directory_entries(&source, cancellation)?;
        let mut temp = self.new_temp("payload-directory-")?;
        let mut manifest_hasher = blake3::Hasher::new();
        let mut logical_bytes = 0usize;

        {
            let encoder = zstd::stream::write::Encoder::new(temp.as_file_mut(), ZSTD_LEVEL)
                .map_err(|error| ToolError::new("artifact.archiveFailed", error.to_string()))?;
            let mut archive = tar::Builder::new(encoder);
            archive.mode(tar::HeaderMode::Deterministic);
            for entry in &entries {
                cancellation.check()?;
                append_directory_entry(
                    &source,
                    &mut archive,
                    entry,
                    &mut manifest_hasher,
                    cancellation,
                )?;
                if entry.entry_type == DirectoryEntryType::File {
                    logical_bytes = logical_bytes.saturating_add(entry.size as usize);
                }
            }
            let encoder = archive
                .into_inner()
                .map_err(|error| ToolError::new("artifact.archiveFailed", error.to_string()))?;
            encoder
                .finish()
                .map_err(|error| ToolError::new("artifact.archiveFailed", error.to_string()))?;
        }

        cancellation.check()?;
        let final_entries = collect_directory_entries(&source, cancellation)?;
        if final_entries != entries {
            return Err(ToolError::new(
                "artifact.directoryChanged",
                "directory membership or metadata changed while it was archived",
            ));
        }

        temp.flush()
            .map_err(|error| ToolError::new("artifact.storageFailed", error.to_string()))?;
        temp.as_file()
            .sync_all()
            .map_err(|error| ToolError::new("artifact.storageFailed", error.to_string()))?;
        let (payload_bytes, payload_blake3) = hash_file(temp.as_file_mut(), cancellation)?;
        let manifest_blake3 = manifest_hasher.finalize().to_hex().to_string();
        temp.persist(self.data_path(payload_id))
            .map_err(|error| ToolError::new("artifact.storageFailed", error.error.to_string()))?;

        Ok(ArtifactPayloadDescriptor {
            payload_type: ArtifactPayloadType::DirectoryArchive,
            name: format!("{source_name}.tar.zst"),
            media_type: "application/zstd".to_string(),
            payload_bytes,
            payload_blake3,
            logical_bytes: Some(logical_bytes),
            entry_count: Some(entries.len()),
            manifest_blake3: Some(manifest_blake3),
        })
    }

    fn resolve_data_path(&self, metadata: &ArtifactPayloadMetadata) -> Result<PathBuf, ToolError> {
        match &metadata.backing {
            ArtifactPayloadBacking::ArtifactLease { lease_id } => {
                Ok(self.artifacts.resolve_lease(lease_id)?.data_path)
            }
            ArtifactPayloadBacking::OwnedFile => {
                let path = self.data_path(&metadata.payload_id);
                if !path.is_file() {
                    return Err(ToolError::new(
                        "artifact.contentUnavailable",
                        "artifact payload content is unavailable",
                    ));
                }
                Ok(path)
            }
        }
    }

    fn collect_stale(&self) -> Result<(), ToolError> {
        let now = unix_time_millis();
        for path in storage::json_files(&self.root)? {
            let Some(payload_id) = path.file_stem().and_then(|value| value.to_str()) else {
                continue;
            };
            if validate_id(payload_id).is_err() {
                let _ = fs::remove_file(&path);
                continue;
            }
            let metadata = fs::read(&path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<ArtifactPayloadMetadata>(&bytes).ok());
            if metadata.as_ref().is_none_or(|metadata| {
                metadata.version != METADATA_VERSION
                    || metadata.payload_id != payload_id
                    || metadata.expires_at_ms <= now
            }) {
                self.remove_stale_candidate(payload_id, now)?;
            }
        }
        self.remove_orphan_data_files()?;
        Ok(())
    }

    fn remove_stale_candidate(&self, payload_id: &str, now: u128) -> Result<(), ToolError> {
        let _guard = self.lock()?;
        let metadata_path = self.metadata_path(payload_id);
        let metadata = fs::read(&metadata_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<ArtifactPayloadMetadata>(&bytes).ok());
        match metadata {
            Some(metadata)
                if metadata.version == METADATA_VERSION
                    && metadata.payload_id == payload_id
                    && metadata.expires_at_ms > now =>
            {
                Ok(())
            }
            Some(metadata)
                if metadata.version == METADATA_VERSION
                    && metadata.payload_id == payload_id =>
            {
                self.remove_payload_locked(&metadata)
            }
            Some(metadata) => {
                storage::remove_file_if_exists(&metadata_path)?;
                storage::remove_file_if_exists(&self.data_path(payload_id))?;
                if let ArtifactPayloadBacking::ArtifactLease { lease_id } = metadata.backing {
                    let _ = self.artifacts.release_lease(&lease_id);
                }
                Ok(())
            }
            None => {
                storage::remove_file_if_exists(&metadata_path)?;
                storage::remove_file_if_exists(&self.data_path(payload_id))
            }
        }
    }

    fn remove_orphan_data_files(&self) -> Result<(), ToolError> {
        for entry in fs::read_dir(&self.root)
            .map_err(|error| ToolError::new("artifact.storageFailed", error.to_string()))?
        {
            let entry = entry
                .map_err(|error| ToolError::new("artifact.storageFailed", error.to_string()))?;
            if !entry
                .file_type()
                .map_err(|error| ToolError::new("artifact.storageFailed", error.to_string()))?
                .is_file()
            {
                continue;
            }
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("bin") {
                continue;
            }
            let Some(payload_id) = path.file_stem().and_then(|value| value.to_str()) else {
                continue;
            };
            if validate_id(payload_id).is_err() || self.metadata_path(payload_id).is_file() {
                continue;
            }
            let _guard = self.lock()?;
            if !self.metadata_path(payload_id).is_file() {
                storage::remove_file_if_exists(&path)?;
            }
        }
        Ok(())
    }

    fn remove_payload_locked(&self, metadata: &ArtifactPayloadMetadata) -> Result<(), ToolError> {
        storage::remove_file_if_exists(&self.metadata_path(&metadata.payload_id))?;
        match &metadata.backing {
            ArtifactPayloadBacking::ArtifactLease { lease_id } => {
                self.artifacts.release_lease(lease_id)?;
            }
            ArtifactPayloadBacking::OwnedFile => {
                let _ = fs::remove_file(self.data_path(&metadata.payload_id));
            }
        }
        Ok(())
    }

    fn load_metadata(&self, payload_id: &str) -> Result<ArtifactPayloadMetadata, ToolError> {
        storage::read_json(
            &self.metadata_path(payload_id),
            "artifact.payloadNotFound",
            "artifact payload is unavailable",
            "artifact payload metadata is invalid",
            |metadata: &ArtifactPayloadMetadata| {
                metadata.version == METADATA_VERSION && metadata.payload_id == payload_id
            },
        )
    }

    fn write_metadata(&self, metadata: &ArtifactPayloadMetadata) -> Result<(), ToolError> {
        storage::write_json(
            &self.temp_dir,
            &self.metadata_path(&metadata.payload_id),
            "payload-metadata-",
            metadata,
        )
    }

    fn new_temp(&self, prefix: &str) -> Result<NamedTempFile, ToolError> {
        Builder::new()
            .prefix(prefix)
            .suffix(".tmp")
            .tempfile_in(&self.temp_dir)
            .map_err(|error| ToolError::new("artifact.storageFailed", error.to_string()))
    }

    fn data_path(&self, payload_id: &str) -> PathBuf {
        self.root.join(format!("{payload_id}.bin"))
    }

    fn metadata_path(&self, payload_id: &str) -> PathBuf {
        self.root.join(format!("{payload_id}.json"))
    }
}

fn descriptor_from_lease(lease: &ArtifactLease) -> ArtifactPayloadDescriptor {
    let (payload_type, name) = match lease.stream {
        ArtifactStream::Stdout => (ArtifactPayloadType::Stdout, "stdout.log"),
        ArtifactStream::Stderr => (ArtifactPayloadType::Stderr, "stderr.log"),
    };
    ArtifactPayloadDescriptor {
        payload_type,
        name: name.to_string(),
        media_type: "text/plain; charset=utf-8".to_string(),
        payload_bytes: lease.stored_bytes,
        payload_blake3: lease.blake3.clone(),
        logical_bytes: None,
        entry_count: None,
        manifest_blake3: None,
    }
}

fn collect_directory_entries(
    root: &ResolvedDirectory,
    cancellation: &ToolCancellation,
) -> Result<Vec<DirectoryEntry>, ToolError> {
    cancellation.check()?;
    let mut entries = Vec::new();
    collect_directory_entries_from(root, Path::new(""), &mut entries, cancellation)?;
    entries.sort_by(|left, right| {
        left.relative_path
            .as_bytes()
            .cmp(right.relative_path.as_bytes())
    });
    Ok(entries)
}

fn collect_directory_entries_from(
    root: &ResolvedDirectory,
    current: &Path,
    entries: &mut Vec<DirectoryEntry>,
    cancellation: &ToolCancellation,
) -> Result<(), ToolError> {
    cancellation.check()?;
    let directory = root
        .open_directory(current)
        .map_err(|error| ToolError::new("artifact.readFailed", error.to_string()))?;
    let mut children = directory
        .entries()
        .map_err(|error| ToolError::new("artifact.readFailed", error.to_string()))?;
    children.sort_by(|left, right| os_sort_key(left).cmp(&os_sort_key(right)));
    for name in children {
        cancellation.check()?;
        let relative = current.join(&name);
        let metadata = root
            .metadata(&relative, false)
            .map_err(|error| ToolError::new("artifact.readFailed", error.to_string()))?;
        if metadata.is_symlink() {
            return Err(ToolError::new(
                "artifact.directoryUnsafe",
                format!("directory contains symbolic link: {}", relative.display()),
            ));
        }
        let relative_path = relative
            .to_str()
            .ok_or_else(|| {
                ToolError::new(
                    "artifact.directoryUnsafe",
                    "directory contains non-UTF-8 path",
                )
            })?
            .replace(std::path::MAIN_SEPARATOR, "/");
        validate_relative_archive_path(&relative_path)?;
        let (entry_type, size) = if metadata.is_dir() {
            (DirectoryEntryType::Directory, 0)
        } else if metadata.is_file() {
            (DirectoryEntryType::File, metadata.len())
        } else {
            return Err(ToolError::new(
                "artifact.directoryUnsafe",
                format!("directory contains unsupported member: {relative_path}"),
            ));
        };
        entries.push(DirectoryEntry {
            relative_path,
            entry_type,
            mode: metadata_mode(&metadata, entry_type),
            modified_at_seconds: modified_at_seconds(&metadata),
            size,
        });
        if entry_type == DirectoryEntryType::Directory {
            collect_directory_entries_from(root, &relative, entries, cancellation)?;
        }
    }
    Ok(())
}

fn append_directory_entry<W: Write>(
    root: &ResolvedDirectory,
    archive: &mut tar::Builder<W>,
    entry: &DirectoryEntry,
    manifest_hasher: &mut blake3::Hasher,
    cancellation: &ToolCancellation,
) -> Result<(), ToolError> {
    cancellation.check()?;
    let mut header = tar::Header::new_gnu();
    header.set_uid(0);
    header.set_gid(0);
    header.set_mode(entry.mode);
    header.set_mtime(entry.modified_at_seconds);
    match entry.entry_type {
        DirectoryEntryType::Directory => {
            header.set_entry_type(tar::EntryType::Directory);
            header.set_size(0);
            header.set_cksum();
            archive
                .append_data(&mut header, &entry.relative_path, std::io::empty())
                .map_err(|error| ToolError::new("artifact.archiveFailed", error.to_string()))?;
            update_manifest_hash(manifest_hasher, entry, None);
        }
        DirectoryEntryType::File => {
            let mut file = root
                .open_file(Path::new(&entry.relative_path))
                .map_err(|error| ToolError::new("artifact.readFailed", error.to_string()))?;
            let file_metadata = file
                .metadata()
                .map_err(|error| ToolError::new("artifact.readFailed", error.to_string()))?;
            if !file_metadata.is_file() || file_metadata.len() != entry.size {
                return Err(ToolError::new(
                    "artifact.directoryChanged",
                    format!(
                        "directory member changed during archive: {}",
                        entry.relative_path
                    ),
                ));
            }
            file.seek(SeekFrom::Start(0))
                .map_err(|error| ToolError::new("artifact.readFailed", error.to_string()))?;
            header.set_entry_type(tar::EntryType::Regular);
            header.set_size(entry.size);
            header.set_cksum();
            let mut reader = CancellableHashingReader::new(&mut file, cancellation);
            if let Err(error) = archive.append_data(&mut header, &entry.relative_path, &mut reader) {
                cancellation.check()?;
                return Err(ToolError::new("artifact.archiveFailed", error.to_string()));
            }
            let (archived_bytes, content_blake3) = reader.finish();
            if archived_bytes != entry.size as usize {
                return Err(ToolError::new(
                    "artifact.directoryChanged",
                    format!("directory member changed during archive: {}", entry.relative_path),
                ));
            }
            cancellation.check()?;
            let (_, current_blake3) = hash_file(&mut file, cancellation)?;
            if current_blake3 != content_blake3 {
                return Err(ToolError::new(
                    "artifact.directoryChanged",
                    format!("directory member changed while it was archived: {}", entry.relative_path),
                ));
            }
            update_manifest_hash(manifest_hasher, entry, Some(&content_blake3));
        }
    }
    Ok(())
}

fn update_manifest_hash(
    hasher: &mut blake3::Hasher,
    entry: &DirectoryEntry,
    content_blake3: Option<&str>,
) {
    hasher.update(&[match entry.entry_type {
        DirectoryEntryType::Directory => 0,
        DirectoryEntryType::File => 1,
    }]);
    let path = entry.relative_path.as_bytes();
    hasher.update(&(path.len() as u64).to_be_bytes());
    hasher.update(path);
    hasher.update(&entry.mode.to_be_bytes());
    hasher.update(&entry.size.to_be_bytes());
    hasher.update(&entry.modified_at_seconds.to_be_bytes());
    match content_blake3 {
        Some(value) => {
            hasher.update(&(value.len() as u64).to_be_bytes());
            hasher.update(value.as_bytes());
        }
        None => {
            hasher.update(&0u64.to_be_bytes());
        }
    };
}

fn copy_and_hash<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    cancellation: &ToolCancellation,
) -> Result<(usize, String), ToolError> {
    let mut hasher = blake3::Hasher::new();
    let mut total = 0usize;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        cancellation.check()?;
        let read = reader
            .read(&mut buffer)
            .map_err(|error| ToolError::new("artifact.readFailed", error.to_string()))?;
        if read == 0 {
            break;
        }
        writer
            .write_all(&buffer[..read])
            .map_err(|error| ToolError::new("artifact.storageFailed", error.to_string()))?;
        hasher.update(&buffer[..read]);
        total = total.saturating_add(read);
    }
    Ok((total, hasher.finalize().to_hex().to_string()))
}

fn hash_file(
    file: &mut File,
    cancellation: &ToolCancellation,
) -> Result<(usize, String), ToolError> {
    file.seek(SeekFrom::Start(0))
        .map_err(|error| ToolError::new("artifact.readFailed", error.to_string()))?;
    let mut hasher = blake3::Hasher::new();
    let mut total = 0usize;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        cancellation.check()?;
        let read = file
            .read(&mut buffer)
            .map_err(|error| ToolError::new("artifact.readFailed", error.to_string()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        total = total.saturating_add(read);
    }
    Ok((total, hasher.finalize().to_hex().to_string()))
}

struct CancellableHashingReader<'a> {
    cancellation: &'a ToolCancellation,
    hasher: blake3::Hasher,
    inner: &'a mut File,
    total: usize,
}

impl<'a> CancellableHashingReader<'a> {
    fn new(inner: &'a mut File, cancellation: &'a ToolCancellation) -> Self {
        Self {
            cancellation,
            hasher: blake3::Hasher::new(),
            inner,
            total: 0,
        }
    }

    fn finish(self) -> (usize, String) {
        (self.total, self.hasher.finalize().to_hex().to_string())
    }
}

impl Read for CancellableHashingReader<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if self.cancellation.is_cancelled() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "artifact snapshot cancelled",
            ));
        }
        let read = self.inner.read(buffer)?;
        self.hasher.update(&buffer[..read]);
        self.total = self.total.saturating_add(read);
        Ok(read)
    }
}

fn validate_expiration(expires_at_ms: u128) -> Result<(), ToolError> {
    if expires_at_ms <= unix_time_millis() {
        return Err(ToolError::new(
            "artifact.invalidLease",
            "artifact payload must expire in the future",
        ));
    }
    Ok(())
}

fn validate_id(value: &str) -> Result<(), ToolError> {
    storage::validate_uuid(value, "artifact.invalidPayloadId", "payloadId is invalid")
}

fn validate_relative_archive_path(path: &str) -> Result<(), ToolError> {
    if path.is_empty()
        || path.starts_with('/')
        || path
            .split('/')
            .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return Err(ToolError::new(
            "artifact.directoryUnsafe",
            format!("invalid directory member path: {path}"),
        ));
    }
    Ok(())
}

fn utf8_file_name(path: &Path) -> Result<String, ToolError> {
    path.file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty() && *value != "." && *value != "..")
        .map(ToOwned::to_owned)
        .ok_or_else(|| {
            ToolError::new(
                "artifact.directoryUnsafe",
                "artifact source has no UTF-8 name",
            )
        })
}

fn modified_at_seconds(metadata: &ResolvedMetadata) -> u64 {
    #[cfg(unix)]
    {
        return metadata.modified_at_seconds().max(0) as u64;
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        0
    }
}

#[cfg(unix)]
fn metadata_mode(metadata: &ResolvedMetadata, _entry_type: DirectoryEntryType) -> u32 {
    metadata.mode() & 0o777
}

#[cfg(windows)]
fn metadata_mode(_metadata: &ResolvedMetadata, entry_type: DirectoryEntryType) -> u32 {
    match entry_type {
        DirectoryEntryType::Directory => 0o755,
        DirectoryEntryType::File => 0o644,
    }
}

#[cfg(unix)]
fn os_sort_key(value: &OsStr) -> Vec<u8> {
    value.as_bytes().to_vec()
}

#[cfg(windows)]
fn os_sort_key(value: &OsStr) -> Vec<u8> {
    use std::os::windows::ffi::OsStrExt;
    value
        .encode_wide()
        .flat_map(u16::to_be_bytes)
        .collect::<Vec<_>>()
}
#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};

    use base64::{Engine as _, engine::general_purpose::STANDARD};

    use super::{ArtifactPayloadStore, ArtifactPayloadType};
    use crate::security::policy::DisabledSecurityPolicy;
    use crate::tools::artifact::store::ArtifactStore;
    use crate::tools::artifact::types::ArtifactStream;

    fn expires_at_ms() -> u128 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis()
            + 60_000
    }

    #[test]
    fn opens_and_reads_artifact_content_through_a_persisted_lease() {
        let root = crate::testing::temp_dir();
        let artifacts = ArtifactStore::new(root.path().join("artifacts")).unwrap();
        let mut draft = artifacts.begin(ArtifactStream::Stdout).unwrap();
        draft.write_chunk(b"artifact bytes").unwrap();
        let reference = artifacts.persist(draft).unwrap();
        let payloads =
            ArtifactPayloadStore::new(root.path().join("payloads"), Arc::clone(&artifacts))
                .unwrap();

        let opened = payloads
            .open_handle(&reference.handle, expires_at_ms())
            .unwrap();
        assert_eq!(opened.descriptor.payload_type, ArtifactPayloadType::Stdout);
        assert_eq!(opened.descriptor.name, "stdout.log");
        let chunk = payloads.read(&opened.payload_id, 0, 1024).unwrap();
        assert_eq!(STANDARD.decode(chunk.content).unwrap(), b"artifact bytes");
        assert!(chunk.eof);

        payloads.close(&opened.payload_id).unwrap();
    }

    #[test]
    fn regular_file_payload_is_a_stable_snapshot() {
        let root = crate::testing::temp_dir();
        let workspace = root.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        fs::write(workspace.join("result.bin"), b"before").unwrap();
        let artifacts = ArtifactStore::new(root.path().join("artifacts")).unwrap();
        let payloads = ArtifactPayloadStore::new(root.path().join("payloads"), artifacts).unwrap();

        let opened = payloads
            .open_path(
                &workspace,
                "./result.bin",
                &DisabledSecurityPolicy,
                expires_at_ms(),
            )
            .unwrap();
        fs::write(workspace.join("result.bin"), b"after").unwrap();

        let chunk = payloads.read(&opened.payload_id, 0, 1024).unwrap();
        assert_eq!(STANDARD.decode(chunk.content).unwrap(), b"before");
        assert_eq!(opened.descriptor.payload_type, ArtifactPayloadType::File);
        assert_eq!(opened.descriptor.payload_bytes, 6);
    }

    #[test]
    fn payload_open_and_read_do_not_run_unrelated_payload_gc() {
        let root = crate::testing::temp_dir();
        let workspace = root.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        fs::write(workspace.join("expired.txt"), b"expired").unwrap();
        fs::write(workspace.join("active.txt"), b"active").unwrap();
        fs::write(workspace.join("next.txt"), b"next").unwrap();
        let artifacts = ArtifactStore::new(root.path().join("artifacts")).unwrap();
        let payloads = ArtifactPayloadStore::new(root.path().join("payloads"), artifacts).unwrap();
        let policy = DisabledSecurityPolicy;

        let expired = payloads
            .open_path(&workspace, "./expired.txt", &policy, expires_at_ms())
            .unwrap();
        let active = payloads
            .open_path(&workspace, "./active.txt", &policy, expires_at_ms())
            .unwrap();
        let mut metadata = payloads.load_metadata(&expired.payload_id).unwrap();
        metadata.expires_at_ms = 0;
        payloads.write_metadata(&metadata).unwrap();

        payloads.read(&active.payload_id, 0, 1024).unwrap();
        assert!(payloads.metadata_path(&expired.payload_id).is_file());
        assert!(payloads.data_path(&expired.payload_id).is_file());

        payloads
            .open_path(&workspace, "./next.txt", &policy, expires_at_ms())
            .unwrap();
        assert!(payloads.metadata_path(&expired.payload_id).is_file());
        assert!(payloads.data_path(&expired.payload_id).is_file());

        payloads.collect_stale().unwrap();
        assert!(!payloads.metadata_path(&expired.payload_id).exists());
        assert!(!payloads.data_path(&expired.payload_id).exists());
    }

    #[cfg(unix)]
    #[test]
    fn regular_file_payload_keeps_the_resolved_source_anchored_after_parent_swap() {
        use std::os::unix::fs::symlink;

        use crate::security::path::{parse_requested_path, resolve_existing_target};

        let root = crate::testing::temp_dir();
        let outside = crate::testing::temp_dir();
        let workspace = root.path().join("workspace");
        fs::create_dir_all(workspace.join("safe")).unwrap();
        fs::write(workspace.join("safe/result.bin"), b"inside").unwrap();
        fs::write(outside.path().join("result.bin"), b"outside").unwrap();
        let requested = parse_requested_path("./safe/result.bin").unwrap();
        let resolved = resolve_existing_target(&workspace, &requested).unwrap();

        fs::rename(workspace.join("safe"), workspace.join("safe-old")).unwrap();
        symlink(outside.path(), workspace.join("safe")).unwrap();

        let artifacts = ArtifactStore::new(root.path().join("artifacts")).unwrap();
        let payloads = ArtifactPayloadStore::new(root.path().join("payloads"), artifacts).unwrap();
        let opened = payloads
            .open_resolved_path(&resolved, expires_at_ms())
            .unwrap();
        assert_eq!(opened.descriptor.name, "result.bin");
        let chunk = payloads.read(&opened.payload_id, 0, 1024).unwrap();
        assert_eq!(STANDARD.decode(chunk.content).unwrap(), b"inside");
    }

    #[test]
    fn directory_payload_is_deterministic_tar_zstd_and_rejects_symlinks() {
        let root = crate::testing::temp_dir();
        let workspace = root.path().join("workspace");
        let source = workspace.join("dist");
        fs::create_dir_all(source.join("assets")).unwrap();
        fs::write(source.join("index.html"), b"index").unwrap();
        fs::write(source.join("assets/app.js"), b"app").unwrap();
        let artifacts = ArtifactStore::new(root.path().join("artifacts")).unwrap();
        let payloads = ArtifactPayloadStore::new(root.path().join("payloads"), artifacts).unwrap();

        let first = payloads
            .open_path(
                &workspace,
                "./dist",
                &DisabledSecurityPolicy,
                expires_at_ms(),
            )
            .unwrap();
        let second = payloads
            .open_path(
                &workspace,
                "./dist",
                &DisabledSecurityPolicy,
                expires_at_ms(),
            )
            .unwrap();
        assert_eq!(
            first.descriptor.payload_type,
            ArtifactPayloadType::DirectoryArchive
        );
        assert_eq!(
            first.descriptor.payload_blake3,
            second.descriptor.payload_blake3
        );
        assert_eq!(
            first.descriptor.manifest_blake3,
            second.descriptor.manifest_blake3
        );
        assert_eq!(first.descriptor.entry_count, Some(3));

        let chunk = payloads
            .read(&first.payload_id, 0, first.descriptor.payload_bytes)
            .unwrap();
        let archive_bytes = STANDARD.decode(chunk.content).unwrap();
        let decoder = zstd::stream::read::Decoder::new(archive_bytes.as_slice()).unwrap();
        let mut archive = tar::Archive::new(decoder);
        let mut names = archive
            .entries()
            .unwrap()
            .map(|entry| {
                entry
                    .unwrap()
                    .path()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect::<Vec<_>>();
        names.sort();
        assert_eq!(names, ["assets", "assets/app.js", "index.html"]);

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("index.html", source.join("link")).unwrap();
            let error = payloads
                .open_path(
                    &workspace,
                    "./dist",
                    &DisabledSecurityPolicy,
                    expires_at_ms(),
                )
                .unwrap_err();
            assert_eq!(error.code, "artifact.directoryUnsafe");
        }
    }

    #[test]
    fn payload_metadata_survives_store_reopen() {
        let root = crate::testing::temp_dir();
        let workspace = root.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        fs::write(workspace.join("stable.txt"), b"stable").unwrap();
        let artifacts = ArtifactStore::new(root.path().join("artifacts")).unwrap();
        let payload_root = root.path().join("payloads");
        let opened = ArtifactPayloadStore::new(payload_root.clone(), Arc::clone(&artifacts))
            .unwrap()
            .open_path(
                &workspace,
                "./stable.txt",
                &DisabledSecurityPolicy,
                expires_at_ms(),
            )
            .unwrap();

        let reopened = ArtifactPayloadStore::new(payload_root, artifacts).unwrap();
        let chunk = reopened.read(&opened.payload_id, 0, 1024).unwrap();
        assert_eq!(STANDARD.decode(chunk.content).unwrap(), b"stable");
    }

    #[test]
    fn payload_startup_defers_gc_to_maintenance() {
        let root = crate::testing::temp_dir();
        let artifacts = ArtifactStore::new(root.path().join("artifacts")).unwrap();
        let payload_root = root.path().join("payloads");
        let payloads = ArtifactPayloadStore::new(payload_root.clone(), Arc::clone(&artifacts)).unwrap();
        drop(payloads);

        let orphan = uuid::Uuid::new_v4().to_string();
        let orphan_path = payload_root.join(format!("{orphan}.bin"));
        let unknown_path = payload_root.join("manual.bin");
        fs::write(&orphan_path, b"orphan").unwrap();
        fs::write(&unknown_path, b"keep").unwrap();

        let reopened = ArtifactPayloadStore::new(payload_root, artifacts).unwrap();
        assert!(orphan_path.is_file());
        assert!(unknown_path.is_file());

        reopened.collect_stale().unwrap();
        assert!(!orphan_path.exists());
        assert!(unknown_path.is_file());
    }
}
