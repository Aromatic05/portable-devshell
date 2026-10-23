//! Best-effort attribution of model-visible shell output to source lines.
//!
//! This is deliberately not a shell interpreter. A small allowlist identifies
//! static file sources; only exact, unambiguous source lines become coverage.
//! It never changes command execution or observes writes.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};

use tree_sitter::{Node, Parser};

use super::state::{FULL_SNAPSHOT_LIMIT, TextFile, TextMetadata};
use super::{FileToolState, resolve_existing};
use crate::tool::ToolCall;

// Default bash_run MCP projection allows 4,000 tokens (~12,000 bytes),
// including metadata. Record only outputs whose complete serialized result
// fits that projection; reserve some space for the result envelope.
pub(crate) const MAX_OUTPUT_BYTES: usize = 11 * 1024;
const MAX_OBSERVED_LINES: usize = MAX_OUTPUT_BYTES;
const MAX_OBSERVED_FILES: usize = 64;
const MAX_DIRECTORY_SCAN_BYTES: u64 = 32 * 1024 * 1024;

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
        let (source, numbered, mut range) = source_from_command(first)?;
        for downstream in commands.iter().skip(1) {
            if !stdin_filter(downstream) {
                return None;
            }
        }
        // A single head/tail directly after plain cat selects original file
        // positions without transforming line text. Propagate that range
        // instead of guessing from potentially duplicated output strings.
        if first.name == "cat" && !numbered && commands.len() == 2 {
            let filter = &commands[1];
            if matches!(filter.name.as_str(), "head" | "tail") {
                let count = output_line_count(&filter.args)?;
                range = Some(if filter.name == "head" {
                    ReadRange::First(count)
                } else {
                    ReadRange::Last(count)
                });
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
        let mut scan_bytes_remaining = MAX_DIRECTORY_SCAN_BYTES;
        for (path, (resolved, observations)) in groups {
            let Some(size) = resolved.metadata().ok().map(|meta| meta.len()) else {
                continue;
            };
            if size > FULL_SNAPSHOT_LIMIT as u64 || size > scan_bytes_remaining {
                continue;
            }
            scan_bytes_remaining -= size;
            let expected = observations
                .iter()
                .map(|(line, value)| (*line, value.as_str()))
                .collect::<HashMap<_, _>>();
            let mut seen = BTreeSet::new();
            if let Some(metadata) = scan_observed_file(call, &resolved, |number, text| {
                if expected.get(&number).is_some_and(|known| *known == text) {
                    seen.insert(number);
                }
            }) {
                remember_sparse(call, state, &path, &metadata, seen);
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
        if resolved
            .metadata()
            .ok()
            .is_some_and(|meta| meta.len() > 128 * 1024)
        {
            if let Some(range) = self.range {
                self.observe_file_known_range(call, state, resolved, output, range);
            } else {
                self.observe_file_streamed(call, state, resolved, output);
            }
            return;
        }
        let Some(file) = read_text(call, resolved) else {
            return;
        };
        let mut seen = BTreeSet::new();
        let (from, to) = self
            .range
            .map(|range| range.bounds(file.lines.len()))
            .unwrap_or((0, file.lines.len()));
        // Do not construct a full-file String when the model saw only a short
        // search result. CRLF/BOM can make the on-disk byte count larger.
        let whole_file = self.range.is_none()
            && file.total_bytes <= output.len().saturating_mul(2).saturating_add(3)
            && output == file.normalized();
        if whole_file {
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
                    if let Some((printed_path, number, value)) = split_numbered_path(line)
                        && let Some((_, resolved)) = self.resolve(call, printed_path)
                        && resolved.canonical == *path
                        && matches_line(&file, number, value)
                    {
                        seen.insert(number);
                    }
                    // An unknown numbered representation cannot establish provenance.
                    continue;
                }
                unnumbered.push(line);
            }
            // Linear-time contiguous-sequence search first, then a single
            // pass for uniquely identified individual lines. Repeated source
            // lines must not trigger O(output_lines * source_lines) scans.
            if !unnumbered.is_empty() {
                if let Some(start) = unique_contiguous_range(&file.lines[from..to], &unnumbered) {
                    seen.extend(from + start + 1..=from + start + unnumbered.len());
                } else {
                    seen.extend(unique_source_lines(
                        &file.lines[from..to],
                        &unnumbered,
                        from,
                    ));
                }
            }
        }
        remember(call, state, path, &file, seen);
    }

    /// Deterministic source ranges are validated against the precise original
    /// line positions, even for files containing millions of repeated values.
    fn observe_file_known_range(
        &self,
        call: &ToolCall,
        state: &FileToolState,
        resolved: &crate::instance::sandbox::path::ResolvedPath,
        output: &str,
        range: ReadRange,
    ) {
        let Some(bytes) = read_observed_bytes(call, resolved) else {
            return;
        };
        let revision = blake3::hash(&bytes).to_hex().to_string();
        let body = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
        let Some(content) = std::str::from_utf8(body).ok() else {
            return;
        };
        // Count line breaks without building an owned Vec for every line.
        let total_lines = memchr::memchr_iter(b'\n', content.as_bytes()).count()
            + usize::from(!content.is_empty() && !content.ends_with('\n'));
        let (from, to) = range.bounds(total_lines);
        if from >= to {
            return;
        }
        let candidates = content
            .split_terminator('\n')
            .skip(from)
            .take(to - from)
            .map(|record| record.strip_suffix('\r').unwrap_or(record))
            .collect::<Vec<_>>();
        if candidates.iter().any(|line| line.contains('\r')) {
            return;
        }
        let metadata = TextMetadata {
            revision,
            total_bytes: bytes.len(),
            total_lines,
        };
        let expected = candidates.join("\n")
            + if to < total_lines || content.ends_with('\n') {
                "\n"
            } else {
                ""
            };
        let mut seen = BTreeSet::new();
        if output == expected {
            seen.extend(from + 1..=to);
        } else {
            let returned = complete_lines(output);
            if returned.is_empty() {
                return;
            }
            if let Some(start) = unique_borrowed_range(&candidates, &returned) {
                seen.extend(from + start + 1..=from + start + returned.len());
            } else {
                let wanted = returned
                    .iter()
                    .copied()
                    .filter(|line| !line.is_empty())
                    .collect::<HashSet<_>>();
                let mut found = HashMap::<&str, Option<usize>>::new();
                for (index, line) in candidates.iter().enumerate() {
                    if let Some(known) = wanted.get(line) {
                        match found.entry(*known) {
                            std::collections::hash_map::Entry::Vacant(entry) => {
                                entry.insert(Some(from + index + 1));
                            }
                            std::collections::hash_map::Entry::Occupied(mut entry) => {
                                *entry.get_mut() = None;
                            }
                        }
                    }
                }
                seen.extend(found.into_values().flatten());
            }
        }
        remember_sparse(call, state, &resolved.canonical, &metadata, seen);
    }

    /// Inspect long, mostly-unseen files using borrowed line slices.
    /// The same BLAKE3 revision is computed while scanning.
    fn observe_file_streamed(
        &self,
        call: &ToolCall,
        state: &FileToolState,
        resolved: &crate::instance::sandbox::path::ResolvedPath,
        output: &str,
    ) {
        if resolved
            .metadata()
            .ok()
            .is_none_or(|meta| meta.len() > FULL_SNAPSHOT_LIMIT as u64)
        {
            return;
        }
        let lines = complete_lines(output);
        if lines.is_empty() {
            return;
        }
        let mut numbered = HashMap::<usize, &str>::new();
        let mut plain = Vec::new();
        for line in lines {
            if self.numbered {
                if let Some((number, value)) =
                    split_numbered_line(line).or_else(|| split_tab_numbered_line(line))
                {
                    numbered.insert(number, value);
                    continue;
                }
                if let Some((source_path, number, value)) = split_numbered_path(line)
                    && self
                        .resolve(call, source_path)
                        .is_some_and(|(_, file)| file.canonical == resolved.canonical)
                {
                    numbered.insert(number, value);
                }
                // Never match unrecognized numbered output to a literal line.
                continue;
            }
            plain.push(line);
        }
        let wanted = plain
            .iter()
            .copied()
            .filter(|line| !line.is_empty())
            .collect::<HashSet<_>>();
        let mut positions = HashMap::<&str, Option<usize>>::with_capacity(wanted.len());
        let prefix = kmp_prefix(&plain);
        let mut matched = 0usize;
        let mut unique_match = None;
        let mut multiple_matches = false;
        let mut seen = BTreeSet::new();
        let metadata = scan_observed_file(call, resolved, |number, text| {
            if numbered.get(&number).is_some_and(|value| *value == text) {
                seen.insert(number);
            }
            if let Some(known) = wanted.get(text) {
                // Reuse the output's stable line, without per-match allocation.
                match positions.entry(*known) {
                    std::collections::hash_map::Entry::Vacant(entry) => {
                        entry.insert(Some(number));
                    }
                    std::collections::hash_map::Entry::Occupied(mut entry) => {
                        *entry.get_mut() = None;
                    }
                }
            }
            if !plain.is_empty() && !multiple_matches {
                while matched > 0 && text != plain[matched] {
                    matched = prefix[matched - 1];
                }
                if text == plain[matched] {
                    matched += 1;
                }
                if matched == plain.len() {
                    if unique_match.is_some() {
                        multiple_matches = true;
                    } else {
                        unique_match = Some(number + 1 - plain.len());
                    }
                    matched = prefix[matched - 1];
                }
            }
        });
        let Some(metadata) = metadata else {
            return;
        };
        if let Some(start) = unique_match.filter(|_| !multiple_matches) {
            seen.extend(start..start + plain.len());
        } else {
            seen.extend(positions.into_values().flatten());
        }
        remember_sparse(call, state, &resolved.canonical, &metadata, seen);
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
            if !numbered
                && args
                    .iter()
                    .any(|arg| matches!(arg.as_str(), "-H" | "--with-filename"))
            {
                return None;
            }
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
            // -n/-H add synthetic prefixes; textual coincidence is not proof
            // that the corresponding source line was observed.
            search_operands(command).is_some_and(|(files, numbered)| {
                files.is_empty()
                    && !numbered
                    && !command
                        .args
                        .iter()
                        .any(|arg| matches!(arg.as_str(), "-H" | "--with-filename" | "-r" | "-R"))
            })
        }
        "sort" => command
            .args
            .iter()
            .all(|arg| matches!(arg.as_str(), "-r" | "-n" | "-u" | "-s")),
        "uniq" => command
            .args
            .iter()
            .all(|arg| matches!(arg.as_str(), "-d" | "-u")),
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
        if command.name == "rg" && matches!(arg, "-r" | "-R") {
            // ripgrep -r is --replace, not grep's recursive option.
            return None;
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

fn kmp_prefix(returned: &[&str]) -> Vec<usize> {
    let mut prefix = vec![0; returned.len()];
    let mut previous = 0_usize;
    for index in 1..returned.len() {
        while previous > 0 && returned[previous] != returned[index] {
            previous = prefix[previous - 1];
        }
        if returned[previous] == returned[index] {
            previous += 1;
        }
        prefix[index] = previous;
    }
    prefix
}

fn unique_contiguous_range(source: &[String], returned: &[&str]) -> Option<usize> {
    let m = returned.len();
    if m == 0 || m > source.len() {
        return None;
    }
    // KMP, O(source_lines + output_lines), including adversarial repetition.
    let prefix = kmp_prefix(returned);
    let mut matched = 0_usize;
    let mut only = None;
    for (index, line) in source.iter().enumerate() {
        while matched > 0 && line != returned[matched] {
            matched = prefix[matched - 1];
        }
        if line == returned[matched] {
            matched += 1;
        }
        if matched == m {
            if only.is_some() {
                return None;
            }
            only = Some(index + 1 - m);
            matched = prefix[matched - 1];
        }
    }
    only
}

fn unique_borrowed_range(source: &[&str], returned: &[&str]) -> Option<usize> {
    if returned.is_empty() || returned.len() > source.len() {
        return None;
    }
    let mut matches = source
        .windows(returned.len())
        .enumerate()
        .filter_map(|(index, lines)| (lines == returned).then_some(index));
    match (matches.next(), matches.next()) {
        (Some(index), None) => Some(index),
        _ => None,
    }
}

fn unique_source_lines(source: &[String], returned: &[&str], offset: usize) -> BTreeSet<usize> {
    let wanted = returned
        .iter()
        .copied()
        .filter(|text| !text.is_empty())
        .collect::<HashSet<_>>();
    let mut positions = HashMap::<&str, Option<usize>>::with_capacity(wanted.len());
    for (index, line) in source.iter().enumerate() {
        if !wanted.contains(line.as_str()) {
            continue;
        }
        match positions.entry(line) {
            std::collections::hash_map::Entry::Vacant(vacant) => {
                vacant.insert(Some(offset + index + 1));
            }
            std::collections::hash_map::Entry::Occupied(mut occupied) => {
                *occupied.get_mut() = None;
            }
        }
    }
    positions.into_values().flatten().collect()
}

/// Read a bounded, already-authorized source file without per-line allocation.
fn read_observed_bytes(
    call: &ToolCall,
    resolved: &crate::instance::sandbox::path::ResolvedPath,
) -> Option<Vec<u8>> {
    let metadata = resolved.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > FULL_SNAPSHOT_LIMIT as u64 {
        return None;
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    resolved
        .open_file()
        .ok()?
        .take(FULL_SNAPSHOT_LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    call.check_cancelled().ok()?;
    if bytes.len() > FULL_SNAPSHOT_LIMIT || bytes.contains(&0) {
        return None;
    }
    Some(bytes)
}

/// A single BLAKE3 digest and borrowed source-line slices avoid repeated
/// per-line allocations for large files.
fn scan_observed_file(
    call: &ToolCall,
    resolved: &crate::instance::sandbox::path::ResolvedPath,
    mut visit: impl FnMut(usize, &str),
) -> Option<TextMetadata> {
    let bytes = read_observed_bytes(call, resolved)?;
    let revision = blake3::hash(&bytes).to_hex().to_string();
    let body = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
    let content = std::str::from_utf8(body).ok()?;
    let mut total_lines = 0;
    for record in content.split_terminator('\n') {
        let line = record.strip_suffix('\r').unwrap_or(record);
        // CR-only newlines are unusual; do not grant any coverage unless
        // line boundaries are unambiguous under TextFile's normalization.
        if line.contains('\r') {
            return None;
        }
        total_lines += 1;
        visit(total_lines, line);
    }
    Some(TextMetadata {
        revision,
        total_bytes: bytes.len(),
        total_lines,
    })
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

fn remember_sparse(
    call: &ToolCall,
    state: &FileToolState,
    path: &Path,
    metadata: &TextMetadata,
    seen: BTreeSet<usize>,
) {
    if seen.is_empty() || seen.len() > MAX_OBSERVED_LINES {
        return;
    }
    let ordinal = state.next_snapshot_ordinal();
    if let Ok(mut snapshots) = state.context_snapshots.lock() {
        snapshots.remember_sparse(&call.ctx_id, path, metadata, seen, ordinal);
    }
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
            "cat a.rs | grep -r something",
        ] {
            assert!(CommandReadPlan::analyze(script, cwd).is_none(), "{script}");
        }
    }
}
