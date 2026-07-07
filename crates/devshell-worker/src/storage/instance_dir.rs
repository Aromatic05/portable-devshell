use std::path::PathBuf;

use crate::instance::InstanceName;
use crate::storage::{config_path, devshell_home};

#[derive(Clone, Debug)]
pub struct InstancePaths {
    pub instance_root: PathBuf,
    pub config_file: PathBuf,
    pub logs_dir: PathBuf,
    pub log_file: PathBuf,
    pub state_dir: PathBuf,
    pub pid_file: PathBuf,
    pub lock_file: PathBuf,
}

impl InstancePaths {
    pub fn resolve(instance: &InstanceName) -> Result<Self, String> {
        let home_root = devshell_home()?;
        let instance_root = home_root.join(instance.as_str());
        let logs_dir = instance_root.join("logs");
        let state_dir = instance_root.join("state");
        Ok(Self {
            config_file: config_path(&instance_root),
            log_file: logs_dir.join("worker.log"),
            pid_file: state_dir.join("worker.pid"),
            lock_file: state_dir.join("worker.lock"),
            instance_root,
            logs_dir,
            state_dir,
        })
    }
}
