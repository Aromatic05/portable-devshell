use std::path::PathBuf;

use crate::tools::ToolError;

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
    if raw.contains('\0') || raw.contains("//") {
        return Err(ToolError::new("file.invalidPath", "path contains an invalid segment"));
    }
    let namespace = if raw == "./" || raw.starts_with("./") {
        PathNamespace::Workspace
    } else if raw.starts_with('/') {
        PathNamespace::Absolute
    } else {
        return Err(ToolError::new("file.invalidPath", "path must start with `./` or `/`"));
    };
    let segments = match namespace {
        PathNamespace::Workspace => raw.trim_start_matches("./").split('/'),
        PathNamespace::Absolute => raw.trim_start_matches('/').split('/'),
    };
    for segment in segments {
        if segment == "." || segment == ".." {
            return Err(ToolError::new("file.invalidPath", "path contains an invalid segment"));
        }
    }
    Ok(RequestedPath { namespace, raw: raw.to_string() })
}

impl RequestedPath {
    pub fn path(&self, workspace: &std::path::Path) -> PathBuf {
        match self.namespace {
            PathNamespace::Workspace => {
                if self.raw == "./" { workspace.to_path_buf() } else { workspace.join(&self.raw[2..]) }
            }
            PathNamespace::Absolute => PathBuf::from(&self.raw),
        }
    }
}
