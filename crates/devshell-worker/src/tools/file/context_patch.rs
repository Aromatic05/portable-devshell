use crate::tools::ToolError;
use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Boundary {
    Anywhere,
    Beginning,
    End,
}

#[derive(Clone, Debug)]
pub(super) struct Hunk {
    pub(super) boundary: Boundary,
    pub(super) old_lines: Vec<String>,
    pub(super) new_lines: Vec<String>,
}

#[derive(Debug)]
pub struct PatchApplication {
    pub normalized: String,
    pub required_lines: BTreeSet<usize>,
    pub resulting_known_lines: BTreeSet<usize>,
    pub added_lines: usize,
    pub removed_lines: usize,
    line_edits: Vec<(usize, usize, usize)>,
}

impl PatchApplication {
    pub fn remap_seen_lines(&self, old: &BTreeSet<usize>) -> BTreeSet<usize> {
        remap_seen_lines(&self.resulting_known_lines, &self.line_edits, old)
    }
}

pub fn validate(patch: &str) -> Result<(), ToolError> {
    parse(patch).map(|_| ())
}

pub fn apply(base: &str, patch: &str) -> Result<PatchApplication, ToolError> {
    let hunks = parse(patch)?;
    let final_newline = base.ends_with('\n');
    let body = base.strip_suffix('\n').unwrap_or(base);
    let lines = if base.is_empty() {
        Vec::new()
    } else {
        body.split('\n').map(ToOwned::to_owned).collect::<Vec<_>>()
    };

    let mut located = Vec::with_capacity(hunks.len());
    for (index, hunk) in hunks.iter().enumerate() {
        let position = locate(&lines, hunk).map_err(|error| {
            error.with_details(serde_json::json!({
                "hunk": index + 1,
                "candidateLines": candidate_lines(&lines, hunk),
            }))
        })?;
        located.push((position, hunk));
    }

    validate_located_overlap(
        located
            .iter()
            .map(|(position, hunk)| (*position, hunk.old_lines.len())),
    )?;

    let mut required_lines = BTreeSet::new();
    let mut resulting_known_lines = BTreeSet::new();
    let mut line_edits = Vec::new();
    let mut added_lines = 0usize;
    let mut removed_lines = 0usize;
    for (position, hunk) in &located {
        let changed = changed_span(hunk);
        for offset in 0..hunk.old_lines.len() {
            required_lines.insert(position + offset + 1);
        }
        if hunk.old_lines.is_empty() && !lines.is_empty() {
            required_lines.insert(match hunk.boundary {
                Boundary::Beginning => 1,
                Boundary::End => lines.len(),
                Boundary::Anywhere => unreachable!(),
            });
        }
        line_edits.push((*position, hunk.old_lines.len(), hunk.new_lines.len()));
        let known_end = hunk.new_lines.len().max(1);
        for offset in 0..known_end {
            resulting_known_lines.insert(position + offset + 1);
        }
        added_lines += changed.1;
        removed_lines += changed.0;
    }

    let mut result = lines;
    located.sort_by_key(|(position, _)| *position);
    for (position, hunk) in located.into_iter().rev() {
        let end = position + hunk.old_lines.len();
        result.splice(position..end, hunk.new_lines.clone());
    }

    let mut normalized = result.join("\n");
    if !result.is_empty() && final_newline {
        normalized.push('\n');
    }
    Ok(PatchApplication {
        normalized,
        required_lines,
        resulting_known_lines,
        added_lines,
        removed_lines,
        line_edits,
    })
}

pub(super) fn validate_located_overlap(
    edits: impl IntoIterator<Item = (usize, usize)>,
) -> Result<(), ToolError> {
    let mut ordered = edits.into_iter().collect::<Vec<_>>();
    ordered.sort_unstable();
    for pair in ordered.windows(2) {
        let (left_start, left_len) = pair[0];
        let (right_start, right_len) = pair[1];
        if (left_start == right_start && (left_len > 0 || right_len > 0))
            || left_start + left_len > right_start
        {
            return Err(ToolError::new(
                "file.patchOverlap",
                "patch hunks overlap in the original snapshot",
            ));
        }
    }
    Ok(())
}

pub(super) fn remap_seen_lines(
    resulting_known_lines: &BTreeSet<usize>,
    line_edits: &[(usize, usize, usize)],
    old: &BTreeSet<usize>,
) -> BTreeSet<usize> {
    let mut result = resulting_known_lines.clone();
    for line in old {
        let zero_based = line.saturating_sub(1);
        let mut delta = 0isize;
        let mut replaced = false;
        for (position, old_len, new_len) in line_edits {
            if zero_based < *position {
                break;
            }
            if zero_based < position + old_len {
                replaced = true;
                break;
            }
            delta += *new_len as isize - *old_len as isize;
        }
        if !replaced {
            let mapped = (zero_based as isize + delta + 1).max(1) as usize;
            result.insert(mapped);
        }
    }
    result
}

pub(super) fn parse(patch: &str) -> Result<Vec<Hunk>, ToolError> {
    let lines = patch
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect::<Vec<_>>();
    let mut hunks = Vec::new();
    let mut index = 0usize;
    while index < lines.len() {
        if lines[index].is_empty() && index + 1 == lines.len() {
            break;
        }
        let boundary = match lines[index] {
            "@@" => Boundary::Anywhere,
            "@@ BOF" => Boundary::Beginning,
            "@@ EOF" => Boundary::End,
            value if value.starts_with("@@") => {
                return Err(invalid(format!(
                    "unsupported hunk header {value:?}; expected @@, @@ BOF, or @@ EOF"
                )));
            }
            _ => return Err(invalid("each patch hunk must start with @@")),
        };
        index += 1;
        let mut old_lines = Vec::new();
        let mut new_lines = Vec::new();
        while index < lines.len() && !lines[index].starts_with("@@") {
            if lines[index].is_empty() && index + 1 == lines.len() {
                index += 1;
                break;
            }
            let line = lines[index];
            let Some(marker) = line.chars().next() else {
                return Err(invalid("patch lines require a prefix"));
            };
            let value = line[marker.len_utf8()..].to_string();
            match marker {
                ' ' => {
                    old_lines.push(value.clone());
                    new_lines.push(value);
                }
                '-' => old_lines.push(value),
                '+' => new_lines.push(value),
                _ => {
                    return Err(invalid("patch lines must start with space, -, or +"));
                }
            }
            index += 1;
        }
        if old_lines.is_empty() && new_lines.is_empty() {
            return Err(invalid("patch hunk cannot be empty"));
        }
        if boundary == Boundary::Anywhere && old_lines.is_empty() {
            return Err(invalid("an unanchored insertion must use @@ BOF or @@ EOF"));
        }
        hunks.push(Hunk {
            boundary,
            old_lines,
            new_lines,
        });
    }
    if hunks.is_empty() {
        return Err(ToolError::new(
            "file.emptyOperation",
            "Patch File contains no hunks",
        ));
    }
    Ok(hunks)
}

fn locate(lines: &[String], hunk: &Hunk) -> Result<usize, ToolError> {
    if hunk.old_lines.is_empty() {
        return Ok(match hunk.boundary {
            Boundary::Beginning => 0,
            Boundary::End => lines.len(),
            Boundary::Anywhere => unreachable!(),
        });
    }
    let matches = candidate_positions(lines, hunk);
    match matches.as_slice() {
        [position] => Ok(*position),
        [] => Err(ToolError::new(
            "file.patchNotFound",
            "patch context did not match the file snapshot",
        )),
        _ => Err(ToolError::new(
            "file.patchAmbiguous",
            "patch context matched more than once",
        )),
    }
}

fn candidate_positions(lines: &[String], hunk: &Hunk) -> Vec<usize> {
    if hunk.old_lines.len() > lines.len() {
        return Vec::new();
    }
    (0..=lines.len() - hunk.old_lines.len())
        .filter(|position| {
            let boundary_matches = match hunk.boundary {
                Boundary::Anywhere => true,
                Boundary::Beginning => *position == 0,
                Boundary::End => *position + hunk.old_lines.len() == lines.len(),
            };
            boundary_matches && lines[*position..*position + hunk.old_lines.len()] == hunk.old_lines
        })
        .collect()
}

fn candidate_lines(lines: &[String], hunk: &Hunk) -> Vec<usize> {
    candidate_positions(lines, hunk)
        .into_iter()
        .map(|position| position + 1)
        .collect()
}

pub(super) fn changed_span(hunk: &Hunk) -> (usize, usize) {
    let common_prefix = hunk
        .old_lines
        .iter()
        .zip(&hunk.new_lines)
        .take_while(|(left, right)| left == right)
        .count();
    let common_suffix = hunk
        .old_lines
        .iter()
        .rev()
        .zip(hunk.new_lines.iter().rev())
        .take_while(|(left, right)| left == right)
        .count()
        .min(hunk.old_lines.len().saturating_sub(common_prefix))
        .min(hunk.new_lines.len().saturating_sub(common_prefix));
    (
        hunk.old_lines
            .len()
            .saturating_sub(common_prefix + common_suffix),
        hunk.new_lines
            .len()
            .saturating_sub(common_prefix + common_suffix),
    )
}

fn invalid(message: impl Into<String>) -> ToolError {
    ToolError::new("file.invalidPatch", message.into())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use crate::tools::ToolCancellation;

    use super::apply;
    use crate::tools::file::context_patch_stream::plan_streaming;

    #[test]
    fn applies_multiple_hunks_against_original_coordinates() {
        let result = apply(
            "one\ntwo\nthree\nfour\n",
            "@@\n one\n-two\n+second\n@@\n three\n-four\n+fourth",
        )
        .unwrap();
        assert_eq!(result.normalized, "one\nsecond\nthree\nfourth\n");
    }

    #[test]
    fn rejects_ambiguous_context() {
        let error = apply("same\nsame\n", "@@\n-same\n+changed").unwrap_err();
        assert_eq!(error.code, "file.patchAmbiguous");
    }

    #[test]
    fn supports_boundary_insertions() {
        assert_eq!(
            apply("middle\n", "@@ BOF\n+head\n@@ EOF\n+tail")
                .unwrap()
                .normalized,
            "head\nmiddle\ntail\n"
        );
    }

    #[test]
    fn rejects_insertion_and_replacement_at_the_same_source_position() {
        for patch in [
            "@@ BOF\n+inserted\n@@\n-original\n+replacement",
            "@@\n-original\n+replacement\n@@ BOF\n+inserted",
        ] {
            let error = apply("original\n", patch).unwrap_err();
            assert_eq!(error.code, "file.patchOverlap");
        }
    }

    #[test]
    fn streaming_patch_matches_materialized_patch() {
        let base = "one\ntwo\nthree\nfour\n";
        let patch = "@@\n one\n-two\n+second\n@@\n three\n-four\n+fourth";
        let directory = crate::testing::temp_dir();
        let path = directory.path().join("document.txt");
        fs::write(&path, base).unwrap();
        let cancellation = ToolCancellation::default();
        let plan = plan_streaming(fs::File::open(&path).unwrap(), patch, &cancellation).unwrap();
        let mut output = Vec::new();
        let metadata = plan
            .write(fs::File::open(&path).unwrap(), &mut output, &cancellation)
            .unwrap();

        let expected = apply(base, patch).unwrap().normalized;
        assert_eq!(String::from_utf8(output.clone()).unwrap(), expected);
        assert_eq!(
            metadata.revision,
            blake3::hash(&output).to_hex().to_string()
        );
        assert_eq!(metadata.total_lines, 4);
    }

    #[test]
    fn streaming_patch_preserves_bom_crlf_and_final_newline() {
        let directory = crate::testing::temp_dir();
        let path = directory.path().join("document.txt");
        fs::write(&path, b"\xef\xbb\xbfone\r\ntwo\r\n").unwrap();
        let cancellation = ToolCancellation::default();
        let plan = plan_streaming(
            fs::File::open(&path).unwrap(),
            "@@\n one\n-two\n+second",
            &cancellation,
        )
        .unwrap();
        let mut output = Vec::new();
        plan.write(fs::File::open(&path).unwrap(), &mut output, &cancellation)
            .unwrap();

        assert_eq!(output, b"\xef\xbb\xbfone\r\nsecond\r\n");
    }
}
