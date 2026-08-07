use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt, symlink};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::super::hex;

pub fn install(bytes: &[u8], home: &Path, target: &str, sha: &str) -> Result<PathBuf, String> {
    verify_payload(bytes, sha)?;
    let install_dir = home.join("workers").join(target).join(sha);
    let bin_dir = home.join("bin");
    let binary = install_dir.join("devshell-worker");
    let sha_file = install_dir.join("devshell-worker.sha256");
    let symlink_path = bin_dir.join("devshell-worker");

    fs::create_dir_all(&install_dir)
        .map_err(|error| format!("failed to create {}: {error}", install_dir.display()))?;
    fs::create_dir_all(&bin_dir)
        .map_err(|error| format!("failed to create {}: {error}", bin_dir.display()))?;
    fs::set_permissions(&install_dir, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("failed to protect {}: {error}", install_dir.display()))?;
    fs::set_permissions(&bin_dir, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("failed to protect {}: {error}", bin_dir.display()))?;

    if !installed_payload_is_valid(&binary, &sha_file, sha) {
        atomic_write(&binary, bytes, 0o755)?;
        atomic_write(&sha_file, format!("{sha}\n").as_bytes(), 0o600)?;
        if !installed_payload_is_valid(&binary, &sha_file, sha) {
            return Err(format!(
                "installed worker verification failed after writing {}",
                binary.display()
            ));
        }
    }

    let target_path = PathBuf::from("../workers")
        .join(target)
        .join(sha)
        .join("devshell-worker");
    activate_alias(&symlink_path, &target_path)?;
    sync_directory(&bin_dir)?;
    Ok(symlink_path)
}

fn verify_payload(bytes: &[u8], expected_sha: &str) -> Result<(), String> {
    let actual = hex(&Sha256::digest(bytes));
    if actual != expected_sha {
        return Err(format!(
            "worker bundle checksum mismatch: expected {expected_sha}, got {actual}"
        ));
    }
    Ok(())
}

fn installed_payload_is_valid(binary: &Path, sha_file: &Path, expected_sha: &str) -> bool {
    let Ok(bytes) = fs::read(binary) else {
        return false;
    };
    let Ok(recorded) = fs::read_to_string(sha_file) else {
        return false;
    };
    recorded.trim() == expected_sha && hex(&Sha256::digest(&bytes)) == expected_sha
}

fn activate_alias(path: &Path, target: &Path) -> Result<(), String> {
    activate_alias_with(path, target, |source, destination| {
        fs::rename(source, destination)
    })
}

fn activate_alias_with<F>(path: &Path, target: &Path, rename_alias: F) -> Result<(), String>
where
    F: FnOnce(&Path, &Path) -> std::io::Result<()>,
{
    let temp = path.with_file_name(format!(
        ".{}.next-{}",
        path.file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("devshell-worker"),
        Uuid::new_v4()
    ));
    symlink(target, &temp)
        .map_err(|error| format!("failed to create staged alias {}: {error}", temp.display()))?;
    match rename_alias(&temp, path) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = fs::remove_file(&temp);
            Err(format!(
                "failed to activate worker alias {}: {error}",
                path.display()
            ))
        }
    }
}

fn atomic_write(path: &Path, bytes: &[u8], mode: u32) -> Result<(), String> {
    let tmp = path.with_file_name(format!(
        ".{}.tmp-{}",
        path.file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("worker"),
        Uuid::new_v4()
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(mode)
            .open(&tmp)
            .map_err(|error| format!("failed to open {}: {error}", tmp.display()))?;
        file.write_all(bytes)
            .map_err(|error| format!("failed to write {}: {error}", tmp.display()))?;
        file.sync_all()
            .map_err(|error| format!("failed to sync {}: {error}", tmp.display()))?;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(mode))
            .map_err(|error| format!("failed to set mode on {}: {error}", tmp.display()))?;
        fs::rename(&tmp, path)
            .map_err(|error| format!("failed to replace {}: {error}", path.display()))?;
        if let Some(parent) = path.parent() {
            sync_directory(parent)?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn sync_directory(path: &Path) -> Result<(), String> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("failed to sync directory {}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io;

    use sha2::{Digest, Sha256};

    use super::{activate_alias_with, install};
    use crate::reverse::hex;

    #[test]
    fn validates_repairs_and_atomically_switches_worker_bundle() {
        let home = crate::testing::temp_dir();
        let first = b"worker-v1";
        let first_sha = hex(&Sha256::digest(first));
        let alias = install(first, home.path(), "linux-x64", &first_sha).expect("install v1");
        let first_target = fs::read_link(&alias).expect("read v1 alias");

        let installed = home
            .path()
            .join("workers/linux-x64")
            .join(&first_sha)
            .join("devshell-worker");
        fs::write(&installed, b"corrupt").expect("corrupt installed binary");
        install(first, home.path(), "linux-x64", &first_sha).expect("repair v1");
        assert_eq!(fs::read(&installed).expect("read repaired binary"), first);

        let second = b"worker-v2";
        let second_sha = hex(&Sha256::digest(second));
        install(second, home.path(), "linux-x64", &second_sha).expect("install v2");
        assert_ne!(fs::read_link(&alias).expect("read v2 alias"), first_target);

        let mismatch = install(second, home.path(), "linux-x64", &first_sha)
            .expect_err("checksum mismatch must fail");
        assert!(mismatch.contains("checksum mismatch"));
    }

    #[test]
    fn alias_activation_failure_preserves_previous_worker() {
        let home = crate::testing::temp_dir();
        let bin = home.path().join("bin");
        fs::create_dir_all(&bin).expect("create bin");
        let alias = bin.join("devshell-worker");
        std::os::unix::fs::symlink("../workers/old/devshell-worker", &alias)
            .expect("create old alias");
        let previous = fs::read_link(&alias).expect("read previous alias");

        let error = activate_alias_with(
            &alias,
            std::path::Path::new("../workers/new/devshell-worker"),
            |_source, _destination| Err(io::Error::other("injected rename failure")),
        )
        .expect_err("activation must fail");

        assert!(error.contains("injected rename failure"));
        assert_eq!(fs::read_link(&alias).expect("old alias remains"), previous);
    }
}
