use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use globset::Glob;
use ignore::WalkBuilder;

use crate::security::path::parse_requested_path;
use crate::tools::file::{authorize, resolve_existing};
use crate::tools::{ToolCall, ToolError};

pub struct DiscoveredEntry {
    pub display: String,
    pub path: PathBuf,
    pub entry_type: &'static str,
}

pub fn discover(
    call: &ToolCall,
    specs: &[String],
    hidden: bool,
    gitignore: bool,
) -> Result<Vec<DiscoveredEntry>, ToolError> {
    if specs.is_empty() {
        return Err(ToolError::new(
            "tool.invalidArguments",
            "paths cannot be empty",
        ));
    }
    let mut found = BTreeMap::<String, DiscoveredEntry>::new();
    for spec in specs {
        if has_glob(spec) {
            discover_glob(call, spec, hidden, gitignore, &mut found)?;
        } else {
            discover_exact(call, spec, hidden, gitignore, &mut found)?;
        }
    }
    Ok(found.into_values().collect())
}

fn discover_exact(
    call: &ToolCall,
    spec: &str,
    hidden: bool,
    gitignore: bool,
    found: &mut BTreeMap<String, DiscoveredEntry>,
) -> Result<(), ToolError> {
    let (requested, path) = resolve_existing(call, spec, false)?;
    let metadata = std::fs::symlink_metadata(&path)
        .map_err(|error| ToolError::new("file.notFound", error.to_string()))?;
    if metadata.is_file() || metadata.file_type().is_symlink() {
        insert(found, requested.raw, path, kind(&metadata));
        return Ok(());
    }
    if !metadata.is_dir() {
        return Ok(());
    }
    walk(&path, &requested.raw, None, hidden, gitignore, found)
}

fn discover_glob(
    call: &ToolCall,
    spec: &str,
    hidden: bool,
    gitignore: bool,
    found: &mut BTreeMap<String, DiscoveredEntry>,
) -> Result<(), ToolError> {
    let requested = parse_requested_path(spec)?;
    authorize(call, requested.namespace, false)?;
    let wildcard = spec
        .find(['*', '?', '['])
        .ok_or_else(|| ToolError::new("file.invalidPattern", "glob has no wildcard"))?;
    let slash = spec[..wildcard]
        .rfind('/')
        .unwrap_or(if spec.starts_with("./") { 1 } else { 0 });
    let root_raw = if slash <= 1 && spec.starts_with("./") {
        "./"
    } else {
        &spec[..slash]
    };
    let pattern = spec[slash + 1..].to_string();
    let (root_requested, root) = resolve_existing(call, root_raw, false)?;
    if !root.is_dir() {
        return Err(ToolError::new(
            "file.notDirectory",
            "glob root is not a directory",
        ));
    }
    let matcher = Glob::new(&pattern)
        .map_err(|error| ToolError::new("file.invalidPattern", error.to_string()))?
        .compile_matcher();
    walk(
        &root,
        &root_requested.raw,
        Some(&matcher),
        hidden,
        gitignore,
        found,
    )
}

fn walk(
    root: &Path,
    display_root: &str,
    matcher: Option<&globset::GlobMatcher>,
    hidden: bool,
    gitignore: bool,
    found: &mut BTreeMap<String, DiscoveredEntry>,
) -> Result<(), ToolError> {
    let mut builder = WalkBuilder::new(root);
    builder
        .follow_links(false)
        .hidden(!hidden)
        .git_ignore(gitignore)
        .git_exclude(gitignore)
        .git_global(false)
        .ignore(gitignore)
        .require_git(false);
    for entry in builder.build() {
        let entry = entry.map_err(|error| ToolError::new("file.readFailed", error.to_string()))?;
        let path = entry.path();
        if path == root {
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        if relative == ".git" || relative.starts_with(".git/") {
            continue;
        }
        if matcher.is_some_and(|matcher| !matcher.is_match(&relative)) {
            continue;
        }
        let metadata = std::fs::symlink_metadata(path)
            .map_err(|error| ToolError::new("file.readFailed", error.to_string()))?;
        let display = if display_root == "./" {
            format!("./{relative}")
        } else {
            format!("{}/{}", display_root.trim_end_matches('/'), relative)
        };
        insert(found, display, path.to_path_buf(), kind(&metadata));
    }
    Ok(())
}

fn insert(
    found: &mut BTreeMap<String, DiscoveredEntry>,
    display: String,
    path: PathBuf,
    entry_type: &'static str,
) {
    found.entry(display.clone()).or_insert(DiscoveredEntry {
        display,
        path,
        entry_type,
    });
}
fn kind(metadata: &std::fs::Metadata) -> &'static str {
    if metadata.file_type().is_symlink() {
        "symlink"
    } else if metadata.is_dir() {
        "directory"
    } else if metadata.is_file() {
        "file"
    } else {
        "other"
    }
}
fn has_glob(value: &str) -> bool {
    value.contains(['*', '?', '['])
}
