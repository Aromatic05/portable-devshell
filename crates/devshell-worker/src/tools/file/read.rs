use std::sync::Arc;

use schemars::schema_for;

use crate::tools::file::state::TextFile;
use crate::tools::file::structure;
use crate::tools::file::types::{FileReadInput, FileReadOutput, ReturnedRange};
use crate::tools::file::{FileToolState, resolve_existing};
use crate::tools::{ToolAccess, ToolCall, ToolCatalogEntry, ToolError, ToolHandler, ToolName};

const DEFAULT_LINE_COUNT: usize = 200;
const MAX_RANGES: usize = 16;

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
            name: self.name.as_str(),
            description: "Read UTF-8 text using selectors such as `50`, `50-100`, `50+100`, `5-16,960-973`, or `raw`.".to_string(),
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
        let text = TextFile::read(&path)?;
        let selector = if input.selector.is_none() {
            if let Some(summary) =
                structure::summarize(&path, &text.normalized(), text.lines.len())?
            {
                ParsedSelector {
                    truncated: summary.lines.len() < text.lines.len(),
                    next_selector: summary.next_selector,
                    ranges: coalesce_lines(&summary.lines),
                }
            } else {
                parse_selector(None, text.lines.len())?
            }
        } else {
            parse_selector(input.selector.as_deref(), text.lines.len())?
        };
        let mut content = String::new();
        let mut returned = Vec::new();
        let mut seen = Vec::new();
        for (start, end) in &selector.ranges {
            if start > end {
                continue;
            }
            if !content.is_empty() {
                content.push('\n');
            }
            for line_no in *start..=*end {
                content.push_str(&format!("{line_no}:{}", text.lines[line_no - 1]));
                if line_no != *end {
                    content.push('\n');
                }
                seen.push(line_no);
            }
            returned.push(ReturnedRange {
                start_line: *start,
                end_line: *end,
            });
        }
        let snapshot_id = self
            .state
            .snapshots
            .lock()
            .unwrap()
            .remember(&path, &text, seen);
        let header = format!("[{}#{}]", requested.raw, snapshot_id);
        let content = if content.is_empty() {
            header
        } else {
            format!("{header}\n{content}")
        };
        serde_json::to_value(FileReadOutput {
            path: requested.raw,
            snapshot_id,
            revision: text.revision,
            content,
            returned_ranges: returned,
            total_lines: text.lines.len(),
            total_bytes: text.total_bytes,
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

fn parse_selector(selector: Option<&str>, total: usize) -> Result<ParsedSelector, ToolError> {
    let Some(selector) = selector else {
        let end = total.min(DEFAULT_LINE_COUNT);
        return Ok(ParsedSelector {
            ranges: if end == 0 { Vec::new() } else { vec![(1, end)] },
            truncated: total > end,
            next_selector: (total > end)
                .then(|| format!("{}-{}", end + 1, (end + DEFAULT_LINE_COUNT).min(total))),
        });
    };
    let selector = selector.trim();
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
    let mut ranges = Vec::new();
    let mut previous_end = 0;
    for part in range_text.split(',') {
        if ranges.len() >= MAX_RANGES {
            return Err(ToolError::new(
                "file.invalidRange",
                "at most 16 selector ranges are allowed",
            ));
        }
        let raw_mode = selector.ends_with(":raw");
        let (mut start, mut end) = if let Some((left, right)) = part.split_once('+') {
            let start = parse_positive(left)?;
            let count = parse_positive(right)?;
            (start, start.saturating_add(count - 1).min(total))
        } else if let Some((left, right)) = part.split_once('-') {
            (parse_positive(left)?, parse_positive(right)?.min(total))
        } else {
            let start = parse_positive(part)?;
            (
                start,
                total.min(start.saturating_add(DEFAULT_LINE_COUNT - 1)),
            )
        };
        if !raw_mode {
            start = start.saturating_sub(1).max(1);
            end = end.saturating_add(3).min(total);
        }
        if start > total || end < start || start <= previous_end {
            return Err(ToolError::new(
                "file.invalidRange",
                "selector ranges must be valid, sorted, and non-overlapping",
            ));
        }
        ranges.push((start, end));
        previous_end = end;
    }
    Ok(ParsedSelector {
        ranges,
        truncated: false,
        next_selector: None,
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
