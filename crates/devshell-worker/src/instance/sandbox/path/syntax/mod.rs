use std::path::{Path, PathBuf};

use crate::tool::ToolError;
#[cfg(unix)]
#[path = "unix.rs"]
mod platform;
#[cfg(windows)]
#[path = "windows.rs"]
mod platform;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PathNamespace {
    Workspace,
    Absolute,
}

#[derive(Clone, Debug)]
pub struct RequestedPath {
    pub namespace: PathNamespace,
    pub raw: String,
}

pub fn parse_requested_path(raw: &str) -> Result<RequestedPath, ToolError> {
    Ok(RequestedPath {
        namespace: platform::classify_and_validate(raw)?,
        raw: raw.to_string(),
    })
}

pub fn normalize_requested_path(raw: &str) -> Result<String, ToolError> {
    if raw == "." {
        return Ok("./".to_string());
    }
    if raw == "~" || raw.starts_with("~/") || cfg!(windows) && raw.starts_with("~\\") {
        return Err(ToolError::new(
            "file.invalidPath",
            "home-relative paths are not supported; use a workspace-relative or absolute path",
        ));
    }
    #[cfg(windows)]
    if let Some(relative) = raw.strip_prefix(".\\") {
        return Ok(format!("./{relative}"));
    }
    if raw == "./" || raw.starts_with("./") || Path::new(raw).is_absolute() {
        return Ok(raw.to_string());
    }
    Ok(format!("./{raw}"))
}

impl RequestedPath {
    pub fn path(&self, workspace: &std::path::Path) -> PathBuf {
        match self.namespace {
            PathNamespace::Workspace => {
                if self.raw == "./" {
                    workspace.to_path_buf()
                } else {
                    workspace.join(&self.raw[2..])
                }
            }
            PathNamespace::Absolute => PathBuf::from(&self.raw),
        }
    }
}
