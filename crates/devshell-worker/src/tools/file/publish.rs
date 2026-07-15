use std::fs;
use std::io;
use std::path::Path;

use tempfile::NamedTempFile;

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


#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::Write;

    use tempfile::tempdir;

    use super::{PublishMode, new_temp, publish};

    #[test]
    fn no_clobber_publish_never_replaces_a_racing_target() {
        let directory = tempdir().unwrap();
        let target = directory.path().join("target.txt");
        fs::write(&target, "existing").unwrap();
        let mut temp = new_temp(&target).unwrap();
        temp.write_all(b"replacement").unwrap();

        let error = publish(temp, &target, PublishMode::NoClobber).unwrap_err();

        assert_eq!(error.code, "file.alreadyExists");
        assert_eq!(fs::read_to_string(target).unwrap(), "existing");
    }
}
