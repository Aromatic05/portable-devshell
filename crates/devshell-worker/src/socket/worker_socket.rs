use std::path::PathBuf;
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;

use crate::instance::InstanceName;
use crate::storage::devshell_home;
use crate::socket::xdg_runtime_dir::xdg_runtime_dir;

#[cfg(unix)]
const MAX_UNIX_SOCKET_PATH_BYTES: usize = 100;

#[derive(Clone, Debug)]
pub struct SocketPaths {
    pub instance_runtime_dir: PathBuf,
    pub socket_file: PathBuf,
    #[cfg(unix)]
    pub tmux_socket_file: PathBuf,
}

impl SocketPaths {
    pub fn resolve(instance: &InstanceName) -> Result<Self, String> {
        let default_runtime_dir = xdg_runtime_dir()?
            .join("devshell-worker")
            .join(instance.as_str());
        #[cfg(unix)]
        let instance_runtime_dir = {
            let socket_file = default_runtime_dir.join("worker.sock");
            if socket_file.as_os_str().as_bytes().len() <= MAX_UNIX_SOCKET_PATH_BYTES {
                default_runtime_dir
            } else {
                short_runtime_dir(instance)?
            }
        };
        #[cfg(windows)]
        let instance_runtime_dir = default_runtime_dir;
        #[cfg(unix)]
        let socket_file = instance_runtime_dir.join("worker.sock");
        #[cfg(windows)]
        let socket_file = PathBuf::from(format!(
            r"\\.\pipe\devshell-worker-{}-{}",
            windows_user_identity(),
            instance.as_str()
        ));
        Ok(Self {
            socket_file,
            #[cfg(unix)]
            tmux_socket_file: instance_runtime_dir.join("tmux.sock"),
            instance_runtime_dir,
        })
    }
}

#[cfg(unix)]
fn short_runtime_dir(instance: &InstanceName) -> Result<PathBuf, String> {
    let identity = format!("{}:{}", devshell_home()?.display(), instance.as_str());
    let hash = blake3::hash(identity.as_bytes()).to_hex();
    Ok(PathBuf::from("/tmp").join(format!("devshell-worker-{}", &hash[..16])))
}

#[cfg(windows)]
fn windows_user_identity() -> String {
    let raw = std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "user".to_string());
    let normalized = raw
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    if normalized.is_empty() {
        "user".to_string()
    } else {
        normalized
    }
}
