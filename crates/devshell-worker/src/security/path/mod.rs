mod capability;
mod resolution;
mod syntax;

pub use capability::FilesystemCapability;
pub use resolution::{
    resolve_create_target, resolve_entry, resolve_existing_target, ResolvedDirectory,
    ResolvedEntry, ResolvedMetadata, ResolvedPath, ResolvedTarget,
};
pub use syntax::{parse_requested_path, PathNamespace, RequestedPath};
