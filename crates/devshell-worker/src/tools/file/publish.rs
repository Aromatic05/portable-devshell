use std::fs;
use std::io::{self, Write};
use std::path::Path;

use tempfile::NamedTempFile;
use uuid::Uuid;

use crate::security::path::ResolvedTarget;
use crate::tools::ToolError;

pub enum PublishMode {
    Replace,
    NoClobber,
}

pub fn new_temp(target: &Path) -> Result<NamedTempFile, ToolError> {
    let parent = target
        .parent()
        .ok_or_else(|| ToolError::new("file.writeFailed", "target has no parent"))?;
    fs::create_dir_all(parent)
        .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
    NamedTempFile::new_in(parent)
        .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))
}

pub fn publish(temp: NamedTempFile, target: &Path, mode: PublishMode) -> Result<(), ToolError> {
    match mode {
        PublishMode::Replace => temp
            .persist(target)
            .map(|_| ())
            .map_err(|error| ToolError::new("file.writeFailed", error.error.to_string())),
        PublishMode::NoClobber => temp.persist_noclobber(target).map(|_| ()).map_err(|error| {
            if error.error.kind() == io::ErrorKind::AlreadyExists {
                ToolError::new("file.alreadyExists", "destination already exists")
            } else {
                ToolError::new("file.writeFailed", error.error.to_string())
            }
        }),
    }
}

pub fn write_atomic(
    target: &ResolvedTarget,
    bytes: &[u8],
    mode: PublishMode,
    permissions: Option<u32>,
    before_publish: impl FnOnce() -> Result<(), ToolError>,
) -> Result<(), ToolError> {
    if !target.is_anchored() {
        let mut temp = new_temp(target.path())?;
        temp.write_all(bytes)
            .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
        temp.flush()
            .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
        #[cfg(unix)]
        if let Some(mode) = permissions {
            use std::os::unix::fs::PermissionsExt;
            temp.as_file()
                .set_permissions(fs::Permissions::from_mode(mode))
                .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
        }
        before_publish()?;
        return publish(temp, target.path(), mode);
    }

    let temporary = target
        .sibling(&format!(".devshell-publish-{}.tmp", Uuid::new_v4()))
        .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
    let result = (|| {
        let mut file = temporary
            .create_file_new()
            .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
        file.write_all(bytes)
            .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
        file.flush()
            .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
        file.sync_all()
            .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
        if let Some(mode) = permissions {
            temporary
                .set_permissions(mode)
                .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
        }
        before_publish()?;
        match mode {
            PublishMode::Replace => temporary
                .rename_to(target)
                .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?,
            PublishMode::NoClobber => {
                temporary.hard_link_to(target).map_err(|error| {
                    if error.kind() == io::ErrorKind::AlreadyExists {
                        ToolError::new("file.alreadyExists", "destination already exists")
                    } else {
                        ToolError::new("file.writeFailed", error.to_string())
                    }
                })?;
                temporary
                    .remove()
                    .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
            }
        }
        target
            .sync_parent()
            .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))
    })();
    if result.is_err() {
        let _ = temporary.remove();
    }
    result
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::Write;

    use super::{PublishMode, new_temp, publish};

    #[test]
    fn no_clobber_publish_never_replaces_a_racing_target() {
        let directory = crate::testing::temp_dir();
        let target = directory.path().join("target.txt");
        fs::write(&target, "existing").unwrap();
        let mut temp = new_temp(&target).unwrap();
        temp.write_all(b"replacement").unwrap();

        let error = publish(temp, &target, PublishMode::NoClobber).unwrap_err();

        assert_eq!(error.code, "file.alreadyExists");
        assert_eq!(fs::read_to_string(target).unwrap(), "existing");
    }
}
