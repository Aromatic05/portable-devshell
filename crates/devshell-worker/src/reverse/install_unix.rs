use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt, symlink};
use std::path::{Path, PathBuf};

pub fn install(bytes: &[u8], home: &Path, target: &str, sha: &str) -> Result<PathBuf, String> {
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

    if !binary.exists() {
        atomic_write(&binary, bytes, 0o755)?;
        atomic_write(&sha_file, format!("{sha}\n").as_bytes(), 0o600)?;
    }

    if symlink_path.exists() || symlink_path.symlink_metadata().is_ok() {
        fs::remove_file(&symlink_path)
            .map_err(|error| format!("failed to replace {}: {error}", symlink_path.display()))?;
    }
    symlink(
        PathBuf::from("../workers")
            .join(target)
            .join(sha)
            .join("devshell-worker"),
        &symlink_path,
    )
    .map_err(|error| format!("failed to create {}: {error}", symlink_path.display()))?;
    Ok(symlink_path)
}

fn atomic_write(path: &Path, bytes: &[u8], mode: u32) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(mode)
        .open(&tmp)
        .map_err(|error| format!("failed to open {}: {error}", tmp.display()))?;
    file.write_all(bytes)
        .map_err(|error| format!("failed to write {}: {error}", tmp.display()))?;
    file.sync_all()
        .map_err(|error| format!("failed to sync {}: {error}", tmp.display()))?;
    fs::rename(&tmp, path)
        .map_err(|error| format!("failed to replace {}: {error}", path.display()))?;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .map_err(|error| format!("failed to set mode on {}: {error}", path.display()))?;
    Ok(())
}
