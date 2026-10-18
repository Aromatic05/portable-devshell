/// Sandbox-owned path error categories, independent of the File Tool protocol.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PathErrorKind {
    InvalidPath,
    #[cfg_attr(not(windows), allow(dead_code))]
    NotDirectory,
    NotFound,
    PathEscapesWorkspace,
    ReadFailed,
    WriteFailed,
}

impl PathErrorKind {
    /// Compatibility mapping is applied only when a Tool/RPC boundary exports the error.
    pub const fn file_code(self) -> &'static str {
        match self {
            Self::InvalidPath => "file.invalidPath",
            Self::NotDirectory => "file.notDirectory",
            Self::NotFound => "file.notFound",
            Self::PathEscapesWorkspace => "file.pathEscapesWorkspace",
            Self::ReadFailed => "file.readFailed",
            Self::WriteFailed => "file.writeFailed",
        }
    }
}

#[derive(Clone, Debug)]
pub struct PathError {
    pub kind: PathErrorKind,
    pub message: String,
}

impl PathError {
    pub fn new(kind: PathErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn file_code(&self) -> &'static str {
        self.kind.file_code()
    }
}

#[cfg(test)]
mod tests {
    use super::PathErrorKind;

    #[test]
    fn sandbox_errors_preserve_file_tool_wire_codes() {
        for (kind, expected) in [
            (PathErrorKind::InvalidPath, "file.invalidPath"),
            (PathErrorKind::NotDirectory, "file.notDirectory"),
            (PathErrorKind::NotFound, "file.notFound"),
            (
                PathErrorKind::PathEscapesWorkspace,
                "file.pathEscapesWorkspace",
            ),
            (PathErrorKind::ReadFailed, "file.readFailed"),
            (PathErrorKind::WriteFailed, "file.writeFailed"),
        ] {
            assert_eq!(kind.file_code(), expected);
        }
    }
}
