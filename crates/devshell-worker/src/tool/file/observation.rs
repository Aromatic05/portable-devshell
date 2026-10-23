//! Best-effort attribution of model-visible shell output to source lines.
//!
//! This is deliberately not a shell interpreter. A small allowlist identifies
//! static file sources; only exact, unambiguous source lines become coverage.
//! It never changes command execution or observes writes.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use tree_sitter::{Node, Parser};

use super::state::{FULL_SNAPSHOT_LIMIT, TextFile};
use super::{FileToolState, resolve_existing};
use crate::tool::ToolCall;

const MAX_OUTPUT_BYTES: usize = 8 * 1024;
const MAX_OBSERVED_LINES: usize = MAX_OUTPUT_BYTES;
const MAX_OBSERVED_FILES: usize = 512;

#[derive(Clone, Debug)]
pub struct CommandReadPlan {
    cwd: PathBuf,
    source: String,
    numbered: bool,
    range: Option<ReadRange>,
}

#[derive(Clone, Copy, Debug)]
enum ReadRange {
    First(usize),
    Last(usize),
    Interval(usize, usize),
}

impl ReadRange {
    fn bounds(self, total: usize) -> (usize, usize) {
        match self {
            Self::First(count) => (0, count.min(total)),
            Self::Last(count) => (total.saturating_sub(count), total),
            Self::Interval(from, to) => (from.saturating_sub(1).min(total), to.min(total)),
        }
    }
}

#[derive(Debug)]
struct SimpleCommand {
    name: String,
    args: Vec<String>,
}

impl CommandReadPlan {
    /// Returns None for dynamic shell constructs, redirections, side-effecting
    /// pipeline stages, or commands whose output cannot be attributed.
    pub fn analyze(command: &str, cwd: &Path) -> Option<Self> {
        if command.len() > 16 * 1024 {
            return None;
        }
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_bash::LANGUAGE.into())
            .ok()?;
        let tree = parser.parse(command, None)?;
        let root = tree.root_node();
        if root.has_error() || root.named_child_count() != 1 {
            return None;
        }
        let statement = root.named_child(0)?;
        let mut commands = Vec::new();
        match statement.kind() {
            "command" => commands.push(simple_command(statement, command)?),
            "pipeline" => {
                let mut cursor = statement.walk();
                let children = statement.named_children(&mut cursor).collect::<Vec<_>>();
                if children.is_empty() {
                    return None;
                }
                for (index, node) in children.iter().enumerate() {
                    if index > 0 {
                        // Reject |& (stderr injection) and non-pipe separators.
                        let separator = &command[children[index - 1].end_byte()..node.start_byte()];
                        if separator.trim() != "|" {
                            return None;
                        }
                    }
                    commands.push(simple_command(*node, command)?);
                }
            }
            _ => return None,
        }
        let first = commands.first()?;
        let (source, numbered, range) = source_from_command(first)?;
        for downstream in commands.iter().skip(1) {
            if !stdin_filter(downstream) {
                return None;
            }
        }
        Some(Self {
            cwd: cwd.to_path_buf(),
            source,
            numbered,
            range,
        })
    }

    /// Uses only text returned by the tool. Failed attribution is intentionally
    /// silent: command results and file_edit's existing checks are unchanged.
    pub fn observe(&self, call: &ToolCall, state: &FileToolState, output: &str) {
        if output.is_empty() || output.len() > MAX_OUTPUT_BYTES || call.cancellation.is_cancelled()
        {
            return;
        }
        let Some((_, root)) = self.resolve(call, &self.source) else {
            return;
        };
        if root
            .metadata()
            .ok()
            .is_some_and(|metadata| metadata.is_file())
        {
            self.observe_file(call, state, &root, output);
        } else if self.numbered
            && root
                .metadata()
                .ok()
                .is_some_and(|metadata| metadata.is_dir())
        {
            self.observe_directory(call, state, &root.canonical, output);
        }
    }

    fn observe_directory(
        &self,
        call: &ToolCall,
        state: &FileToolState,
        directory: &Path,
        output: &str,
    ) {
        let mut groups = HashMap::<
            PathBuf,
            (
                crate::instance::sandbox::path::ResolvedPath,
                Vec<(usize, String)>,
            ),
        >::new();
        for line in complete_lines(output) {
            let Some((path, line_no, text)) = split_numbered_path(line) else {
                continue;
            };
            let Some((_, resolved)) = self.resolve(call, path) else {
                continue;
            };
            if !resolved.canonical.starts_with(directory) {
                continue;
            }
            groups
                .entry(resolved.canonical.clone())
                .or_insert_with(|| (resolved, Vec::new()))
                .1
                .push((line_no, text.to_string()));
            if groups.len() > MAX_OBSERVED_FILES {
                return;
            }
        }
        for (path, (resolved, observations)) in groups {
            if let Some(file) = read_text(call, &resolved) {
                let seen = observations
                    .iter()
                    .filter_map(|(line, value)| matches_line(&file, *line, value).then_some(*line))
                    .collect::<BTreeSet<_>>();
                remember(call, state, &path, &file, seen);
            }
        }
    }

    fn observe_file(
        &self,
        call: &ToolCall,
        state: &FileToolState,
        resolved: &crate::instance::sandbox::path::ResolvedPath,
        output: &str,
    ) {
        let path = &resolved.canonical;
        let Some(file) = read_text(call, resolved) else {
            return;
        };
        let mut seen = BTreeSet::new();
        let normalized = file.normalized();
        let complete = normalized;
        let (from, to) = self
            .range
            .map(|range| range.bounds(file.lines.len()))
            .unwrap_or((0, file.lines.len()));
        // Whole-file reading is unambiguous even with duplicate source lines.
        if self.range.is_none() && output == complete {
            seen.extend(1..=file.lines.len());
        } else if from < to && output == rendered_range(&file, from, to) {
            // A deterministic sed/head/tail range can contain duplicate lines.
            seen.extend(from + 1..=to);
        } else {
            let returned = complete_lines(output);
            if returned.len() > MAX_OBSERVED_LINES {
                return;
            }
            let mut unnumbered = Vec::new();
            for line in returned {
                if self.numbered {
                    if let Some((number, value)) =
                        split_numbered_line(line).or_else(|| split_tab_numbered_line(line))
                    {
                        if matches_line(&file, number, value) {
                            seen.insert(number);
                        }
                        continue;
                    }
                    if let Some((printed_path, number, value)) = split_numbered_path(line) {
                        if let Some((_, resolved)) = self.resolve(call, printed_path)
                            && resolved.canonical == *path
                            && matches_line(&file, number, value)
                        {
                            seen.insert(number);
                        }
                        continue;
                    }
                }
                unnumbered.push(line);
            }
            // An exact, uniquely located contiguous range also establishes
            // duplicate lines, for example with head/tail/sed.
            if !unnumbered.is_empty() {
                if let Some(start) = unique_contiguous_range(&file.lines[from..to], &unnumbered) {
                    seen.extend(from + start + 1..=from + start + unnumbered.len());
                } else {
                    for line in unnumbered {
                        if line.is_empty() {
                            continue;
                        }
                        let mut locations = file.lines[from..to]
                            .iter()
                            .enumerate()
                            .filter_map(|(i, value)| (value == line).then_some(from + i + 1));
                        if let (Some(line_no), None) = (locations.next(), locations.next()) {
                            seen.insert(line_no);
                        }
                    }
                }
            }
        }
        remember(call, state, path, &file, seen);
    }

    fn resolve(
        &self,
        call: &ToolCall,
        path: &str,
    ) -> Option<(
        crate::instance::sandbox::path::RequestedPath,
        crate::instance::sandbox::path::ResolvedPath,
    )> {
        if path.is_empty()
            || path == "-"
            || path.starts_with('~')
            || path.contains(['*', '?', '[', ']'])
        {
            return None;
        }
        let requested = if Path::new(path).is_absolute() {
            // Explicit absolute sources still obey the existing AbsoluteRead policy.
            path.to_string()
        } else {
            let workspace = std::fs::canonicalize(&call.workspace).ok()?;
            let absolute = self.cwd.join(path);
            let relative = absolute.strip_prefix(&workspace).ok()?;
            if relative.as_os_str().is_empty() {
                "./".to_string()
            } else {
                format!("./{}", relative.display())
            }
        };
        resolve_existing(call, &requested, false).ok()
    }
}

fn simple_command(node: Node<'_>, script: &str) -> Option<SimpleCommand> {
    if node.kind() != "command" {
        return None;
    }
    let name = node.child_by_field_name("name")?;
    let name = static_word(name.named_child(0)?, script)?;
    // Only literal executables; no aliases/functions can be proven, but every
    // observed line is independently checked against the source file.
    if name.contains('/') {
        return None;
    }
    let mut args = Vec::new();
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        if child.kind() == "command_name" {
            continue;
        }
        args.push(static_word(child, script)?);
    }
    Some(SimpleCommand { name, args })
}

fn static_word(node: Node<'_>, script: &str) -> Option<String> {
    let text = node.utf8_text(script.as_bytes()).ok()?;
    let word = match node.kind() {
        "word" | "number" => {
            if text.contains(['\\', '$', '`', '*', '?', '[', ']', '{', '}', '\n']) {
                return None;
            }
            text
        }
        "raw_string" if text.len() >= 2 => &text[1..text.len() - 1],
        "string" if text.len() >= 2 && !node.has_error() && node.named_child_count() == 0 => {
            let unquoted = &text[1..text.len() - 1];
            if unquoted.contains(['\\', '$', '`']) {
                return None;
            }
            unquoted
        }
        _ => return None,
    };
    Some(word.to_string())
}

fn source_from_command(command: &SimpleCommand) -> Option<(String, bool, Option<ReadRange>)> {
    let args = &command.args;
    match command.name.as_str() {
        "cat" | "bat" | "batcat" => {
            let (numbered, args) = if matches!(args.first().map(String::as_str), Some("-n" | "-b"))
            {
                (true, &args[1..])
            } else {
                (false, args.as_slice())
            };
            let args = skip_end_of_options(args);
            (args.len() == 1 && !args[0].starts_with('-'))
                .then(|| (args[0].clone(), numbered, None))
        }
        "nl" => {
            let args = args
                .iter()
                .filter(|arg| !matches!(arg.as_str(), "-ba" | "-b" | "a"))
                .collect::<Vec<_>>();
            (args.len() == 1).then(|| (args[0].to_string(), true, None))
        }
        "head" | "tail" => {
            let files = positional_after_count_options(args)?;
            let count = output_line_count(args)?;
            let range = if command.name == "head" {
                ReadRange::First(count)
            } else {
                ReadRange::Last(count)
            };
            (files.len() == 1).then(|| (files[0].clone(), false, Some(range)))
        }
        "sed" => {
            let files = sed_operands(args)?;
            let (from, to) = sed_range(args)?;
            (files.len() == 1)
                .then(|| (files[0].clone(), false, Some(ReadRange::Interval(from, to))))
        }
        "grep" | "egrep" | "fgrep" | "rg" => {
            let (files, numbered) = search_operands(command)?;
            if files.is_empty() && command.name == "rg" {
                Some((".".to_string(), numbered, None))
            } else if files.len() == 1 {
                Some((files[0].clone(), numbered, None))
            } else {
                None
            }
        }
        _ => None,
    }
}

fn stdin_filter(command: &SimpleCommand) -> bool {
    match command.name.as_str() {
        "head" | "tail" => {
            positional_after_count_options(&command.args).is_some_and(|files| files.is_empty())
        }
        "sed" => sed_operands(&command.args).is_some_and(|files| files.is_empty()),
        "grep" | "egrep" | "fgrep" | "rg" => {
            search_operands(command).is_some_and(|(files, _)| files.is_empty())
        }
        "sort" => command
            .args
            .iter()
            .all(|arg| matches!(arg.as_str(), "-r" | "-n" | "-u" | "-s")),
        "uniq" => command
            .args
            .iter()
            .all(|arg| matches!(arg.as_str(), "-c" | "-d" | "-u")),
        _ => false,
    }
}

fn skip_end_of_options(args: &[String]) -> &[String] {
    args.strip_prefix(&["--".to_string()]).unwrap_or(args)
}

fn positional_after_count_options(args: &[String]) -> Option<Vec<String>> {
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        if arg == "--" {
            index += 1;
            break;
        }
        if arg == "-n" || arg == "--lines" {
            index += 1;
            args.get(index)?.parse::<usize>().ok()?;
        } else if let Some(rest) = arg.strip_prefix("-n") {
            if rest.is_empty() {
                return None;
            }
            rest.parse::<usize>().ok()?;
        } else if let Some(rest) = arg.strip_prefix('-') {
            if rest.is_empty() || rest.parse::<usize>().is_err() {
                break;
            }
        } else {
            break;
        }
        index += 1;
    }
    let files = args[index..].to_vec();
    files
        .iter()
        .all(|arg| !arg.starts_with('-'))
        .then_some(files)
}

fn output_line_count(args: &[String]) -> Option<usize> {
    let mut count = 10;
    if let Some(arg) = args.first() {
        if matches!(arg.as_str(), "-n" | "--lines") {
            count = args.get(1)?.parse().ok()?;
        } else if let Some(value) = arg.strip_prefix("-n") {
            if !value.is_empty() {
                count = value.parse().ok()?;
            }
        } else if let Some(value) = arg.strip_prefix('-')
            && !value.is_empty()
            && value.chars().all(|ch| ch.is_ascii_digit())
        {
            count = value.parse().ok()?;
        }
    }
    Some(count)
}

fn sed_range(args: &[String]) -> Option<(usize, usize)> {
    if !matches!(args.first()?.as_str(), "-n" | "--quiet" | "--silent") {
        return None;
    }
    let script = args.get(1)?.strip_suffix('p')?;
    let (from, to) = script.split_once(',').unwrap_or((script, script));
    Some((from.parse().ok()?, to.parse().ok()?))
}

fn sed_operands(args: &[String]) -> Option<Vec<String>> {
    let mut index = 0;
    if matches!(args.first()?.as_str(), "-n" | "--quiet" | "--silent") {
        index += 1;
    } else {
        return None;
    }
    let expression = args.get(index)?;
    let body = expression.strip_suffix('p')?;
    let (from, to) = body.split_once(',').unwrap_or((body, body));
    if from.parse::<usize>().ok()? == 0 || to.parse::<usize>().ok()? == 0 {
        return None;
    }
    Some(args[index + 1..].to_vec())
}

fn search_operands(command: &SimpleCommand) -> Option<(Vec<String>, bool)> {
    let mut index = 0;
    let mut numbered = false;
    let mut pattern = false;
    let args = &command.args;
    while index < args.len() {
        let arg = args[index].as_str();
        if arg == "--" {
            index += 1;
            break;
        }
        if !arg.starts_with('-') || arg == "-" {
            break;
        }
        if matches!(arg, "-n" | "--line-number") {
            numbered = true;
        } else if matches!(
            arg,
            "-i" | "-F"
                | "-E"
                | "-w"
                | "-x"
                | "-v"
                | "-H"
                | "--no-heading"
                | "--with-filename"
                | "--no-filename"
                | "--color=never"
                | "-r"
                | "-R"
        ) {
            // Options which do not truncate or rewrite the matched source line.
        } else if arg == "-e" || arg == "--regexp" {
            index += 1;
            args.get(index)?;
            pattern = true;
        } else {
            return None;
        }
        index += 1;
    }
    if !pattern {
        args.get(index)?;
        index += 1;
    }
    let files = args[index..].to_vec();
    if files.iter().any(|file| file.starts_with('-')) {
        return None;
    }
    Some((files, numbered))
}

fn complete_lines(output: &str) -> Vec<&str> {
    output
        .split_inclusive('\n')
        .filter_map(|line| line.strip_suffix('\n'))
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect()
}

fn split_numbered_line(line: &str) -> Option<(usize, &str)> {
    let (number, text) = line.split_once(':')?;
    let number = number.trim().parse::<usize>().ok()?;
    (number > 0).then_some((number, text))
}

fn split_tab_numbered_line(line: &str) -> Option<(usize, &str)> {
    let (number, text) = line.split_once('\t')?;
    let number = number.trim().parse::<usize>().ok()?;
    (number > 0).then_some((number, text))
}

fn rendered_range(file: &TextFile, from: usize, to: usize) -> String {
    let mut text = file.lines[from..to].join("\n");
    if to < file.lines.len() || file.final_newline {
        text.push('\n');
    }
    text
}

fn split_numbered_path(line: &str) -> Option<(&str, usize, &str)> {
    for (index, ch) in line.char_indices() {
        if ch != ':' {
            continue;
        }
        let path = &line[..index];
        let rest = &line[index + 1..];
        if let Some((number, text)) = split_numbered_line(rest)
            && !path.is_empty()
        {
            return Some((path, number, text));
        }
    }
    None
}

fn matches_line(file: &TextFile, number: usize, text: &str) -> bool {
    number > 0 && file.lines.get(number - 1).is_some_and(|line| line == text)
}

fn unique_contiguous_range(source: &[String], returned: &[&str]) -> Option<usize> {
    if returned.is_empty() || returned.len() > source.len() {
        return None;
    }
    let mut candidates =
        source
            .windows(returned.len())
            .enumerate()
            .filter_map(|(offset, lines)| {
                lines
                    .iter()
                    .zip(returned)
                    .all(|(source, seen)| source == seen)
                    .then_some(offset)
            });
    match (candidates.next(), candidates.next()) {
        (Some(offset), None) => Some(offset),
        _ => None,
    }
}

fn read_text(
    call: &ToolCall,
    resolved: &crate::instance::sandbox::path::ResolvedPath,
) -> Option<TextFile> {
    let metadata = resolved.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > FULL_SNAPSHOT_LIMIT as u64 {
        return None;
    }
    TextFile::read_file(resolved.open_file().ok()?, &call.cancellation).ok()
}

fn remember(
    call: &ToolCall,
    state: &FileToolState,
    path: &Path,
    file: &TextFile,
    seen: BTreeSet<usize>,
) {
    if seen.is_empty() || seen.len() > MAX_OBSERVED_LINES {
        return;
    }
    let ordinal = state.next_snapshot_ordinal();
    if let Ok(mut snapshots) = state.context_snapshots.lock() {
        snapshots.remember_full(&call.ctx_id, path, file, seen, ordinal);
    }
}

#[cfg(test)]
mod tests {
    use super::CommandReadPlan;
    use std::path::Path;

    #[test]
    fn recognizes_literal_pipeline_and_rejects_dynamic_or_writing_stages() {
        let cwd = Path::new("/repo");
        for script in [
            "cat src/main.rs | grep 'fn ' | head -n 10",
            "sed -n '20,40p' src/main.rs | grep foo",
            "rg -n 'TODO' src | head -n 5",
            "head -n 20 ./a.rs",
        ] {
            assert!(CommandReadPlan::analyze(script, cwd).is_some(), "{script}");
        }
        for script in [
            "cat a.rs | tee elsewhere.rs",
            "cat a.rs; echo injected",
            "cat $FILE",
            "cat a.rs > /tmp/output",
            "cat a.rs | grep foo other.rs",
            "cat a.rs |& head",
            "python script.py",
            "cat a.rs | cut -c 1-2",
        ] {
            assert!(CommandReadPlan::analyze(script, cwd).is_none(), "{script}");
        }
    }
}
