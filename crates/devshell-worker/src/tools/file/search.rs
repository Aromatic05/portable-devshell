use std::sync::Arc;

use globset::{Glob, GlobSet, GlobSetBuilder};
use ignore::WalkBuilder;
use regex::RegexBuilder;
use schemars::schema_for;
use serde_json::json;

use crate::tools::file::state::TextFile;
use crate::tools::file::types::{FileSearchFile, FileSearchInput, FileSearchOutput, SearchSyntax};
use crate::tools::file::{FileToolState, resolve_existing};
use crate::tools::{ToolAccess, ToolCall, ToolCatalogEntry, ToolError, ToolHandler, ToolName};

pub struct FileSearchTool {
    name: ToolName,
    state: Arc<FileToolState>,
}

impl FileSearchTool {
    pub fn new(state: Arc<FileToolState>) -> Self {
        Self {
            name: ToolName::parse("file_search").unwrap(),
            state,
        }
    }
}

impl ToolHandler for FileSearchTool {
    fn name(&self) -> &ToolName {
        &self.name
    }

    fn catalog_entry(&self) -> ToolCatalogEntry {
        ToolCatalogEntry {
            name: self.name.as_str(),
            description: "Search UTF-8 text files and return anchored match context.".to_string(),
            input_schema: serde_json::to_value(schema_for!(FileSearchInput)).unwrap(),
            output_schema: serde_json::to_value(schema_for!(FileSearchOutput)).unwrap(),
            access: ToolAccess::Read,
        }
    }

    fn call(&self, call: ToolCall) -> Result<serde_json::Value, ToolError> {
        let input: FileSearchInput = serde_json::from_value(call.params.clone())
            .map_err(|error| ToolError::new("tool.invalidArguments", error.to_string()))?;
        let root_raw = input.path.unwrap_or_else(|| "./".to_string());
        let (requested, root) = resolve_existing(&call, &root_raw, false)?;
        if !root.is_dir() {
            return Err(ToolError::new(
                "file.notDirectory",
                "search root is not a directory",
            ));
        }
        let syntax = input.syntax.unwrap_or(SearchSyntax::Regex);
        let case_sensitive = input.case_sensitive.unwrap_or(true);
        let expression = match syntax {
            SearchSyntax::Literal => regex::escape(&input.pattern),
            SearchSyntax::Regex => input.pattern,
        };
        let matcher = RegexBuilder::new(&expression)
            .case_insensitive(!case_sensitive)
            .build()
            .map_err(|error| ToolError::new("file.invalidRegex", error.to_string()))?;
        let context = input.context.unwrap_or(0);
        if context > 20 {
            return Err(ToolError::new(
                "tool.invalidArguments",
                "context cannot exceed 20",
            ));
        }
        let max_files = input.max_files.unwrap_or(20);
        let max_matches = input.max_matches_per_file.unwrap_or(20);
        if max_files > 100 || max_matches > 200 {
            return Err(ToolError::new(
                "tool.invalidArguments",
                "search limits exceed the worker maximum",
            ));
        }
        let include = input.include.unwrap_or_default();
        let exclude = input.exclude.unwrap_or_default();
        if include.len() > 32 || exclude.len() > 32 {
            return Err(ToolError::new(
                "file.invalidPattern",
                "include and exclude support at most 32 patterns",
            ));
        }
        let include_globs = compile_globs(&include)?;
        let exclude_globs = compile_globs(&exclude)?;
        let include_hidden = input.include_hidden.unwrap_or(true);
        let respect_gitignore = input.respect_gitignore.unwrap_or(true);
        let query = json!({
            "pattern": expression,
            "path": root_raw,
            "include": include,
            "exclude": exclude,
            "caseSensitive": case_sensitive,
            "includeHidden": include_hidden,
            "respectGitignore": respect_gitignore,
            "context": context,
            "maxFiles": max_files,
            "maxMatchesPerFile": max_matches,
        });
        let offset = match input.cursor.as_deref() {
            Some(cursor) => self.state.cursors.lock().unwrap().resolve(cursor, &query)?,
            None => 0,
        };
        let mut walker = WalkBuilder::new(&root);
        walker
            .follow_links(false)
            .hidden(!include_hidden)
            .git_ignore(respect_gitignore)
            .git_exclude(respect_gitignore)
            .git_global(false)
            .ignore(respect_gitignore)
            .require_git(false);
        let mut files = Vec::new();
        for entry in walker.build() {
            let entry = entry.map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
            let path = entry.path();
            if !entry.file_type().is_some_and(|kind| kind.is_file()) {
                continue;
            }
            let relative = path.strip_prefix(&root).unwrap();
            let relative_text = relative.to_string_lossy().replace('\\', "/");
            if !include.is_empty() && !include_globs.is_match(&relative_text) {
                continue;
            }
            if exclude_globs.is_match(&relative_text) {
                continue;
            }
            let Ok(text) = TextFile::read(path) else {
                continue;
            };
            let matches = text
                .lines
                .iter()
                .enumerate()
                .filter_map(|(index, line)| matcher.is_match(line).then_some(index + 1))
                .take(max_matches)
                .collect::<Vec<_>>();
            if matches.is_empty() {
                continue;
            }
            let shown = shown_lines(&matches, text.lines.len(), context);
            let content = format_content(&text.lines, &matches, &shown);
            let snapshot_id = self
                .state
                .snapshots
                .lock()
                .unwrap()
                .remember(path, &text, shown.iter().copied());
            let display = if requested.raw == "./" {
                format!("./{relative_text}")
            } else {
                format!("{}/{}", requested.raw.trim_end_matches('/'), relative_text)
            };
            files.push(FileSearchFile {
                path: display,
                snapshot_id,
                revision: text.revision,
                content,
                match_count: matches.len(),
            });
        }
        files.sort_by(|left, right| left.path.cmp(&right.path));
        let next_cursor = if files.len() > offset.saturating_add(max_files) {
            Some(
                self.state
                    .cursors
                    .lock()
                    .unwrap()
                    .issue(&query, offset + max_files),
            )
        } else {
            None
        };
        let files = files.into_iter().skip(offset).take(max_files).collect();
        serde_json::to_value(FileSearchOutput { files, next_cursor })
            .map_err(|error| ToolError::new("tool.internalError", error.to_string()))
    }
}

fn compile_globs(patterns: &[String]) -> Result<GlobSet, ToolError> {
    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        builder.add(
            Glob::new(pattern)
                .map_err(|error| ToolError::new("file.invalidPattern", error.to_string()))?,
        );
    }
    builder
        .build()
        .map_err(|error| ToolError::new("file.invalidPattern", error.to_string()))
}

fn shown_lines(matches: &[usize], total_lines: usize, context: usize) -> Vec<usize> {
    let mut shown = std::collections::BTreeSet::new();
    for line in matches {
        for candidate in line.saturating_sub(context)..=(*line + context).min(total_lines) {
            if candidate > 0 {
                shown.insert(candidate);
            }
        }
    }
    shown.into_iter().collect()
}

fn format_content(lines: &[String], matches: &[usize], shown: &[usize]) -> String {
    let mut content = String::new();
    let mut previous = 0;
    for line in shown {
        if previous > 0 && *line > previous + 1 {
            content.push_str("...\n");
        }
        content.push(if matches.contains(line) { '*' } else { ' ' });
        content.push_str(&format!("{line}:{}\n", lines[line - 1]));
        previous = *line;
    }
    content.pop();
    content
}
