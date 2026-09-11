use crate::tools::ToolError;
use crate::tools::artifact::types::{ArtifactReference, ArtifactStream};

const TOOL_RESULT_PATH_PREFIX: &str = "/.devshell/tool-results/";

#[derive(Clone, Debug)]
pub struct ToolResultPath {
    pub handle: String,
    pub stream: ArtifactStream,
}

pub fn tool_result_path(reference: &ArtifactReference) -> String {
    format!(
        "{TOOL_RESULT_PATH_PREFIX}{}/{}",
        reference.handle,
        match reference.stream {
            ArtifactStream::Stdout => "stdout",
            ArtifactStream::Stderr => "stderr",
        }
    )
}

pub fn parse_tool_result_path(raw: &str) -> Result<Option<ToolResultPath>, ToolError> {
    let Some(rest) = raw.strip_prefix(TOOL_RESULT_PATH_PREFIX) else {
        return Ok(None);
    };
    let mut parts = rest.split('/');
    let Some(handle) = parts.next().filter(|value| !value.is_empty()) else {
        return Err(invalid_tool_result_path());
    };
    let stream = match parts.next() {
        Some("stdout") => ArtifactStream::Stdout,
        Some("stderr") => ArtifactStream::Stderr,
        _ => return Err(invalid_tool_result_path()),
    };
    if parts.next().is_some() {
        return Err(invalid_tool_result_path());
    }
    Ok(Some(ToolResultPath {
        handle: handle.to_string(),
        stream,
    }))
}

fn invalid_tool_result_path() -> ToolError {
    ToolError::new(
        "file.invalidPath",
        "tool result path must use /.devshell/tool-results/<id>/<stdout|stderr>",
    )
}
