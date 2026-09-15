use super::{DEFAULT_LINE_COUNT, MAX_RANGES};
use crate::tool::ToolError;

pub(super) struct ParsedSelector {
    pub(super) ranges: Vec<(usize, usize)>,
    pub(super) truncated: bool,
    pub(super) next_selector: Option<String>,
}

pub(super) fn remaining_selector(
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

pub(super) fn parse_selector(
    selector: Option<&str>,
    total: usize,
) -> Result<ParsedSelector, ToolError> {
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
        if start > total || end < start {
            return Err(ToolError::new(
                "file.invalidRange",
                "selector range is outside the file or has an invalid order",
            ));
        }
        if is_open_window {
            if !requested.is_empty() || range_text.contains(',') {
                return Err(ToolError::new(
                    "file.invalidRange",
                    "open-ended selectors such as `50` cannot be combined with other ranges",
                ));
            }
            open_window = Some((start, end));
        }
        requested.push((start, end));
    }

    requested.sort_unstable_by_key(|range| range.0);
    let mut normalized_requested: Vec<(usize, usize)> = Vec::with_capacity(requested.len());
    for (start, end) in requested {
        match normalized_requested.last_mut() {
            Some((_, previous_end)) if start <= previous_end.saturating_add(1) => {
                *previous_end = (*previous_end).max(end);
            }
            _ => normalized_requested.push((start, end)),
        }
    }

    let mut expanded: Vec<(usize, usize)> = Vec::with_capacity(normalized_requested.len());
    for (start, end) in normalized_requested {
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

pub(super) fn parse_positive(value: &str) -> Result<usize, ToolError> {
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
