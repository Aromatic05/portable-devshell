use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub enum ExtensionResourceError {
    Invalid(String),
    Storage(String),
}

pub struct ExtensionResourceStore {
    instance_root: PathBuf,
}

impl ExtensionResourceStore {
    pub fn new(instance_root: PathBuf) -> Self {
        Self { instance_root }
    }

    pub fn prepare(
        &self,
        extension_id: &str,
        collection: &str,
    ) -> Result<PathBuf, ExtensionResourceError> {
        validate_namespace(extension_id, "extensionId")?;
        validate_namespace(collection, "collection")?;

        ensure_plain_directory(&self.instance_root)?;
        let mut path = self.instance_root.clone();
        for component in ["extensions", extension_id, "resources", collection] {
            path.push(component);
            ensure_plain_directory(&path)?;
        }
        Ok(path)
    }
}

fn validate_namespace(value: &str, label: &str) -> Result<(), ExtensionResourceError> {
    let mut chars = value.chars();
    let first = chars.next();
    if !matches!(first, Some(character) if character.is_ascii_lowercase())
        || chars.any(|character| {
            !(character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-')
        })
    {
        return Err(ExtensionResourceError::Invalid(format!(
            "{label} must match [a-z][a-z0-9-]*"
        )));
    }
    Ok(())
}

fn ensure_plain_directory(path: &Path) -> Result<(), ExtensionResourceError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(ExtensionResourceError::Storage(format!(
                    "resource path is not a plain directory: {}",
                    path.display()
                )));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match fs::create_dir(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    return ensure_plain_directory(path);
                }
                Err(error) => {
                    return Err(ExtensionResourceError::Storage(format!(
                        "failed to create resource directory {}: {error}",
                        path.display()
                    )));
                }
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|error| {
                    ExtensionResourceError::Storage(format!(
                        "failed to set resource directory permissions {}: {error}",
                        path.display()
                    ))
                })?;
            }
        }
        Err(error) => {
            return Err(ExtensionResourceError::Storage(format!(
                "failed to inspect resource directory {}: {error}",
                path.display()
            )));
        }
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use std::fs;
    use std::os::unix::fs::symlink;

    use tempfile::tempdir;

    use super::{ExtensionResourceError, ExtensionResourceStore};

    #[test]
    fn prepare_rejects_symlinked_resource_parent() {
        let root = tempdir().unwrap();
        let instance_root = root.path().join("instance");
        let outside = root.path().join("outside");
        fs::create_dir(&instance_root).unwrap();
        fs::create_dir(&outside).unwrap();
        symlink(&outside, instance_root.join("extensions")).unwrap();

        let store = ExtensionResourceStore::new(instance_root);
        let error = store.prepare("skill", "managed").unwrap_err();

        assert!(matches!(error, ExtensionResourceError::Storage(_)));
        assert!(!outside.join("skill").exists());
    }
}
