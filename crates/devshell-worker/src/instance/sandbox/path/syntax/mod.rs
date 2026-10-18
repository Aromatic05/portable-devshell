use std::path::{Path, PathBuf};

use super::{PathError, PathErrorKind};
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

pub fn parse_requested_path(raw: &str) -> Result<RequestedPath, PathError> {
    Ok(RequestedPath {
        namespace: platform::classify_and_validate(raw)?,
        raw: raw.to_string(),
    })
}

pub fn normalize_requested_path(raw: &str) -> Result<String, PathError> {
    if raw == "." {
        return Ok("./".to_string());
    }
    if raw == "~" || raw.starts_with("~/") || cfg!(windows) && raw.starts_with("~\\") {
        return Err(PathError::new(
            PathErrorKind::InvalidPath,
            "home-relative paths are not supported; use a workspace-relative or absolute path",
        ));
    }
    #[cfg(windows)]
    {
        let path = Path::new(raw);
        if !path.is_absolute()
            && (path.has_root()
                || matches!(
                    path.components().next(),
                    Some(std::path::Component::Prefix(_))
                ))
        {
            return Err(PathError::new(
                PathErrorKind::InvalidPath,
                "Windows drive-relative and root-relative paths are not supported; use a workspace-relative or absolute path",
            ));
        }
        if let Some(relative) = raw.strip_prefix(".\\") {
            return Ok(format!("./{relative}"));
        }
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

#[cfg(all(test, windows))]
mod tests {
    use super::normalize_requested_path;

    #[test]
    fn bare_normalization_rejects_windows_drive_relative_paths() {
        let error = normalize_requested_path("C:relative").unwrap_err();
        assert_eq!(error.kind, PathErrorKind::InvalidPath);
        let error = normalize_requested_path(r"\relative").unwrap_err();
        assert_eq!(error.kind, PathErrorKind::InvalidPath);
        let error = normalize_requested_path("/relative").unwrap_err();
        assert_eq!(error.kind, PathErrorKind::InvalidPath);
    }
}
