mod store;

pub use store::*;

#[cfg(test)]
mod tests {
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use std::time::{SystemTime, UNIX_EPOCH};

    use base64::{Engine as _, engine::general_purpose::STANDARD};

    use super::{ArtifactReceiveBeginInput, ArtifactReceiveStore};
    use crate::security::policy::DisabledSecurityPolicy;
    use crate::tools::artifact::payload::{
        ArtifactPayloadDescriptor, ArtifactPayloadStore, ArtifactPayloadType,
    };
    use crate::tools::artifact::store::ArtifactStore;

    fn expires_at_ms() -> u128 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis()
            + 60_000
    }

    fn file_descriptor(bytes: &[u8]) -> ArtifactPayloadDescriptor {
        ArtifactPayloadDescriptor {
            payload_type: ArtifactPayloadType::File,
            name: "result.bin".to_string(),
            media_type: "application/octet-stream".to_string(),
            payload_bytes: bytes.len(),
            payload_blake3: blake3::hash(bytes).to_hex().to_string(),
            logical_bytes: None,
            entry_count: None,
            manifest_blake3: None,
        }
    }

    #[test]
    fn receives_file_with_strict_offsets_and_atomic_commit() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let store = ArtifactReceiveStore::new(root.path().join("receives")).unwrap();
        let bytes = b"received bytes";
        let begun = store
            .begin(
                &workspace,
                &DisabledSecurityPolicy,
                ArtifactReceiveBeginInput {
                    descriptor: file_descriptor(bytes),
                    overwrite: false,
                    target_path: "./result.bin".to_string(),
                },
            )
            .unwrap();

        let wrong_offset = store
            .write(&begun.receive_id, 1, STANDARD.encode(&bytes[..4]))
            .unwrap_err();
        assert_eq!(wrong_offset.code, "artifact.receiveOffsetMismatch");

        let first = store
            .write(&begun.receive_id, 0, STANDARD.encode(&bytes[..4]))
            .unwrap();
        assert_eq!(first.next_offset_bytes, 4);
        let second = store
            .write(&begun.receive_id, 4, STANDARD.encode(&bytes[4..]))
            .unwrap();
        assert_eq!(second.next_offset_bytes, bytes.len() as u64);

        let finished = store.finish(&begun.receive_id).unwrap();
        assert_eq!(finished.bytes, bytes.len());
        assert_eq!(fs::read(workspace.join("result.bin")).unwrap(), bytes);
        assert!(!begun.temporary_path.exists());
    }

    #[test]
    fn refuses_existing_target_without_overwrite_and_abort_cleans_state() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        fs::write(workspace.join("result.bin"), b"existing").unwrap();
        let store = ArtifactReceiveStore::new(root.path().join("receives")).unwrap();

        let error = store
            .begin(
                &workspace,
                &DisabledSecurityPolicy,
                ArtifactReceiveBeginInput {
                    descriptor: file_descriptor(b"replacement"),
                    overwrite: false,
                    target_path: "./result.bin".to_string(),
                },
            )
            .unwrap_err();
        assert_eq!(error.code, "artifact.targetExists");

        let begun = store
            .begin(
                &workspace,
                &DisabledSecurityPolicy,
                ArtifactReceiveBeginInput {
                    descriptor: file_descriptor(b"replacement"),
                    overwrite: true,
                    target_path: "./result.bin".to_string(),
                },
            )
            .unwrap();
        store.abort(&begun.receive_id).unwrap();
        assert_eq!(fs::read(workspace.join("result.bin")).unwrap(), b"existing");
        assert!(!begun.temporary_path.exists());
    }

    #[test]
    fn restores_directory_archive_and_verifies_manifest() {
        let root = tempfile::tempdir().unwrap();
        let source_workspace = root.path().join("source");
        let source = source_workspace.join("dist");
        fs::create_dir_all(source.join("assets")).unwrap();
        fs::write(source.join("index.html"), b"index").unwrap();
        fs::write(source.join("assets/app.js"), b"app").unwrap();
        #[cfg(unix)]
        {
            fs::set_permissions(
                source.join("assets/app.js"),
                fs::Permissions::from_mode(0o755),
            )
            .unwrap();
        }

        let artifacts = ArtifactStore::new(root.path().join("artifacts")).unwrap();
        let payloads = ArtifactPayloadStore::new(root.path().join("payloads"), artifacts).unwrap();
        let payload = payloads
            .open_path(
                &source_workspace,
                "./dist",
                &DisabledSecurityPolicy,
                expires_at_ms(),
            )
            .unwrap();
        let chunk = payloads
            .read(&payload.payload_id, 0, payload.descriptor.payload_bytes)
            .unwrap();

        let target_workspace = root.path().join("target");
        fs::create_dir(&target_workspace).unwrap();
        let receives = ArtifactReceiveStore::new(root.path().join("receives")).unwrap();
        let begun = receives
            .begin(
                &target_workspace,
                &DisabledSecurityPolicy,
                ArtifactReceiveBeginInput {
                    descriptor: payload.descriptor.clone(),
                    overwrite: false,
                    target_path: "./app".to_string(),
                },
            )
            .unwrap();
        receives.write(&begun.receive_id, 0, chunk.content).unwrap();
        receives.finish(&begun.receive_id).unwrap();

        assert_eq!(
            fs::read(target_workspace.join("app/index.html")).unwrap(),
            b"index"
        );
        assert_eq!(
            fs::read(target_workspace.join("app/assets/app.js")).unwrap(),
            b"app"
        );
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(target_workspace.join("app/assets/app.js"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o755
        );
    }

    #[test]
    fn reopening_store_cleans_abandoned_receive_files() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let receive_root = root.path().join("receives");
        let begun = ArtifactReceiveStore::new(receive_root.clone())
            .unwrap()
            .begin(
                &workspace,
                &DisabledSecurityPolicy,
                ArtifactReceiveBeginInput {
                    descriptor: file_descriptor(b"abandoned"),
                    overwrite: false,
                    target_path: "./abandoned.bin".to_string(),
                },
            )
            .unwrap();
        assert!(begun.temporary_path.exists());

        drop(ArtifactReceiveStore::new(receive_root).unwrap());
        assert!(!begun.temporary_path.exists());
        assert!(!workspace.join("abandoned.bin").exists());
    }
}
