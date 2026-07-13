use std::path::PathBuf;

use crate::instance::InstanceName;
use crate::socket::xdg_runtime_dir::xdg_runtime_dir;

#[derive(Clone, Debug)]
pub struct SocketPaths {
    pub instance_runtime_dir: PathBuf,
    pub socket_file: PathBuf,
    #[cfg(unix)]
    pub tmux_socket_file: PathBuf,
}

impl SocketPaths {
    pub fn resolve(instance: &InstanceName) -> Result<Self, String> {
        let instance_runtime_dir = xdg_runtime_dir()?
            .join("devshell-worker")
            .join(instance.as_str());
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
