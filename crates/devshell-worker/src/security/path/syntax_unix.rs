use crate::tools::ToolError;

use super::PathNamespace;

pub fn classify_and_validate(raw: &str) -> Result<PathNamespace, ToolError> {
    if raw.contains('\0') || raw.contains("//") {
        return Err(invalid_segment());
    }

    let namespace = if raw == "./" || raw.starts_with("./") {
        PathNamespace::Workspace
    } else if raw.starts_with('/') {
        PathNamespace::Absolute
    } else {
        return Err(ToolError::new(
            "file.invalidPath",
            "path must start with `./` or `/`",
        ));
    };

    let segments = match namespace {
        PathNamespace::Workspace => raw[2..].split('/'),
        PathNamespace::Absolute => raw[1..].split('/'),
    };
    for segment in segments {
        if segment == "." || segment == ".." {
            return Err(invalid_segment());
        }
    }

    Ok(namespace)
}

fn invalid_segment() -> ToolError {
    ToolError::new("file.invalidPath", "path contains an invalid segment")
}
