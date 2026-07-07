use std::path::PathBuf;

use crate::instance::InstanceName;
use crate::socket::xdg_runtime_dir::xdg_runtime_dir;

#[derive(Clone, Debug)]
pub struct SocketPaths {
    pub instance_runtime_dir: PathBuf,
    pub socket_file: PathBuf,
}

impl SocketPaths {
    pub fn resolve(instance: &InstanceName) -> Result<Self, String> {
        let instance_runtime_dir = xdg_runtime_dir()?
            .join("devshell-worker")
            .join(instance.as_str());
        Ok(Self {
            socket_file: instance_runtime_dir.join("worker.sock"),
            instance_runtime_dir,
        })
    }
}
