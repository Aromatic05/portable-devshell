use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

pub fn install(bytes: &[u8], home: &Path, target: &str, sha: &str) -> Result<PathBuf, String> {
    let install_dir = home.join("workers").join(target).join(sha);
    let binary = install_dir.join("devshell-worker.exe");
    let sha_file = install_dir.join("devshell-worker.exe.sha256");

    fs::create_dir_all(&install_dir)
        .map_err(|error| format!("failed to create {}: {error}", install_dir.display()))?;

    if !binary.exists() {
        atomic_write(&binary, bytes)?;
        atomic_write(&sha_file, format!("{sha}\n").as_bytes())?;
    }
    Ok(binary)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&tmp)
        .map_err(|error| format!("failed to open {}: {error}", tmp.display()))?;
    file.write_all(bytes)
        .map_err(|error| format!("failed to write {}: {error}", tmp.display()))?;
    file.sync_all()
        .map_err(|error| format!("failed to sync {}: {error}", tmp.display()))?;
    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(_) => {
            let _ = fs::remove_file(path);
            fs::rename(&tmp, path)
                .map_err(|error| format!("failed to replace {}: {error}", path.display()))
        }
    }
}
