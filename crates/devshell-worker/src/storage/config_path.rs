use std::path::{Path, PathBuf};

pub fn config_path(instance_root: &Path) -> PathBuf {
    instance_root.join("config.toml")
}
