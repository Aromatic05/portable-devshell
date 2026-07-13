use std::ffi::OsStr;
use std::fs::{self, File, Metadata};
use std::io::{Read, Seek, SeekFrom, Write};
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use tempfile::{Builder, NamedTempFile};
use uuid::Uuid;

use crate::security::SecurityPolicy;
use crate::security::path::{
    FilesystemCapability, PathNamespace, parse_requested_path, resolve_existing_target,
};
use crate::tools::ToolError;
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

#[derive(Clone, Debug)]
struct DirectoryEntry {
    absolute_path: PathBuf,
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
        set_private_dir(&root)?;
        set_private_dir(&temp_dir)?;
        clear_temp_dir(&temp_dir)?;
        let store = Arc::new(Self {
            root,
            temp_dir,
            artifacts,
            guard: Mutex::new(()),
        });
        {
            let _guard = store
                .guard
                .lock()
                .map_err(|_| ToolError::new("artifact.storageFailed", "payload lock poisoned"))?;
            store.gc_locked()?;
        }
        Ok(store)
    }

    pub fn open_handle(
        &self,
        handle: &str,
        expires_at_ms: u128,
    ) -> Result<ArtifactPayloadOpenResult, ToolError> {
        validate_expiration(expires_at_ms)?;
        let _guard = self
            .guard
            .lock()
            .map_err(|_| ToolError::new("artifact.storageFailed", "payload lock poisoned"))?;
        self.gc_locked()?;

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

    pub fn open_path(
        &self,
        workspace: &Path,
        raw_path: &str,
        policy: &dyn SecurityPolicy,
        expires_at_ms: u128,
    ) -> Result<ArtifactPayloadOpenResult, ToolError> {
        validate_expiration(expires_at_ms)?;
        let requested = parse_requested_path(raw_path)?;
        let capability = match requested.namespace {
            PathNamespace::Workspace => FilesystemCapability::WorkspaceRead,
            PathNamespace::Absolute => FilesystemCapability::AbsoluteRead,
        };
        policy
            .check_capability(capability)
            .map_err(|error| ToolError {
                code: error.code,
                message: error.message,
                retryable: false,
                details: error.details,
            })?;
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
        let metadata = fs::symlink_metadata(&resolved.canonical)
            .map_err(|error| ToolError::new("artifact.readFailed", error.to_string()))?;

        let _guard = self
            .guard
            .lock()
            .map_err(|_| ToolError::new("artifact.storageFailed", "payload lock poisoned"))?;
        self.gc_locked()?;

        let payload_id = Uuid::new_v4().to_string();
        let descriptor = if metadata.is_file() {
            self.create_file_payload(&payload_id, &resolved.canonical)?
        } else if metadata.is_dir() {
            self.create_directory_payload(&payload_id, &resolved.canonical)?
        } else {
            return Err(ToolError::new(
                "artifact.directoryUnsafe",
                "artifact source must be a regular file or directory",
            ));
        };
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
        validate_id(payload_id)?;
        if max_bytes == 0 || max_bytes > MAX_READ_BYTES {
            return Err(ToolError::new(
                "tool.invalidArguments",
                format!("maxBytes must be between 1 and {MAX_READ_BYTES}"),
            ));
        }
        let _guard = self
            .guard
            .lock()
            .map_err(|_| ToolError::new("artifact.storageFailed", "payload lock poisoned"))?;
        self.gc_locked()?;
        let metadata = self.load_metadata(payload_id)?;
        if metadata.expires_at_ms <= now_ms() {
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

    pub fn close(&self, payload_id: &str) -> Result<(), ToolError> {
        validate_id(payload_id)?;
        let _guard = self
            .guard
            .lock()
            .map_err(|_| ToolError::new("artifact.storageFailed", "payload lock poisoned"))?;
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
        source_path: &Path,
    ) -> Result<ArtifactPayloadDescriptor, ToolError> {
        let name = utf8_file_name(source_path)?;
        let mut source = File::open(source_path)
            .map_err(|error| ToolError::new("artifact.readFailed", error.to_string()))?;
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
        let (payload_bytes, payload_blake3) = copy_and_hash(&mut source, &mut temp)?;
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
        source_path: &Path,
    ) -> Result<ArtifactPayloadDescriptor, ToolError> {
        let source_name = utf8_file_name(source_path).unwrap_or_else(|_| "directory".to_string());
        let entries = collect_directory_entries(source_path)?;
        let mut temp = self.new_temp("payload-directory-")?;
        let mut manifest_hasher = blake3::Hasher::new();
        let mut logical_bytes = 0usize;

        {
            let encoder = zstd::stream::write::Encoder::new(temp.as_file_mut(), ZSTD_LEVEL)
                .map_err(|error| ToolError::new("artifact.archiveFailed", error.to_string()))?;
            let mut archive = tar::Builder::new(encoder);
            archive.mode(tar::HeaderMode::Deterministic);
            for entry in &entries {
                append_directory_entry(&mut archive, entry, &mut manifest_hasher)?;
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

        temp.flush()
            .map_err(|error| ToolError::new("artifact.storageFailed", error.to_string()))?;
        temp.as_file()
            .sync_all()
            .map_err(|error| ToolError::new("artifact.storageFailed", error.to_string()))?;
        let (payload_bytes, payload_blake3) = hash_file(temp.as_file_mut())?;
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

    fn gc_locked(&self) -> Result<(), ToolError> {
        let now = now_ms();
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
                .and_then(|bytes| serde_json::from_slice::<ArtifactPayloadMetadata>(&bytes).ok());
            let Some(metadata) = metadata else {
                let _ = fs::remove_file(&path);
                if let Some(stem) = path.file_stem().and_then(|value| value.to_str()) {
                    let _ = fs::remove_file(self.data_path(stem));
                }
                continue;
            };
            if metadata.version != METADATA_VERSION
                || validate_id(&metadata.payload_id).is_err()
                || metadata.expires_at_ms <= now
            {
                self.remove_payload_locked(&metadata)?;
            }
        }
        Ok(())
    }

    fn remove_payload_locked(&self, metadata: &ArtifactPayloadMetadata) -> Result<(), ToolError> {
        match fs::remove_file(self.metadata_path(&metadata.payload_id)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(ToolError::new("artifact.storageFailed", error.to_string()));
            }
        }
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
        let bytes = fs::read(self.metadata_path(payload_id)).map_err(|_| {
            ToolError::new(
                "artifact.payloadNotFound",
                "artifact payload is unavailable",
            )
        })?;
        let metadata: ArtifactPayloadMetadata = serde_json::from_slice(&bytes).map_err(|_| {
            ToolError::new(
                "artifact.payloadNotFound",
                "artifact payload metadata is invalid",
            )
        })?;
        if metadata.version != METADATA_VERSION || metadata.payload_id != payload_id {
            return Err(ToolError::new(
                "artifact.payloadNotFound",
                "artifact payload metadata is invalid",
            ));
        }
        Ok(metadata)
    }

    fn write_metadata(&self, metadata: &ArtifactPayloadMetadata) -> Result<(), ToolError> {
        let mut temp = self.new_temp("payload-metadata-")?;
        serde_json::to_writer(&mut temp, metadata)
            .map_err(|error| ToolError::new("artifact.storageFailed", error.to_string()))?;
        temp.flush()
            .map_err(|error| ToolError::new("artifact.storageFailed", error.to_string()))?;
        temp.as_file()
            .sync_all()
            .map_err(|error| ToolError::new("artifact.storageFailed", error.to_string()))?;
        temp.persist(self.metadata_path(&metadata.payload_id))
            .map_err(|error| ToolError::new("artifact.storageFailed", error.error.to_string()))?;
        Ok(())
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

fn collect_directory_entries(root: &Path) -> Result<Vec<DirectoryEntry>, ToolError> {
    let mut entries = Vec::new();
    collect_directory_entries_from(root, root, &mut entries)?;
    entries.sort_by(|left, right| {
        left.relative_path
            .as_bytes()
            .cmp(right.relative_path.as_bytes())
    });
    Ok(entries)
}

fn collect_directory_entries_from(
    root: &Path,
    current: &Path,
    entries: &mut Vec<DirectoryEntry>,
) -> Result<(), ToolError> {
    let mut children = fs::read_dir(current)
        .map_err(|error| ToolError::new("artifact.readFailed", error.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| ToolError::new("artifact.readFailed", error.to_string()))?;
    children.sort_by(|left, right| {
        os_sort_key(&left.file_name()).cmp(&os_sort_key(&right.file_name()))
    });
    for child in children {
        let absolute_path = child.path();
        let metadata = fs::symlink_metadata(&absolute_path)
            .map_err(|error| ToolError::new("artifact.readFailed", error.to_string()))?;
        if metadata.file_type().is_symlink() {
            return Err(ToolError::new(
                "artifact.directoryUnsafe",
                format!(
                    "directory contains symbolic link: {}",
                    absolute_path.display()
                ),
            ));
        }
        let relative = absolute_path.strip_prefix(root).map_err(|_| {
            ToolError::new("artifact.directoryUnsafe", "directory member escaped root")
        })?;
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
            absolute_path: absolute_path.clone(),
            relative_path,
            entry_type,
            mode: metadata_mode(&metadata, entry_type),
            modified_at_seconds: modified_at_seconds(&metadata),
            size,
        });
        if entry_type == DirectoryEntryType::Directory {
            collect_directory_entries_from(root, &absolute_path, entries)?;
        }
    }
    Ok(())
}

fn append_directory_entry<W: Write>(
    archive: &mut tar::Builder<W>,
    entry: &DirectoryEntry,
    manifest_hasher: &mut blake3::Hasher,
) -> Result<(), ToolError> {
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
            let mut file = File::open(&entry.absolute_path)
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
            let (_, content_blake3) = hash_file(&mut file)?;
            file.seek(SeekFrom::Start(0))
                .map_err(|error| ToolError::new("artifact.readFailed", error.to_string()))?;
            header.set_entry_type(tar::EntryType::Regular);
            header.set_size(entry.size);
            header.set_cksum();
            archive
                .append_data(&mut header, &entry.relative_path, &mut file)
                .map_err(|error| ToolError::new("artifact.archiveFailed", error.to_string()))?;
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
) -> Result<(usize, String), ToolError> {
    let mut hasher = blake3::Hasher::new();
    let mut total = 0usize;
    let mut buffer = [0u8; 64 * 1024];
    loop {
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

fn hash_file(file: &mut File) -> Result<(usize, String), ToolError> {
    file.seek(SeekFrom::Start(0))
        .map_err(|error| ToolError::new("artifact.readFailed", error.to_string()))?;
    let mut hasher = blake3::Hasher::new();
    let mut total = 0usize;
    let mut buffer = [0u8; 64 * 1024];
    loop {
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

fn validate_expiration(expires_at_ms: u128) -> Result<(), ToolError> {
    if expires_at_ms <= now_ms() {
        return Err(ToolError::new(
            "artifact.invalidLease",
            "artifact payload must expire in the future",
        ));
    }
    Ok(())
}

fn validate_id(value: &str) -> Result<(), ToolError> {
    let parsed = Uuid::parse_str(value)
        .map_err(|_| ToolError::new("artifact.invalidPayloadId", "payloadId is invalid"))?;
    if parsed.to_string() != value {
        return Err(ToolError::new(
            "artifact.invalidPayloadId",
            "payloadId is invalid",
        ));
    }
    Ok(())
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

fn modified_at_seconds(metadata: &Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn clear_temp_dir(path: &Path) -> Result<(), ToolError> {
    for entry in fs::read_dir(path)
        .map_err(|error| ToolError::new("artifact.storageFailed", error.to_string()))?
    {
        let entry =
            entry.map_err(|error| ToolError::new("artifact.storageFailed", error.to_string()))?;
        if entry
            .file_type()
            .map_err(|error| ToolError::new("artifact.storageFailed", error.to_string()))?
            .is_file()
        {
            fs::remove_file(entry.path())
                .map_err(|error| ToolError::new("artifact.storageFailed", error.to_string()))?;
        }
    }
    Ok(())
}

fn set_private_dir(path: &Path) -> Result<(), ToolError> {
    crate::storage::permissions::ensure_dir(path, 0o700)
        .map_err(|error| ToolError::new("artifact.storageFailed", error))
}

#[cfg(unix)]
fn metadata_mode(metadata: &Metadata, _entry_type: DirectoryEntryType) -> u32 {
    metadata.permissions().mode() & 0o777
}

#[cfg(windows)]
fn metadata_mode(_metadata: &Metadata, entry_type: DirectoryEntryType) -> u32 {
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

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
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
        let root = tempfile::tempdir().unwrap();
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
        let root = tempfile::tempdir().unwrap();
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
    fn directory_payload_is_deterministic_tar_zstd_and_rejects_symlinks() {
        let root = tempfile::tempdir().unwrap();
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
        let root = tempfile::tempdir().unwrap();
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
}
