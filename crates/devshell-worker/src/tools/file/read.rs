use std::sync::Arc;

use schemars::schema_for;

use crate::tools::file::state::{FULL_SNAPSHOT_LIMIT, TextFile, TextMetadata};
use crate::tools::file::structure;
use crate::tools::file::types::{FileReadInput, FileReadOutput, ReturnedRange};
use crate::tools::file::{FileToolState, resolve_existing};
use crate::tools::{ToolAccess, ToolCall, ToolCatalogEntry, ToolError, ToolHandler, ToolName};

const DEFAULT_LINE_COUNT: usize = 200;
const MAX_RANGES: usize = 16;
const MAX_CONTENT_BYTES: usize = 1024 * 1024;

pub struct FileReadTool {
    name: ToolName,
    state: Arc<FileToolState>,
}
impl FileReadTool {
    pub fn new(state: Arc<FileToolState>) -> Self {
        Self {
            name: ToolName::parse("file_read").unwrap(),
            state,
        }
    }
}
impl ToolHandler for FileReadTool {
    fn name(&self) -> &ToolName {
        &self.name
    }
    fn catalog_entry(&self) -> ToolCatalogEntry {
        ToolCatalogEntry {
            group: self.name.group().to_string(),
            name: self.name.as_str(),
            description: concat!(
                "Read UTF-8 text and create a snapshot for later file_edit calls. Without selector, supported source files return a compact Tree-sitter structure summary; other files return the first 200 lines. ",
                "Selectors use one-based lines: `50` reads a default window from line 50, `50-100` reads an inclusive range, `50+100` reads 100 lines, and comma joins sorted non-overlapping ranges such as `5-16,960-973`. ",
                "Explicit ranges normally include one preceding and three following context lines. Add `:raw` to suppress context expansion, for example `50-100:raw`; selector `raw` starts at the full-file range but remains subject to the output byte limit and returns nextSelector when pagination is required. ",
                "The first content line is `[path#snapshotTag]` and can be copied directly into file_edit. Only complete source lines actually returned in content become editable snapshot coverage; omitted or truncated lines are not authorized for editing."
            )
            .to_string(),
            input_schema: serde_json::to_value(schema_for!(FileReadInput)).unwrap(),
            output_schema: serde_json::to_value(schema_for!(FileReadOutput)).unwrap(),
            access: ToolAccess::Read,
        }
    }
    fn call(&self, call: ToolCall) -> Result<serde_json::Value, ToolError> {
        let input: FileReadInput = serde_json::from_value(call.params.clone())
            .map_err(|error| ToolError::new("tool.invalidArguments", error.to_string()))?;
        let (requested, path) = resolve_existing(&call, &input.path, false)?;
        if !path.is_file() {
            return Err(ToolError::new("file.notFile", "path is not a file"));
        }
        let metadata = TextMetadata::inspect(&path)?;
        let small_text = if metadata.total_bytes <= FULL_SNAPSHOT_LIMIT {
            Some(TextFile::read(&path)?)
        } else {
            None
        };
        let mut selector = if input.selector.is_none() {
            if let Some(text) = &small_text {
                if let Some(summary) =
                    structure::summarize(&path, &text.normalized(), text.lines.len())?
                {
                    ParsedSelector {
                        truncated: summary.lines.len() < text.lines.len(),
                        next_selector: summary.next_selector,
                        ranges: coalesce_lines(&summary.lines),
                    }
                } else {
                    parse_selector(None, metadata.total_lines)?
                }
            } else {
                parse_selector(None, metadata.total_lines)?
            }
        } else {
            parse_selector(input.selector.as_deref(), metadata.total_lines)?
        };
        let selected = TextMetadata::read_selected(&path, &selector.ranges, MAX_CONTENT_BYTES)?;
        if selected.metadata.revision != metadata.revision
            || small_text
                .as_ref()
                .is_some_and(|text| text.revision != selected.metadata.revision)
        {
            return Err(ToolError::retryable(
                "file.revisionMismatch",
                "file changed while it was being read",
            ));
        }
        let metadata = selected.metadata.clone();
        let mut content = String::new();
        let mut returned = Vec::new();
        let mut seen = Vec::new();
        for (line_no, line) in &selected.lines {
            if !content.is_empty() {
                content.push('\n');
            }
            content.push_str(&format!("{line_no}:{line}"));
            seen.push(*line_no);
        }
        for (start, end) in coalesce_lines(&seen) {
            returned.push(ReturnedRange {
                start_line: start,
                end_line: end,
            });
        }
        if let Some(next_line) = selected.next_line {
            selector.truncated = true;
            selector.next_selector = remaining_selector(
                &selector.ranges,
                next_line,
                selector.next_selector.as_deref(),
            );
        }
        let snapshot = if let Some(text) = &small_text {
            self.state
                .snapshots
                .lock()
                .unwrap()
                .remember(&path, text, seen)
        } else {
            self.state
                .snapshots
                .lock()
                .unwrap()
                .remember_sparse(&path, &metadata, seen)
        };
        let header = format!("[{}#{}]", requested.raw, snapshot.tag);
        let content = if content.is_empty() {
            header
        } else {
            format!("{header}\n{content}")
        };
        serde_json::to_value(FileReadOutput {
            path: requested.raw,
            snapshot_id: snapshot.id,
            snapshot_tag: snapshot.tag,
            revision: metadata.revision,
            content,
            returned_ranges: returned,
            total_lines: metadata.total_lines,
            total_bytes: metadata.total_bytes,
            truncated: selector.truncated,
            next_selector: selector.next_selector,
        })
        .map_err(|error| ToolError::new("tool.internalError", error.to_string()))
    }
}

struct ParsedSelector {
    ranges: Vec<(usize, usize)>,
    truncated: bool,
    next_selector: Option<String>,
}

fn remaining_selector(
    ranges: &[(usize, usize)],
    next_line: usize,
    existing_tail: Option<&str>,
) -> Option<String> {
    let remaining = ranges
        .iter()
        .filter_map(|(start, end)| {
            if *end < next_line {
                None
            } else {
                Some(((*start).max(next_line), *end))
            }
        })
        .collect::<Vec<_>>();
    if remaining.is_empty() {
        return existing_tail.map(ToOwned::to_owned);
    }
    let mut selector = format!(
        "{}:raw",
        remaining
            .into_iter()
            .map(|(start, end)| format!("{start}-{end}"))
            .collect::<Vec<_>>()
            .join(",")
    );
    if let Some(tail) = existing_tail {
        selector.push_str(";next=");
        selector.push_str(tail);
    }
    Some(selector)
}

fn parse_selector(selector: Option<&str>, total: usize) -> Result<ParsedSelector, ToolError> {
    let Some(selector) = selector else {
        let end = total.min(DEFAULT_LINE_COUNT);
        return Ok(ParsedSelector {
            ranges: if end == 0 { Vec::new() } else { vec![(1, end)] },
            truncated: total > end,
            next_selector: (total > end).then(|| (end + 1).to_string()),
        });
    };
    let selector = selector.trim();
    let (selector, continuation) = if let Some((body, tail)) = selector.split_once(";next=") {
        if body.is_empty() || tail.is_empty() || tail.contains(';') {
            return Err(ToolError::new(
                "file.invalidRange",
                "selector continuation is invalid",
            ));
        }
        let tail_raw = tail.ends_with(":raw");
        let tail_start = parse_positive(tail.strip_suffix(":raw").unwrap_or(tail))?;
        if tail_start > total {
            return Err(ToolError::new(
                "file.invalidRange",
                "selector continuation starts beyond the end of the file",
            ));
        }
        let tail = if tail_raw {
            format!("{tail_start}:raw")
        } else {
            tail_start.to_string()
        };
        (body, Some(tail))
    } else {
        (selector, None)
    };
    let raw_mode = selector.ends_with(":raw") || selector == "raw";
    let range_text = selector.strip_suffix(":raw").unwrap_or(selector);
    if range_text == "raw" {
        return Ok(ParsedSelector {
            ranges: if total == 0 {
                Vec::new()
            } else {
                vec![(1, total)]
            },
            truncated: false,
            next_selector: None,
        });
    }

    let mut requested = Vec::new();
    let mut previous_requested_end = 0;
    let mut open_window = None;
    for part in range_text.split(',') {
        if requested.len() >= MAX_RANGES {
            return Err(ToolError::new(
                "file.invalidRange",
                "at most 16 selector ranges are allowed",
            ));
        }
        let part = part.trim();
        let (start, end, is_open_window) = if let Some((left, right)) = part.split_once('+') {
            let start = parse_positive(left)?;
            let count = parse_positive(right)?;
            (start, start.saturating_add(count - 1).min(total), false)
        } else if let Some((left, right)) = part.split_once('-') {
            (
                parse_positive(left)?,
                parse_positive(right)?.min(total),
                false,
            )
        } else {
            let start = parse_positive(part)?;
            (
                start,
                total.min(start.saturating_add(DEFAULT_LINE_COUNT - 1)),
                true,
            )
        };
        if start > total || end < start || start <= previous_requested_end {
            return Err(ToolError::new(
                "file.invalidRange",
                "selector ranges must be valid, sorted, and non-overlapping",
            ));
        }
        if is_open_window {
            if requested.len() != 0 || range_text.contains(',') {
                return Err(ToolError::new(
                    "file.invalidRange",
                    "open-ended selectors such as `50` cannot be combined with other ranges",
                ));
            }
            open_window = Some((start, end));
        }
        requested.push((start, end));
        previous_requested_end = end;
    }

    let mut expanded: Vec<(usize, usize)> = Vec::with_capacity(requested.len());
    for (start, end) in requested {
        let range = if raw_mode {
            (start, end)
        } else {
            (
                start.saturating_sub(1).max(1),
                end.saturating_add(3).min(total),
            )
        };
        match expanded.last_mut() {
            Some((_, previous_end)) if range.0 <= previous_end.saturating_add(1) => {
                *previous_end = (*previous_end).max(range.1);
            }
            _ => expanded.push(range),
        }
    }

    if continuation.is_some() && open_window.is_some() {
        return Err(ToolError::new(
            "file.invalidRange",
            "selector continuation cannot contain another open window",
        ));
    }
    let open_next = match open_window {
        Some((_, end)) if end < total => {
            let suffix = if raw_mode { ":raw" } else { "" };
            Some(format!("{}{suffix}", end + 1))
        }
        _ => None,
    };
    let next_selector = continuation.or(open_next);
    Ok(ParsedSelector {
        ranges: expanded,
        truncated: next_selector.is_some(),
        next_selector,
    })
}

fn parse_positive(value: &str) -> Result<usize, ToolError> {
    let value = value.trim().parse::<usize>().map_err(|_| {
        ToolError::new(
            "file.invalidRange",
            "selector contains an invalid line number",
        )
    })?;
    if value == 0 {
        return Err(ToolError::new(
            "file.invalidRange",
            "line numbers are one-based",
        ));
    }
    Ok(value)
}

fn coalesce_lines(lines: &[usize]) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    for line in lines {
        match ranges.last_mut() {
            Some((_, end)) if *line == *end + 1 => *end = *line,
            _ => ranges.push((*line, *line)),
        }
    }
    ranges
}

#[cfg(test)]
mod tests {
    use super::{parse_selector, remaining_selector};

    #[test]
    fn byte_pagination_preserves_the_current_window_before_the_next_window() {
        let selector = parse_selector(Some("1"), 10_000).unwrap();
        assert_eq!(selector.ranges, vec![(1, 203)]);
        assert_eq!(selector.next_selector.as_deref(), Some("201"));

        let next =
            remaining_selector(&selector.ranges, 50, selector.next_selector.as_deref()).unwrap();
        assert_eq!(next, "50-203:raw;next=201");

        let continued = parse_selector(Some(&next), 10_000).unwrap();
        assert_eq!(continued.ranges, vec![(50, 203)]);
        assert_eq!(continued.next_selector.as_deref(), Some("201"));
        assert!(continued.truncated);
    }
}
