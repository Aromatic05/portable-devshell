use std::path::PathBuf;

use crate::tools::ToolError;
#[cfg(unix)]
#[path = "syntax_unix.rs"]
mod platform;
#[cfg(windows)]
#[path = "syntax_windows.rs"]
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
