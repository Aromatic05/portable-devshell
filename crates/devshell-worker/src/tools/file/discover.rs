use std::collections::{HashSet, VecDeque};
use std::ffi::OsString;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use globset::{Glob, GlobMatcher};
use ignore::gitignore::{Gitignore, GitignoreBuilder};

use crate::security::path::{
    ResolvedDirectory, ResolvedMetadata, ResolvedPath, parse_requested_path,
};
use crate::tools::file::{authorize, resolve_existing};
use crate::tools::{ToolCall, ToolError};

#[derive(Clone)]
pub struct DiscoveredEntry {
    pub display: String,
    pub resolved: ResolvedPath,
    pub entry_type: &'static str,
}

#[derive(Clone)]
pub struct DiscoveryCursor {
    pending: VecDeque<DiscoverySource>,
    seen: HashSet<String>,
}

#[derive(Clone)]
enum DiscoverySource {
    Single(Option<DiscoveredEntry>),
    Walk(WalkState),
}

#[derive(Clone)]
struct WalkState {
    root: ResolvedPath,
    display_root: String,
    matcher: Option<Arc<GlobMatcher>>,
    hidden: bool,
    gitignore: bool,
    frames: Vec<WalkFrame>,
}

#[derive(Clone)]
struct WalkFrame {
    directory: ResolvedDirectory,
    relative_directory: PathBuf,
    names: Arc<Vec<OsString>>,
    index: usize,
    ignore_stack: Vec<Arc<Gitignore>>,
}

impl DiscoveryCursor {
    pub fn new(
        call: &ToolCall,
        specs: &[String],
        hidden: bool,
        gitignore: bool,
    ) -> Result<Self, ToolError> {
        call.check_cancelled()?;
        if specs.is_empty() {
            return Err(ToolError::new(
                "tool.invalidArguments",
                "paths cannot be empty",
            ));
        }
        let mut pending = VecDeque::with_capacity(specs.len());
        for spec in specs {
            call.check_cancelled()?;
            pending.push_back(prepare_source(call, spec, hidden, gitignore)?);
        }
        Ok(Self {
            pending,
            seen: HashSet::new(),
        })
    }

    pub fn next(&mut self, call: &ToolCall) -> Result<Option<DiscoveredEntry>, ToolError> {
        loop {
            call.check_cancelled()?;
            let Some(source) = self.pending.front_mut() else {
                return Ok(None);
            };
            let next = match source {
                DiscoverySource::Single(entry) => entry.take(),
                DiscoverySource::Walk(walk) => walk.next(call)?,
            };
            if let Some(entry) = next {
                if self.seen.insert(entry.display.clone()) {
                    return Ok(Some(entry));
                }
                continue;
            }
            self.pending.pop_front();
        }
    }
}

fn prepare_source(
    call: &ToolCall,
    spec: &str,
    hidden: bool,
    gitignore: bool,
) -> Result<DiscoverySource, ToolError> {
    if has_glob(spec) {
        prepare_glob(call, spec, hidden, gitignore)
    } else {
        prepare_exact(call, spec, hidden, gitignore)
    }
}

fn prepare_exact(
    call: &ToolCall,
    spec: &str,
    hidden: bool,
    gitignore: bool,
) -> Result<DiscoverySource, ToolError> {
    let (requested, resolved) = resolve_existing(call, spec, false)?;
    let metadata = resolved
        .metadata()
        .map_err(|error| ToolError::new("file.notFound", error.to_string()))?;
    if metadata.is_file() || metadata.is_symlink() {
        return Ok(DiscoverySource::Single(Some(DiscoveredEntry {
            display: requested.raw,
            resolved,
            entry_type: kind(&metadata),
        })));
    }
    if !metadata.is_dir() {
        return Ok(DiscoverySource::Single(None));
    }
    Ok(DiscoverySource::Walk(WalkState::new(
        resolved,
        requested.raw,
        None,
        hidden,
        gitignore,
    )?))
}

fn prepare_glob(
    call: &ToolCall,
    spec: &str,
    hidden: bool,
    gitignore: bool,
) -> Result<DiscoverySource, ToolError> {
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
    let matcher = Arc::new(
        Glob::new(&pattern)
            .map_err(|error| ToolError::new("file.invalidPattern", error.to_string()))?
            .compile_matcher(),
    );
    Ok(DiscoverySource::Walk(WalkState::new(
        root,
        root_requested.raw,
        Some(matcher),
        hidden,
        gitignore,
    )?))
}

impl WalkState {
    fn new(
        root: ResolvedPath,
        display_root: String,
        matcher: Option<Arc<GlobMatcher>>,
        hidden: bool,
        gitignore: bool,
    ) -> Result<Self, ToolError> {
        let directory = root
            .open_directory()
            .map_err(|error| ToolError::new("file.readFailed", error.to_string()))?;
        let frame = build_frame(&directory, PathBuf::new(), Vec::new(), gitignore)?;
        Ok(Self {
            root,
            display_root,
            matcher,
            hidden,
            gitignore,
            frames: vec![frame],
        })
    }

    fn next(&mut self, call: &ToolCall) -> Result<Option<DiscoveredEntry>, ToolError> {
        loop {
            call.check_cancelled()?;
            let Some(frame) = self.frames.last_mut() else {
                return Ok(None);
            };
            if frame.index >= frame.names.len() {
                self.frames.pop();
                continue;
            }
            let name = frame.names[frame.index].clone();
            frame.index += 1;
            let directory = frame.directory.clone();
            let relative_directory = frame.relative_directory.clone();
            let ignore_stack = frame.ignore_stack.clone();

            let name_text = name.to_string_lossy();
            if name_text == ".git" {
                continue;
            }
            if !self.hidden && name_text.starts_with('.') {
                continue;
            }
            let relative = relative_directory.join(&name);
            let metadata = directory
                .metadata(Path::new(&name), false)
                .map_err(|error| ToolError::new("file.readFailed", error.to_string()))?;
            if self.gitignore && is_ignored(&ignore_stack, &relative, metadata.is_dir()) {
                continue;
            }
            let relative_text = relative.to_string_lossy().replace('\\', "/");
            let resolved = self.root.join(&relative);
            let display = if self.display_root == "./" {
                format!("./{relative_text}")
            } else {
                format!(
                    "{}/{}",
                    self.display_root.trim_end_matches('/'),
                    relative_text
                )
            };

            if metadata.is_dir() && !metadata.is_symlink() {
                let child = directory
                    .open_directory(Path::new(&name))
                    .map_err(|error| ToolError::new("file.readFailed", error.to_string()))?;
                self.frames.push(build_frame(
                    &child,
                    relative.clone(),
                    ignore_stack,
                    self.gitignore,
                )?);
            }

            if self
                .matcher
                .as_ref()
                .is_none_or(|matcher| matcher.is_match(&relative_text))
            {
                return Ok(Some(DiscoveredEntry {
                    display,
                    resolved,
                    entry_type: kind(&metadata),
                }));
            }
        }
    }
}

fn build_frame(
    directory: &ResolvedDirectory,
    relative_directory: PathBuf,
    mut ignore_stack: Vec<Arc<Gitignore>>,
    gitignore: bool,
) -> Result<WalkFrame, ToolError> {
    if gitignore {
        load_ignore_rules(directory, &relative_directory, &mut ignore_stack)?;
    }
    let mut names = directory
        .entries()
        .map_err(|error| ToolError::new("file.readFailed", error.to_string()))?;
    names.sort_by(|left, right| left.to_string_lossy().cmp(&right.to_string_lossy()));
    Ok(WalkFrame {
        directory: directory.clone(),
        relative_directory,
        names: Arc::new(names),
        index: 0,
        ignore_stack,
    })
}

fn load_ignore_rules(
    directory: &ResolvedDirectory,
    relative_directory: &Path,
    ignore_stack: &mut Vec<Arc<Gitignore>>,
) -> Result<(), ToolError> {
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
        ignore_stack.push(Arc::new(builder.build().map_err(|error| {
            ToolError::new("file.invalidPattern", error.to_string())
        })?));
    }
    Ok(())
}

fn is_ignored(matchers: &[Arc<Gitignore>], path: &Path, is_dir: bool) -> bool {
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
