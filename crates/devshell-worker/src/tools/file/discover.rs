use std::collections::BTreeMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use globset::Glob;
use ignore::gitignore::{Gitignore, GitignoreBuilder};

use crate::security::path::{
    ResolvedDirectory, ResolvedMetadata, ResolvedPath, parse_requested_path,
};
use crate::tools::file::{authorize, resolve_existing};
use crate::tools::{ToolCall, ToolError};

pub struct DiscoveredEntry {
    pub display: String,
    pub resolved: ResolvedPath,
    pub entry_type: &'static str,
}

pub fn discover(
    call: &ToolCall,
    specs: &[String],
    hidden: bool,
    gitignore: bool,
) -> Result<Vec<DiscoveredEntry>, ToolError> {
    call.check_cancelled()?;
    if specs.is_empty() {
        return Err(ToolError::new(
            "tool.invalidArguments",
            "paths cannot be empty",
        ));
    }
    let mut found = BTreeMap::<String, DiscoveredEntry>::new();
    for spec in specs {
        call.check_cancelled()?;
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
    let (requested, resolved) = resolve_existing(call, spec, false)?;
    let metadata = resolved
        .metadata()
        .map_err(|error| ToolError::new("file.notFound", error.to_string()))?;
    if metadata.is_file() || metadata.is_symlink() {
        insert(found, requested.raw, resolved, kind(&metadata));
        return Ok(());
    }
    if !metadata.is_dir() {
        return Ok(());
    }
    walk(
        call,
        &resolved,
        &requested.raw,
        None,
        hidden,
        gitignore,
        found,
    )
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
    if !root
        .metadata()
        .map_err(|error| ToolError::new("file.readFailed", error.to_string()))?
        .is_dir()
    {
        return Err(ToolError::new(
            "file.notDirectory",
            "glob root is not a directory",
        ));
    }
    let matcher = Glob::new(&pattern)
        .map_err(|error| ToolError::new("file.invalidPattern", error.to_string()))?
        .compile_matcher();
    walk(
        call,
        &root,
        &root_requested.raw,
        Some(&matcher),
        hidden,
        gitignore,
        found,
    )
}

fn walk(
    call: &ToolCall,
    root: &ResolvedPath,
    display_root: &str,
    matcher: Option<&globset::GlobMatcher>,
    hidden: bool,
    gitignore: bool,
    found: &mut BTreeMap<String, DiscoveredEntry>,
) -> Result<(), ToolError> {
    let directory = root
        .open_directory()
        .map_err(|error| ToolError::new("file.readFailed", error.to_string()))?;
    let mut ignore_stack = Vec::new();
    walk_directory(
        call,
        root,
        &directory,
        Path::new(""),
        display_root,
        matcher,
        hidden,
        gitignore,
        &mut ignore_stack,
        found,
    )
}

#[allow(clippy::too_many_arguments)]
fn walk_directory(
    call: &ToolCall,
    root: &ResolvedPath,
    directory: &ResolvedDirectory,
    relative_directory: &Path,
    display_root: &str,
    matcher: Option<&globset::GlobMatcher>,
    hidden: bool,
    gitignore: bool,
    ignore_stack: &mut Vec<Gitignore>,
    found: &mut BTreeMap<String, DiscoveredEntry>,
) -> Result<(), ToolError> {
    let added_rules = if gitignore {
        load_ignore_rules(directory, relative_directory, ignore_stack)?
    } else {
        0
    };

    let mut names = directory
        .entries()
        .map_err(|error| ToolError::new("file.readFailed", error.to_string()))?;
    names.sort_by(|left, right| left.to_string_lossy().cmp(&right.to_string_lossy()));

    for name in names {
        call.check_cancelled()?;
        let name_text = name.to_string_lossy();
        if name_text == ".git" {
            continue;
        }
        if !hidden && name_text.starts_with('.') {
            continue;
        }
        let relative = relative_directory.join(&name);
        let metadata = directory
            .metadata(Path::new(&name), false)
            .map_err(|error| ToolError::new("file.readFailed", error.to_string()))?;
        if gitignore && is_ignored(ignore_stack, &relative, metadata.is_dir()) {
            continue;
        }
        let relative_text = relative.to_string_lossy().replace('\\', "/");
        let resolved = root.join(&relative);
        if matcher.is_none_or(|matcher| matcher.is_match(&relative_text)) {
            let display = if display_root == "./" {
                format!("./{relative_text}")
            } else {
                format!("{}/{}", display_root.trim_end_matches('/'), relative_text)
            };
            insert(found, display, resolved, kind(&metadata));
        }
        if metadata.is_dir() && !metadata.is_symlink() {
            let child = directory
                .open_directory(Path::new(&name))
                .map_err(|error| ToolError::new("file.readFailed", error.to_string()))?;
            walk_directory(
                call,
                root,
                &child,
                &relative,
                display_root,
                matcher,
                hidden,
                gitignore,
                ignore_stack,
                found,
            )?;
        }
    }

    ignore_stack.truncate(ignore_stack.len().saturating_sub(added_rules));
    Ok(())
}

fn load_ignore_rules(
    directory: &ResolvedDirectory,
    relative_directory: &Path,
    ignore_stack: &mut Vec<Gitignore>,
) -> Result<usize, ToolError> {
    let mut added = 0usize;
    for file_name in [".gitignore", ".ignore"] {
        let file = match directory.open_file(Path::new(file_name)) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(ToolError::new("file.readFailed", error.to_string())),
        };
        let source = relative_directory.join(file_name);
        let mut builder = GitignoreBuilder::new(PathBuf::new());
        for line in BufReader::new(file).lines() {
            builder
                .add_line(
                    Some(source.clone()),
                    &line.map_err(|error| ToolError::new("file.readFailed", error.to_string()))?,
                )
                .map_err(|error| ToolError::new("file.invalidPattern", error.to_string()))?;
        }
        ignore_stack.push(
            builder
                .build()
                .map_err(|error| ToolError::new("file.invalidPattern", error.to_string()))?,
        );
        added += 1;
    }
    Ok(added)
}

fn is_ignored(matchers: &[Gitignore], path: &Path, is_dir: bool) -> bool {
    let mut ignored = false;
    for matcher in matchers {
        let matched = matcher.matched_path_or_any_parents(path, is_dir);
        if matched.is_ignore() {
            ignored = true;
        } else if matched.is_whitelist() {
            ignored = false;
        }
    }
    ignored
}

fn insert(
    found: &mut BTreeMap<String, DiscoveredEntry>,
    display: String,
    resolved: ResolvedPath,
    entry_type: &'static str,
) {
    found.entry(display.clone()).or_insert(DiscoveredEntry {
        display,
        resolved,
        entry_type,
    });
}

fn kind(metadata: &ResolvedMetadata) -> &'static str {
    if metadata.is_symlink() {
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
