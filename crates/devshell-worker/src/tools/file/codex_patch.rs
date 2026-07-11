use crate::tools::ToolError;

#[derive(Clone, Debug)]
pub enum CodexPatchAction {
    Add {
        path: String,
        content: String,
    },
    Delete {
        path: String,
    },
    Update {
        path: String,
        move_to: Option<String>,
        chunks: Vec<CodexUpdateChunk>,
    },
}

#[derive(Clone, Debug)]
pub struct CodexUpdateChunk {
    pub anchor: Option<String>,
    pub old_lines: Vec<String>,
    pub new_lines: Vec<String>,
    pub end_of_file: bool,
}

pub fn is_codex_envelope(input: &str) -> bool {
    let lines = input
        .lines()
        .map(|line| line.trim_end_matches('\r'))
        .collect::<Vec<_>>();
    codex_begin_index(&lines).is_some()
}

fn codex_begin_index(lines: &[&str]) -> Option<usize> {
    let first = lines.iter().position(|line| !line.trim().is_empty())?;
    if lines[first].trim() == "*** Begin Patch" {
        return Some(first);
    }
    if !lines[first].trim().starts_with("apply_patch <<") {
        return None;
    }
    lines
        .iter()
        .enumerate()
        .skip(first + 1)
        .find_map(|(index, line)| (!line.trim().is_empty()).then_some((index, line.trim())))
        .and_then(|(index, line)| (line == "*** Begin Patch").then_some(index))
}

pub fn parse(input: &str) -> Result<Vec<CodexPatchAction>, ToolError> {
    let all_lines = input
        .lines()
        .map(|line| line.trim_end_matches('\r'))
        .collect::<Vec<_>>();
    let begin = codex_begin_index(&all_lines)
        .ok_or_else(|| invalid("Codex patch requires Begin Patch marker at the input start"))?;
    let end = all_lines
        .iter()
        .enumerate()
        .skip(begin + 1)
        .find_map(|(index, line)| (line.trim() == "*** End Patch").then_some(index))
        .ok_or_else(|| invalid("Codex patch requires End Patch marker"))?;
    let lines = &all_lines[begin..=end];

    let mut actions = Vec::new();
    let mut index = 1usize;
    while index + 1 < lines.len() {
        let line = lines[index];
        if let Some(path) = line.strip_prefix("*** Add File:") {
            let path = workspace_path(path)?;
            index += 1;
            let mut body = Vec::new();
            while index + 1 < lines.len() && !is_file_header(lines[index]) {
                if lines[index] == "*** End of File" {
                    index += 1;
                    break;
                }
                let Some(value) = lines[index].strip_prefix('+') else {
                    return Err(invalid("Add File body lines must start with +"));
                };
                body.push(value.to_string());
                index += 1;
            }
            let mut content = body.join("\n");
            if !body.is_empty() {
                content.push('\n');
            }
            actions.push(CodexPatchAction::Add { path, content });
            continue;
        }
        if let Some(path) = line.strip_prefix("*** Delete File:") {
            let path = workspace_path(path)?;
            index += 1;
            if index + 1 < lines.len() && !is_file_header(lines[index]) {
                return Err(invalid("Delete File does not accept a body"));
            }
            actions.push(CodexPatchAction::Delete { path });
            continue;
        }
        if let Some(path) = line.strip_prefix("*** Update File:") {
            let path = workspace_path(path)?;
            index += 1;
            let move_to = if index + 1 < lines.len() {
                lines[index]
                    .strip_prefix("*** Move to:")
                    .map(workspace_path)
                    .transpose()?
            } else {
                None
            };
            if move_to.is_some() {
                index += 1;
            }
            let mut chunks = Vec::new();
            while index + 1 < lines.len() && !is_file_header(lines[index]) {
                let Some(anchor_text) = lines[index].strip_prefix("@@") else {
                    return Err(invalid("Update File chunks must start with @@"));
                };
                let anchor_text = anchor_text.trim().trim_end_matches("@@").trim();
                let anchor = (!anchor_text.is_empty()).then(|| anchor_text.to_string());
                index += 1;
                let mut old_lines = Vec::new();
                let mut new_lines = Vec::new();
                let mut end_of_file = false;
                while index + 1 < lines.len()
                    && !is_file_header(lines[index])
                    && !lines[index].starts_with("@@")
                {
                    let chunk_line = lines[index];
                    if chunk_line == "*** End of File" {
                        end_of_file = true;
                        index += 1;
                        break;
                    }
                    let mut characters = chunk_line.chars();
                    let marker = characters
                        .next()
                        .ok_or_else(|| invalid("Codex chunk lines require a prefix"))?;
                    let value = characters.as_str().to_string();
                    match marker {
                        ' ' => {
                            old_lines.push(value.clone());
                            new_lines.push(value);
                        }
                        '-' => old_lines.push(value),
                        '+' => new_lines.push(value),
                        _ => {
                            return Err(invalid(
                                "Codex chunk lines must start with space, -, or +",
                            ));
                        }
                    }
                    index += 1;
                }
                if old_lines.is_empty() && new_lines.is_empty() && anchor.is_none() {
                    return Err(invalid("empty Codex update chunk"));
                }
                chunks.push(CodexUpdateChunk {
                    anchor,
                    old_lines,
                    new_lines,
                    end_of_file,
                });
            }
            if chunks.is_empty() && move_to.is_none() {
                return Err(invalid("Update File requires chunks or Move to"));
            }
            actions.push(CodexPatchAction::Update {
                path,
                move_to,
                chunks,
            });
            continue;
        }
        return Err(invalid("unexpected Codex patch marker"));
    }

    if actions.is_empty() {
        return Err(ToolError::new(
            "file.emptyOperation",
            "Codex patch contains no file operations",
        ));
    }
    Ok(actions)
}

pub fn apply_update(base: &str, chunks: &[CodexUpdateChunk]) -> Result<String, ToolError> {
    let body = base.strip_suffix('\n').unwrap_or(base);
    let mut lines = if base.is_empty() {
        Vec::new()
    } else {
        body.split('\n').map(ToOwned::to_owned).collect::<Vec<_>>()
    };
    let mut cursor = 0usize;

    for chunk in chunks {
        let search_start = if let Some(anchor) = &chunk.anchor {
            find_unique_line(&lines, anchor, cursor)? + 1
        } else {
            cursor
        };
        let position = if chunk.old_lines.is_empty() {
            if chunk.end_of_file || chunk.anchor.is_none() {
                lines.len()
            } else {
                search_start
            }
        } else {
            find_unique_sequence(&lines, &chunk.old_lines, search_start, chunk.end_of_file)?
        };
        let end = position + chunk.old_lines.len();
        lines.splice(position..end, chunk.new_lines.clone());
        cursor = position + chunk.new_lines.len();
    }

    let mut result = lines.join("\n");
    if !lines.is_empty() {
        result.push('\n');
    }
    Ok(result)
}

fn find_unique_line(lines: &[String], anchor: &str, start: usize) -> Result<usize, ToolError> {
    let matches = lines
        .iter()
        .enumerate()
        .skip(start)
        .filter_map(|(index, line)| (line == anchor).then_some(index))
        .collect::<Vec<_>>();
    unique_match(matches, "anchor")
}

fn find_unique_sequence(
    lines: &[String],
    expected: &[String],
    start: usize,
    end_of_file: bool,
) -> Result<usize, ToolError> {
    if expected.len() > lines.len() {
        return Err(no_match("old lines"));
    }
    let matches = (start..=lines.len() - expected.len())
        .filter(|position| {
            (!end_of_file || position + expected.len() == lines.len())
                && lines[*position..*position + expected.len()] == *expected
        })
        .collect::<Vec<_>>();
    unique_match(matches, "old lines")
}

fn unique_match(matches: Vec<usize>, label: &str) -> Result<usize, ToolError> {
    match matches.as_slice() {
        [position] => Ok(*position),
        [] => Err(no_match(label)),
        _ => Err(ToolError::new(
            "file.patchAmbiguous",
            format!("Codex patch {label} matches more than once"),
        )),
    }
}

fn no_match(label: &str) -> ToolError {
    ToolError::new(
        "file.patchNoMatch",
        format!("Codex patch {label} did not match"),
    )
}

fn is_file_header(line: &str) -> bool {
    line.starts_with("*** Add File:")
        || line.starts_with("*** Delete File:")
        || line.starts_with("*** Update File:")
        || line == "*** End Patch"
}

fn workspace_path(raw: &str) -> Result<String, ToolError> {
    let path = raw.trim();
    if path.is_empty() || path.starts_with('/') || path.contains('\0') {
        return Err(ToolError::new(
            "file.invalidPath",
            "Codex patch paths must be workspace-relative",
        ));
    }
    Ok(if path.starts_with("./") {
        path.to_string()
    } else {
        format!("./{path}")
    })
}

fn invalid(message: &str) -> ToolError {
    ToolError::new("file.invalidPatch", message)
}

#[cfg(test)]
mod tests {
    use super::{CodexPatchAction, apply_update, is_codex_envelope, parse};

    #[test]
    fn parses_envelope_and_applies_exact_update_chunks() {
        let actions = parse(concat!(
            "*** Begin Patch\n",
            "*** Add File: new.txt\n",
            "+new\n",
            "*** Update File: old.txt\n",
            "@@ section\n",
            "-old\n",
            "+updated\n",
            "*** Delete File: delete.txt\n",
            "*** End Patch"
        ))
        .unwrap();
        assert_eq!(actions.len(), 3);
        let CodexPatchAction::Update { chunks, .. } = &actions[1] else {
            panic!("expected update");
        };
        assert_eq!(
            apply_update("section\nold\n", chunks).unwrap(),
            "section\nupdated\n"
        );
    }

    #[test]
    fn rejects_ambiguous_old_lines_without_an_anchor() {
        let actions = parse(concat!(
            "*** Begin Patch\n",
            "*** Update File: old.txt\n",
            "@@\n",
            "-same\n",
            "+changed\n",
            "*** End Patch"
        ))
        .unwrap();
        let CodexPatchAction::Update { chunks, .. } = &actions[0] else {
            panic!("expected update");
        };
        assert_eq!(
            apply_update("same\nsame\n", chunks).unwrap_err().code,
            "file.patchAmbiguous"
        );
    }

    #[test]
    fn appends_pure_insertions_without_an_anchor() {
        let actions = parse(concat!(
            "*** Begin Patch\n",
            "*** Update File: old.txt\n",
            "@@\n",
            "+appended\n",
            "*** End Patch"
        ))
        .unwrap();
        let CodexPatchAction::Update { chunks, .. } = &actions[0] else {
            panic!("expected update");
        };
        assert_eq!(apply_update("old\n", chunks).unwrap(), "old\nappended\n");
    }

    #[test]
    fn accepts_heredoc_wrappers_and_adds_final_newline() {
        let actions = parse(concat!(
            "apply_patch <<'PATCH'\n",
            "*** Begin Patch\n",
            "*** Add File: new.txt\n",
            "+new\n",
            "*** End Patch\n",
            "PATCH\n"
        ))
        .unwrap();
        let CodexPatchAction::Add { content, .. } = &actions[0] else {
            panic!("expected add");
        };
        assert_eq!(content, "new\n");
    }

    #[test]
    fn unified_diff_context_does_not_trigger_codex_detection() {
        let input = concat!(
            "--- a/file.txt\n",
            "+++ b/file.txt\n",
            "@@ -1,2 +1,2 @@\n",
            " context\n",
            " *** Begin Patch\n"
        );
        assert!(!is_codex_envelope(input));

        let heredoc = concat!(
            "apply_patch <<'PATCH'\n",
            "*** Begin Patch\n",
            "*** Add File: new.txt\n",
            "+new\n",
            "*** End Patch\n",
            "PATCH\n"
        );
        assert!(is_codex_envelope(heredoc));
    }
}
