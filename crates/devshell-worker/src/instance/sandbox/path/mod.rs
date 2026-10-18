mod capability;
mod error;
mod resolution;
mod syntax;

pub use capability::FilesystemCapability;
pub use error::PathError;
pub use resolution::{
    ResolvedDirectory, ResolvedEntry, ResolvedMetadata, ResolvedPath, ResolvedTarget,
    create_parent_directories, resolve_create_candidate, resolve_create_target, resolve_entry,
    resolve_existing_target,
};
pub use syntax::{PathNamespace, RequestedPath, normalize_requested_path, parse_requested_path};
