pub mod payload;
pub mod receive;
pub use receive::direct;
pub mod store;

pub(crate) fn unix_time_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

pub mod types {
    use schemars::JsonSchema;
    use serde::{Deserialize, Serialize};

    #[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub enum ArtifactStream {
        Stdout,
        Stderr,
    }

    #[derive(Clone, Debug, JsonSchema, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct ArtifactReference {
        pub handle: String,
        pub stream: ArtifactStream,
        pub source_bytes: usize,
        pub stored_bytes: usize,
        pub artifact_truncated: bool,
        pub blake3: String,
        pub expires_at_ms: u128,
    }
}

pub mod result_path {
    use crate::capability::artifact::types::{ArtifactReference, ArtifactStream};
    use crate::tool::ToolError;

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
}

mod storage {
    use std::fs;
    use std::io::Write;
    use std::path::{Path, PathBuf};

    use serde::{Serialize, de::DeserializeOwned};
    use tempfile::Builder;
    use uuid::Uuid;

    use crate::tool::ToolError;

    pub(super) fn clear_temp_files(path: &Path) -> Result<(), ToolError> {
        for entry in fs::read_dir(path).map_err(storage_error)? {
            let entry = entry.map_err(storage_error)?;
            if entry.file_type().map_err(storage_error)?.is_file() {
                fs::remove_file(entry.path()).map_err(storage_error)?;
            }
        }
        Ok(())
    }

    pub(super) fn json_files(path: &Path) -> Result<Vec<PathBuf>, ToolError> {
        let mut files = Vec::new();
        for entry in fs::read_dir(path).map_err(storage_error)? {
            let path = entry.map_err(storage_error)?.path();
            if path.extension().and_then(|value| value.to_str()) == Some("json") {
                files.push(path);
            }
        }
        Ok(files)
    }

    pub(super) fn ensure_private_dir(path: &Path) -> Result<(), ToolError> {
        crate::instance::storage::ensure_dir(path, 0o700)
            .map_err(|error| ToolError::new("artifact.storageFailed", error))
    }

    pub(super) fn remove_file_if_exists(path: &Path) -> Result<(), ToolError> {
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(storage_error(error)),
        }
    }

    pub(super) fn validate_uuid(value: &str, code: &str, message: &str) -> Result<(), ToolError> {
        let parsed = Uuid::parse_str(value).map_err(|_| ToolError::new(code, message))?;
        if parsed.to_string() != value {
            return Err(ToolError::new(code, message));
        }
        Ok(())
    }

    pub(super) fn read_json<T: DeserializeOwned>(
        path: &Path,
        code: &str,
        unavailable: &str,
        invalid: &str,
        validate: impl FnOnce(&T) -> bool,
    ) -> Result<T, ToolError> {
        let bytes = fs::read(path).map_err(|_| ToolError::new(code, unavailable))?;
        let metadata = serde_json::from_slice(&bytes).map_err(|_| ToolError::new(code, invalid))?;
        if !validate(&metadata) {
            return Err(ToolError::new(code, invalid));
        }
        Ok(metadata)
    }

    pub(super) fn write_json<T: Serialize>(
        root: &Path,
        target: &Path,
        prefix: &str,
        value: &T,
    ) -> Result<(), ToolError> {
        let mut temp = Builder::new()
            .prefix(prefix)
            .suffix(".tmp")
            .tempfile_in(root)
            .map_err(storage_error)?;
        serde_json::to_writer(&mut temp, value).map_err(storage_error)?;
        temp.flush().map_err(storage_error)?;
        temp.as_file().sync_all().map_err(storage_error)?;
        temp.persist(target)
            .map_err(|error| storage_error(error.error))?;
        Ok(())
    }

    fn storage_error(error: impl ToString) -> ToolError {
        ToolError::new("artifact.storageFailed", error.to_string())
    }
}
