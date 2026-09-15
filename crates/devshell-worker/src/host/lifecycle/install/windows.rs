use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use uuid::Uuid;
use windows_sys::Win32::Storage::FileSystem::{
    MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
};

use super::super::hex;

pub fn install(bytes: &[u8], home: &Path, target: &str, sha: &str) -> Result<PathBuf, String> {
    verify_payload(bytes, sha)?;
    let install_dir = home.join("workers").join(target).join(sha);
    let binary = install_dir.join("devshell-worker.exe");
    let sha_file = install_dir.join("devshell-worker.exe.sha256");

    fs::create_dir_all(&install_dir)
        .map_err(|error| format!("failed to create {}: {error}", install_dir.display()))?;

    if !installed_payload_is_valid(&binary, &sha_file, sha) {
        atomic_write(&binary, bytes)?;
        atomic_write(&sha_file, format!("{sha}\n").as_bytes())?;
        if !installed_payload_is_valid(&binary, &sha_file, sha) {
            return Err(format!(
                "installed worker verification failed after writing {}",
                binary.display()
            ));
        }
    }
    Ok(binary)
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

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("worker");
    let tmp = path.with_file_name(format!(".{name}.tmp-{}", Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&tmp)
            .map_err(|error| format!("failed to open {}: {error}", tmp.display()))?;
        file.write_all(bytes)
            .map_err(|error| format!("failed to write {}: {error}", tmp.display()))?;
        file.sync_all()
            .map_err(|error| format!("failed to sync {}: {error}", tmp.display()))?;
        replace_file(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    let destination_display = destination.display().to_string();
    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result != 0 {
        return Ok(());
    }
    Err(format!(
        "failed to replace {}: {}",
        destination_display,
        std::io::Error::last_os_error()
    ))
}
