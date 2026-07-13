use std::path::Path;

use crate::tools::ToolError;

use super::PathNamespace;

pub fn classify_and_validate(raw: &str) -> Result<PathNamespace, ToolError> {
    if raw.contains('\0') {
        return Err(invalid_segment());
    }

    let namespace = if raw == "./" || raw.starts_with("./") {
        PathNamespace::Workspace
    } else if Path::new(raw).is_absolute() && !raw.starts_with("\\\\") {
        PathNamespace::Absolute
    } else {
        return Err(ToolError::new(
            "file.invalidPath",
            "path must start with `./` or use an absolute Windows drive path",
        ));
    };

    let normalized = raw.replace('\\', "/");
    let value = if namespace == PathNamespace::Workspace {
        normalized.strip_prefix("./").unwrap_or("")
    } else {
        normalized.as_str()
    };
    if value.contains("//") {
        return Err(invalid_segment());
    }

    let segments = value.split('/').collect::<Vec<_>>();
    for (index, segment) in segments.iter().enumerate() {
        let workspace_root =
            segment.is_empty() && namespace == PathNamespace::Workspace && value.is_empty();
        let trailing_separator = segment.is_empty()
            && namespace == PathNamespace::Absolute
            && index + 1 == segments.len();
        if workspace_root || trailing_separator {
            continue;
        }
        if segment.is_empty() || *segment == "." || *segment == ".." {
            return Err(invalid_segment());
        }
    }

    Ok(namespace)
}

fn invalid_segment() -> ToolError {
    ToolError::new("file.invalidPath", "path contains an invalid segment")
}
