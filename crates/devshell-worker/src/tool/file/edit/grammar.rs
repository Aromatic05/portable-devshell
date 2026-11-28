use super::{MAX_CHANGE_OPERATIONS, invalid_edit, patch};
use crate::tool::ToolError;

#[derive(Clone, Debug)]
pub(super) enum ParsedOperation {
    Write { path: String, content: String },
    Patch { path: String, patch: patch::Patch },
    Rewrite { path: String, content: String },
    Delete { path: String },
    Move { source: String, target: String },
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Dialect {
    Patch,
    LegacyEdit,
}

pub(super) fn parse_change_set(input: &str) -> Result<Vec<ParsedOperation>, ToolError> {
    let normalized = input.replace("\r\n", "\n").replace('\r', "\n");
    let lines = normalized.split('\n').collect::<Vec<_>>();
    let first = lines
        .iter()
        .position(|line| !line.trim().is_empty())
        .ok_or_else(|| invalid_edit("change set is empty"))?;
    let mut last = lines
        .iter()
        .rposition(|line| !line.trim().is_empty())
        .ok_or_else(|| invalid_edit("change set is empty"))?;
    let dialect = match lines[first].trim() {
        "*** Begin Patch" => Dialect::Patch,
        "*** Begin Edit" => Dialect::LegacyEdit,
        _ => return Err(invalid_edit("change set must start with `*** Begin Patch`")),
    };
    // Preserve the existing Pi compatibility trailer without rewriting patch bodies.
    if dialect == Dialect::Patch && lines[last].trim() == "*** End Edit" {
        if let Some(index) = lines[..last]
            .iter()
            .rposition(|line| !line.trim().is_empty())
            && lines[index].trim() == "*** End Patch"
        {
            last = index;
        }
    }
    let end = match dialect {
        Dialect::Patch => "*** End Patch",
        Dialect::LegacyEdit => "*** End Edit",
    };
    if lines[last].trim() != end || first >= last {
        return Err(invalid_edit(format!("change set must end with {end}")));
    }

    let mut operations = Vec::new();
    let mut index = first + 1;
    while index < last {
        if lines[index].trim().is_empty() {
            index += 1;
            continue;
        }
        let line = lines[index];
        let legacy = dialect == Dialect::LegacyEdit;
        if let Some(raw) = line.strip_prefix("*** Add File:").or_else(|| {
            legacy
                .then(|| line.strip_prefix("*** Write File:"))
                .flatten()
        }) {
            let path = parse_path(raw)?;
            let (body, next) = collect_body(&lines, index + 1, last, dialect);
            let content = if line.starts_with("*** Add File:") {
                prefixed_body(body)?
            } else {
                let content = literal_body(body.to_vec());
                reject_literal_diff(&content)?;
                content
            };
            operations.push(ParsedOperation::Write { path, content });
            index = next;
        } else if let Some(raw) = line.strip_prefix("*** Rewrite File:") {
            let path = parse_path(raw)?;
            let (body, next) = collect_body(&lines, index + 1, last, dialect);
            let content = if legacy {
                let content = literal_body(body.to_vec());
                reject_literal_diff(&content)?;
                content
            } else {
                prefixed_body(body)?
            };
            operations.push(ParsedOperation::Rewrite { path, content });
            index = next;
        } else if let Some(raw) = line.strip_prefix("*** Update File:").or_else(|| {
            legacy
                .then(|| line.strip_prefix("*** Patch File:"))
                .flatten()
        }) {
            let path = parse_path(raw)?;
            index += 1;
            let target = if index < last
                && let Some(raw) = lines[index].strip_prefix("*** Move to:")
            {
                index += 1;
                Some(parse_path(raw)?)
            } else {
                None
            };
            let (body, next) = collect_body(&lines, index, last, dialect);
            let move_only = target.is_some() && body.iter().all(|line| line.is_empty());
            if !body.is_empty() && !move_only {
                let patch = patch::parse(body, legacy)?;
                operations.push(ParsedOperation::Patch {
                    path: path.clone(),
                    patch,
                });
            } else if target.is_none() {
                return Err(invalid_edit("Update File requires a hunk or Move to"));
            }
            if let Some(target) = target {
                operations.push(ParsedOperation::Move {
                    source: path,
                    target,
                });
            }
            index = next;
        } else if let Some(raw) = line.strip_prefix("*** Delete File:") {
            let path = parse_path(raw)?;
            index = skip_blank_lines(&lines, index + 1, last);
            if index < last && !is_operation_header(lines[index], dialect) {
                return Err(invalid_edit("Delete File does not accept a body"));
            }
            operations.push(ParsedOperation::Delete { path });
        } else if legacy && let Some(raw) = line.strip_prefix("*** Move File:") {
            let source = parse_path(raw)?;
            index = skip_blank_lines(&lines, index + 1, last);
            let target = lines
                .get(index)
                .and_then(|line| line.strip_prefix("*** To:"))
                .ok_or_else(|| invalid_edit("Move File requires a following *** To: line"))?;
            let target = parse_path(target)?;
            index = skip_blank_lines(&lines, index + 1, last);
            if index < last && !is_operation_header(lines[index], dialect) {
                return Err(invalid_edit("Move File does not accept a body"));
            }
            operations.push(ParsedOperation::Move { source, target });
        } else {
            return Err(invalid_edit(format!("unexpected change-set line: {line}")));
        }

        if operations.len() > MAX_CHANGE_OPERATIONS {
            return Err(ToolError::new(
                "file.tooManyOperations",
                format!("change set supports at most {MAX_CHANGE_OPERATIONS} operations"),
            ));
        }
    }
    if operations.is_empty() {
        return Err(ToolError::new(
            "file.emptyOperation",
            "change set contains no file operations",
        ));
    }
    Ok(operations)
}

fn is_operation_header(line: &str, dialect: Dialect) -> bool {
    line.starts_with("*** Add File:")
        || line.starts_with("*** Update File:")
        || line.starts_with("*** Rewrite File:")
        || line.starts_with("*** Delete File:")
        || matches!(line, "*** End Patch" | "*** End Edit")
        || (dialect == Dialect::LegacyEdit
            && (line.starts_with("*** Write File:")
                || line.starts_with("*** Patch File:")
                || line.starts_with("*** Move File:")))
}

fn collect_body<'a>(
    lines: &'a [&'a str],
    start: usize,
    end: usize,
    dialect: Dialect,
) -> (&'a [&'a str], usize) {
    let mut index = start;
    while index < end && !is_operation_header(lines[index], dialect) {
        index += 1;
    }
    (&lines[start..index], index)
}

fn skip_blank_lines(lines: &[&str], mut index: usize, end: usize) -> usize {
    while index < end && lines[index].trim().is_empty() {
        index += 1;
    }
    index
}

fn prefixed_body(mut lines: &[&str]) -> Result<String, ToolError> {
    while lines.last() == Some(&"") {
        lines = &lines[..lines.len() - 1];
    }
    let mut content = String::new();
    for line in lines {
        let value = line.strip_prefix('+').ok_or_else(|| {
            invalid_edit("Add File and Rewrite File body lines must start with +")
        })?;
        content.push_str(value);
        content.push('\n');
    }
    Ok(content)
}

// Legacy Begin Edit literal bodies remain accepted for existing callers.
fn literal_body(lines: Vec<&str>) -> String {
    if lines.is_empty() {
        return String::new();
    }
    let mut content = lines.join("\n");
    content.push('\n');
    content
}

const LITERAL_DIFF_LINE_RATIO: f64 = 0.5;

fn reject_literal_diff(content: &str) -> Result<(), ToolError> {
    let mut total = 0usize;
    let mut prefixed = 0usize;
    for line in content.split('\n') {
        if line.trim().is_empty() {
            continue;
        }
        total += 1;
        if line.starts_with('+') || line.starts_with('-') {
            prefixed += 1;
        }
    }
    if total > 0 && prefixed as f64 / total as f64 > LITERAL_DIFF_LINE_RATIO {
        return Err(ToolError::new(
            "file.literalDiffBody",
            "Stop pasting diffs into Write File and Rewrite File. They take literal content only; your body is almost entirely `+`/`-` prefixed patch lines, a format only Patch File accepts. Re-output the body as plain text with no diff markers.",
        ));
    }
    Ok(())
}

fn parse_path(raw: &str) -> Result<String, ToolError> {
    let path = raw.trim();
    if path.is_empty() || path.contains('\0') {
        return Err(ToolError::new(
            "file.invalidPath",
            "file path is empty or invalid",
        ));
    }
    Ok(path.to_string())
}
