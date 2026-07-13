use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use tempfile::{Builder, NamedTempFile};
use uuid::Uuid;

use crate::tools::ToolError;
use crate::tools::artifact::types::{
    ArtifactEncoding, ArtifactReadInput, ArtifactReadOutput, ArtifactReference, ArtifactStream,
};

const DEFAULT_STREAM_LIMIT_BYTES: usize = 256 * 1024 * 1024;
const DEFAULT_INSTANCE_QUOTA_BYTES: usize = 1024 * 1024 * 1024;
const DEFAULT_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const DEFAULT_READ_BYTES: usize = 64 * 1024;
const MAX_READ_BYTES: usize = 1024 * 1024;
const METADATA_VERSION: u32 = 1;

#[derive(Clone, Copy)]
struct ArtifactPolicy {
    stream_limit_bytes: usize,
    instance_quota_bytes: usize,
    ttl: Duration,
}

impl Default for ArtifactPolicy {
    fn default() -> Self {
        Self {
            stream_limit_bytes: DEFAULT_STREAM_LIMIT_BYTES,
            instance_quota_bytes: DEFAULT_INSTANCE_QUOTA_BYTES,
            ttl: DEFAULT_TTL,
        }
    }
}

pub struct ArtifactStore {
    root: PathBuf,
    leases_dir: PathBuf,
    temp_dir: PathBuf,
    policy: ArtifactPolicy,
    guard: Mutex<()>,
}

pub struct ArtifactDraft {
    file: NamedTempFile,
    stream: ArtifactStream,
    source_bytes: usize,
    stored_bytes: usize,
    artifact_truncated: bool,
    hasher: blake3::Hasher,
    stream_limit_bytes: usize,
}

#[derive(Clone, Debug)]
pub struct ArtifactLease {
    pub blake3: String,
    pub data_path: PathBuf,
    pub lease_id: String,
    pub stored_bytes: usize,
    pub stream: ArtifactStream,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactMetadata {
    version: u32,
    handle: String,
    stream: ArtifactStream,
    source_bytes: usize,
    stored_bytes: usize,
    artifact_truncated: bool,
    blake3: String,
    created_at_ms: u128,
    expires_at_ms: u128,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactLeaseMetadata {
    version: u32,
    lease_id: String,
    handle: String,
    expires_at_ms: u128,
}

struct ArtifactRecord {
    metadata: ArtifactMetadata,
    metadata_path: PathBuf,
    data_path: PathBuf,
}

impl ArtifactStore {
    pub fn new(root: PathBuf) -> Result<Arc<Self>, ToolError> {
        Self::with_policy(root, ArtifactPolicy::default())
    }

    fn with_policy(root: PathBuf, policy: ArtifactPolicy) -> Result<Arc<Self>, ToolError> {
        let leases_dir = root.join("leases");
        let temp_dir = root.join("tmp");
        fs::create_dir_all(&temp_dir)
            .map_err(|error| ToolError::new("artifact.storageFailed", error.to_string()))?;
        fs::create_dir_all(&leases_dir)
            .map_err(|error| ToolError::new("artifact.storageFailed", error.to_string()))?;
        set_private_dir(&root)?;
        set_private_dir(&temp_dir)?;
        set_private_dir(&leases_dir)?;
        clear_temp_dir(&temp_dir)?;
        let store = Arc::new(Self {
            root,
            leases_dir,
            temp_dir,
            policy,
            guard: Mutex::new(()),
        });
        {
            let _guard = store
                .guard
                .lock()
                .map_err(|_| ToolError::new("artifact.storageFailed", "artifact lock poisoned"))?;
            store.gc_locked(0)?;
        }
        Ok(store)
    }

    pub fn begin(&self, stream: ArtifactStream) -> Result<ArtifactDraft, ToolError> {
        let file = Builder::new()
            .prefix("artifact-")
            .suffix(".tmp")
            .tempfile_in(&self.temp_dir)
            .map_err(|error| ToolError::new("artifact.storageFailed", error.to_string()))?;
        Ok(ArtifactDraft {
            file,
            stream,
            source_bytes: 0,
            stored_bytes: 0,
            artifact_truncated: false,
            hasher: blake3::Hasher::new(),
            stream_limit_bytes: self.policy.stream_limit_bytes,
        })
    }

    pub fn persist(&self, mut draft: ArtifactDraft) -> Result<ArtifactReference, ToolError> {
        draft
            .file
            .flush()
            .map_err(|error| ToolError::new("artifact.storageFailed", error.to_string()))?;
        draft
            .file
            .as_file()
            .sync_all()
            .map_err(|error| ToolError::new("artifact.storageFailed", error.to_string()))?;

        let _guard = self
            .guard
            .lock()
            .map_err(|_| ToolError::new("artifact.storageFailed", "artifact lock poisoned"))?;
        self.gc_locked(draft.stored_bytes)?;

        let handle = Uuid::new_v4().to_string();
        let created_at_ms = now_ms();
        let expires_at_ms = created_at_ms.saturating_add(self.policy.ttl.as_millis());
        let blake3 = draft.hasher.finalize().to_hex().to_string();
        let metadata = ArtifactMetadata {
            version: METADATA_VERSION,
            handle: handle.clone(),
            stream: draft.stream,
            source_bytes: draft.source_bytes,
            stored_bytes: draft.stored_bytes,
            artifact_truncated: draft.artifact_truncated,
            blake3: blake3.clone(),
            created_at_ms,
            expires_at_ms,
        };
        let data_path = self.data_path(&handle);
        let metadata_path = self.metadata_path(&handle);

        draft
            .file
            .persist(&data_path)
            .map_err(|error| ToolError::new("artifact.storageFailed", error.error.to_string()))?;
        if let Err(error) = write_metadata(&self.root, &metadata_path, &metadata) {
            let _ = fs::remove_file(&data_path);
            return Err(error);
        }

        Ok(ArtifactReference {
            handle,
            stream: metadata.stream,
            source_bytes: metadata.source_bytes,
            stored_bytes: metadata.stored_bytes,
            artifact_truncated: metadata.artifact_truncated,
            blake3,
            expires_at_ms,
        })
    }

    pub fn acquire_lease(
        &self,
        handle: &str,
        expires_at_ms: u128,
    ) -> Result<ArtifactLease, ToolError> {
        validate_handle(handle)?;
        let now = now_ms();
        if expires_at_ms <= now {
            return Err(ToolError::new(
                "artifact.invalidLease",
                "artifact lease must expire in the future",
            ));
        }

        let _guard = self
            .guard
            .lock()
            .map_err(|_| ToolError::new("artifact.storageFailed", "artifact lock poisoned"))?;
        self.gc_locked(0)?;
        let metadata = self.load_metadata(handle)?;
        if metadata.expires_at_ms <= now {
            return Err(ToolError::new(
                "artifact.expired",
                "artifact reference has expired",
            ));
        }

        let lease_id = Uuid::new_v4().to_string();
        let lease_metadata = ArtifactLeaseMetadata {
            version: METADATA_VERSION,
            lease_id: lease_id.clone(),
            handle: handle.to_string(),
            expires_at_ms,
        };
        write_json_metadata(
            &self.leases_dir,
            &self.lease_path(&lease_id),
            &lease_metadata,
        )?;

        Ok(ArtifactLease {
            blake3: metadata.blake3,
            data_path: self.data_path(handle),
            lease_id,
            stored_bytes: metadata.stored_bytes,
            stream: metadata.stream,
        })
    }

    pub fn release_lease(&self, lease_id: &str) -> Result<(), ToolError> {
        validate_handle(lease_id)?;
        let _guard = self
            .guard
            .lock()
            .map_err(|_| ToolError::new("artifact.storageFailed", "artifact lock poisoned"))?;
        match fs::remove_file(self.lease_path(lease_id)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(ToolError::new("artifact.storageFailed", error.to_string()));
            }
        }
        self.gc_locked(0)
    }

    pub fn resolve_lease(&self, lease_id: &str) -> Result<ArtifactLease, ToolError> {
        validate_handle(lease_id)?;
        let _guard = self
            .guard
            .lock()
            .map_err(|_| ToolError::new("artifact.storageFailed", "artifact lock poisoned"))?;
        self.gc_locked(0)?;
        let path = self.lease_path(lease_id);
        let bytes = fs::read(path).map_err(|_| {
            ToolError::new("artifact.leaseNotFound", "artifact lease is unavailable")
        })?;
        let lease: ArtifactLeaseMetadata = serde_json::from_slice(&bytes)
            .map_err(|_| ToolError::new("artifact.leaseNotFound", "artifact lease is invalid"))?;
        if lease.version != METADATA_VERSION
            || lease.lease_id != lease_id
            || lease.expires_at_ms <= now_ms()
        {
            return Err(ToolError::new(
                "artifact.leaseNotFound",
                "artifact lease is unavailable",
            ));
        }
        let metadata = self.load_metadata(&lease.handle)?;
        let data_path = self.data_path(&lease.handle);
        if !data_path.is_file() {
            return Err(ToolError::new(
                "artifact.contentUnavailable",
                "artifact content is unavailable",
            ));
        }
        Ok(ArtifactLease {
            blake3: metadata.blake3,
            data_path,
            lease_id: lease.lease_id,
            stored_bytes: metadata.stored_bytes,
            stream: metadata.stream,
        })
    }

    pub fn read(&self, input: ArtifactReadInput) -> Result<ArtifactReadOutput, ToolError> {
        validate_handle(&input.handle)?;
        let max_bytes = input.max_bytes.unwrap_or(DEFAULT_READ_BYTES);
        if max_bytes == 0 || max_bytes > MAX_READ_BYTES {
            return Err(ToolError::new(
                "tool.invalidArguments",
                format!("maxBytes must be between 1 and {MAX_READ_BYTES}"),
            ));
        }
        let offset = input.offset_bytes.unwrap_or(0);
        let encoding = input.encoding.unwrap_or_default();

        let _guard = self
            .guard
            .lock()
            .map_err(|_| ToolError::new("artifact.storageFailed", "artifact lock poisoned"))?;
        self.gc_locked(0)?;
        let metadata = self.load_metadata(&input.handle)?;
        if metadata.expires_at_ms <= now_ms() {
            return Err(ToolError::new(
                "artifact.expired",
                "artifact reference has expired",
            ));
        }
        if offset > metadata.stored_bytes as u64 {
            return Err(ToolError::new(
                "artifact.invalidOffset",
                "offsetBytes exceeds artifact size",
            ));
        }
        let mut file = fs::File::open(self.data_path(&input.handle))
            .map_err(|_| ToolError::new("artifact.notFound", "artifact is unavailable"))?;
        file.seek(SeekFrom::Start(offset))
            .map_err(|error| ToolError::new("artifact.readFailed", error.to_string()))?;
        let remaining = metadata.stored_bytes.saturating_sub(offset as usize);
        let requested = remaining.min(max_bytes);
        let mut bytes = vec![0; requested];
        file.read_exact(&mut bytes)
            .map_err(|error| ToolError::new("artifact.readFailed", error.to_string()))?;

        let (content, lossy) = match encoding {
            ArtifactEncoding::Utf8 => match String::from_utf8(bytes.clone()) {
                Ok(content) => (content, false),
                Err(_) => (String::from_utf8_lossy(&bytes).into_owned(), true),
            },
            ArtifactEncoding::Base64 => (STANDARD.encode(&bytes), false),
        };
        let next = offset.saturating_add(bytes.len() as u64);
        let eof = next >= metadata.stored_bytes as u64;

        Ok(ArtifactReadOutput {
            handle: metadata.handle,
            stream: metadata.stream,
            offset_bytes: offset,
            returned_bytes: bytes.len(),
            total_bytes: metadata.stored_bytes,
            source_bytes: metadata.source_bytes,
            content,
            encoding,
            lossy,
            eof,
            next_offset_bytes: (!eof).then_some(next),
            artifact_truncated: metadata.artifact_truncated,
            blake3: metadata.blake3,
            expires_at_ms: metadata.expires_at_ms,
        })
    }

    fn load_metadata(&self, handle: &str) -> Result<ArtifactMetadata, ToolError> {
        let path = self.metadata_path(handle);
        let bytes = fs::read(&path)
            .map_err(|_| ToolError::new("artifact.notFound", "artifact is unavailable"))?;
        let metadata: ArtifactMetadata = serde_json::from_slice(&bytes)
            .map_err(|_| ToolError::new("artifact.notFound", "artifact metadata is invalid"))?;
        if metadata.version != METADATA_VERSION || metadata.handle != handle {
            return Err(ToolError::new(
                "artifact.notFound",
                "artifact metadata is invalid",
            ));
        }
        Ok(metadata)
    }

    fn gc_locked(&self, incoming_bytes: usize) -> Result<(), ToolError> {
        let now = now_ms();
        let leases = self.leases(now)?;
        let leased_handles = leases
            .iter()
            .map(|lease| lease.handle.as_str())
            .collect::<std::collections::HashSet<_>>();
        let records = self.records()?;
        for record in &records {
            if record.metadata.expires_at_ms <= now
                && !leased_handles.contains(record.metadata.handle.as_str())
            {
                remove_record(record);
            }
        }
        let total = records
            .iter()
            .filter(|record| record.data_path.is_file())
            .map(|record| record.metadata.stored_bytes)
            .sum::<usize>();
        if total.saturating_add(incoming_bytes) > self.policy.instance_quota_bytes {
            return Err(ToolError::new(
                "artifact.quotaExceeded",
                "artifact exceeds the instance storage quota",
            ));
        }
        Ok(())
    }

    fn leases(&self, now: u128) -> Result<Vec<ArtifactLeaseMetadata>, ToolError> {
        let mut leases = Vec::new();
        for entry in fs::read_dir(&self.leases_dir)
            .map_err(|error| ToolError::new("artifact.storageFailed", error.to_string()))?
        {
            let entry = entry
                .map_err(|error| ToolError::new("artifact.storageFailed", error.to_string()))?;
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let lease = fs::read(&path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<ArtifactLeaseMetadata>(&bytes).ok());
            let Some(lease) = lease else {
                let _ = fs::remove_file(&path);
                continue;
            };
            if lease.version != METADATA_VERSION
                || validate_handle(&lease.lease_id).is_err()
                || validate_handle(&lease.handle).is_err()
                || lease.expires_at_ms <= now
            {
                let _ = fs::remove_file(&path);
                continue;
            }
            leases.push(lease);
        }
        Ok(leases)
    }

    fn records(&self) -> Result<Vec<ArtifactRecord>, ToolError> {
        let mut records = Vec::new();
        for entry in fs::read_dir(&self.root)
            .map_err(|error| ToolError::new("artifact.storageFailed", error.to_string()))?
        {
            let entry = entry
                .map_err(|error| ToolError::new("artifact.storageFailed", error.to_string()))?;
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let Some(handle) = path.file_stem().and_then(|value| value.to_str()) else {
                continue;
            };
            if validate_handle(handle).is_err() {
                let _ = fs::remove_file(&path);
                continue;
            }
            let metadata = match fs::read(&path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<ArtifactMetadata>(&bytes).ok())
            {
                Some(metadata)
                    if metadata.version == METADATA_VERSION && metadata.handle == handle =>
                {
                    metadata
                }
                _ => {
                    let _ = fs::remove_file(&path);
                    let _ = fs::remove_file(self.data_path(handle));
                    continue;
                }
            };
            let data_path = self.data_path(handle);
            if !data_path.is_file() {
                let _ = fs::remove_file(&path);
                continue;
            }
            records.push(ArtifactRecord {
                metadata,
                metadata_path: path,
                data_path,
            });
        }
        Ok(records)
    }

    fn data_path(&self, handle: &str) -> PathBuf {
        self.root.join(format!("{handle}.bin"))
    }

    fn metadata_path(&self, handle: &str) -> PathBuf {
        self.root.join(format!("{handle}.json"))
    }

    fn lease_path(&self, lease_id: &str) -> PathBuf {
        self.leases_dir.join(format!("{lease_id}.json"))
    }
}

impl ArtifactDraft {
    pub fn write_chunk(&mut self, bytes: &[u8]) -> Result<(), ToolError> {
        self.source_bytes = self.source_bytes.saturating_add(bytes.len());
        let remaining = self.stream_limit_bytes.saturating_sub(self.stored_bytes);
        let kept = remaining.min(bytes.len());
        if kept > 0 {
            self.file
                .write_all(&bytes[..kept])
                .map_err(|error| ToolError::new("artifact.storageFailed", error.to_string()))?;
            self.hasher.update(&bytes[..kept]);
            self.stored_bytes += kept;
        }
        if kept < bytes.len() {
            self.artifact_truncated = true;
        }
        Ok(())
    }
}

fn validate_handle(handle: &str) -> Result<(), ToolError> {
    let parsed = Uuid::parse_str(handle)
        .map_err(|_| ToolError::new("artifact.invalidHandle", "artifact handle is invalid"))?;
    if parsed.to_string() != handle {
        return Err(ToolError::new(
            "artifact.invalidHandle",
            "artifact handle is invalid",
        ));
    }
    Ok(())
}

fn write_metadata(
    root: &Path,
    target: &Path,
    metadata: &ArtifactMetadata,
) -> Result<(), ToolError> {
    write_json_metadata(root, target, metadata)
}

fn write_json_metadata<T: Serialize>(
    root: &Path,
    target: &Path,
    metadata: &T,
) -> Result<(), ToolError> {
    let mut temp = Builder::new()
        .prefix("metadata-")
        .suffix(".tmp")
        .tempfile_in(root)
        .map_err(|error| ToolError::new("artifact.storageFailed", error.to_string()))?;
    serde_json::to_writer(&mut temp, metadata)
        .map_err(|error| ToolError::new("artifact.storageFailed", error.to_string()))?;
    temp.flush()
        .map_err(|error| ToolError::new("artifact.storageFailed", error.to_string()))?;
    temp.as_file()
        .sync_all()
        .map_err(|error| ToolError::new("artifact.storageFailed", error.to_string()))?;
    temp.persist(target)
        .map_err(|error| ToolError::new("artifact.storageFailed", error.error.to_string()))?;
    Ok(())
}

fn remove_record(record: &ArtifactRecord) {
    let _ = fs::remove_file(&record.data_path);
    let _ = fs::remove_file(&record.metadata_path);
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

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::{ArtifactPolicy, ArtifactStore, now_ms};
    use crate::tools::artifact::types::{ArtifactEncoding, ArtifactReadInput, ArtifactStream};

    fn store(policy: ArtifactPolicy) -> (tempfile::TempDir, std::sync::Arc<ArtifactStore>) {
        let root = tempfile::tempdir().unwrap();
        let store = ArtifactStore::with_policy(root.path().join("artifacts"), policy).unwrap();
        (root, store)
    }

    #[test]
    fn stores_raw_bytes_and_reads_utf8_or_base64() {
        let (_root, store) = store(ArtifactPolicy {
            stream_limit_bytes: 8,
            instance_quota_bytes: 32,
            ttl: Duration::from_secs(60),
        });
        let mut draft = store.begin(ArtifactStream::Stdout).unwrap();
        draft.write_chunk(&[0xff, b'a', b'b']).unwrap();
        let reference = store.persist(draft).unwrap();

        let utf8 = store
            .read(ArtifactReadInput {
                handle: reference.handle.clone(),
                offset_bytes: None,
                max_bytes: None,
                encoding: Some(ArtifactEncoding::Utf8),
            })
            .unwrap();
        assert!(utf8.lossy);

        let base64 = store
            .read(ArtifactReadInput {
                handle: reference.handle,
                offset_bytes: None,
                max_bytes: None,
                encoding: Some(ArtifactEncoding::Base64),
            })
            .unwrap();
        assert_eq!(base64.content, "/2Fi");
        assert!(!base64.lossy);
    }

    #[test]
    fn quota_never_evicts_an_active_artifact_reference() {
        let (_root, store) = store(ArtifactPolicy {
            stream_limit_bytes: 8,
            instance_quota_bytes: 12,
            ttl: Duration::from_secs(60),
        });
        let mut first = store.begin(ArtifactStream::Stdout).unwrap();
        first.write_chunk(b"0123456789").unwrap();
        let first = store.persist(first).unwrap();
        assert_eq!(first.stored_bytes, 8);
        assert!(first.artifact_truncated);

        let mut second = store.begin(ArtifactStream::Stderr).unwrap();
        second.write_chunk(b"abcdefgh").unwrap();
        let error = store.persist(second).unwrap_err();
        assert_eq!(error.code, "artifact.quotaExceeded");
        assert!(
            store
                .read(ArtifactReadInput {
                    handle: first.handle,
                    offset_bytes: None,
                    max_bytes: None,
                    encoding: None,
                })
                .is_ok()
        );
    }

    #[test]
    fn expired_reference_is_unreadable_while_payload_lease_keeps_content() {
        let (_root, store) = store(ArtifactPolicy {
            stream_limit_bytes: 32,
            instance_quota_bytes: 64,
            ttl: Duration::from_millis(20),
        });
        let mut draft = store.begin(ArtifactStream::Stdout).unwrap();
        draft.write_chunk(b"leased content").unwrap();
        let reference = store.persist(draft).unwrap();
        let lease = store
            .acquire_lease(&reference.handle, now_ms() + 60_000)
            .unwrap();

        std::thread::sleep(Duration::from_millis(30));
        let error = store
            .read(ArtifactReadInput {
                handle: reference.handle.clone(),
                offset_bytes: None,
                max_bytes: None,
                encoding: None,
            })
            .unwrap_err();
        assert_eq!(error.code, "artifact.expired");
        assert!(store.data_path(&reference.handle).is_file());

        store.release_lease(&lease.lease_id).unwrap();
        assert!(!store.data_path(&reference.handle).exists());
    }
}
