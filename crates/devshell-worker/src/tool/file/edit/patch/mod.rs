pub mod diff;
pub mod stream;
use crate::tool::ToolError;
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
    pub(super) anchor: Option<String>,
    pub(super) old_lines: Vec<String>,
    pub(super) new_lines: Vec<String>,
}

#[derive(Clone, Debug)]
pub(super) struct Patch(pub(super) Vec<Hunk>);

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

pub(super) fn apply(base: &str, patch: &Patch) -> Result<PatchApplication, ToolError> {
    let hunks = &patch.0;
    let final_newline = base.ends_with('\n');
    let body = base.strip_suffix('\n').unwrap_or(base);
    let lines = if base.is_empty() {
        Vec::new()
    } else {
        body.split('\n').map(ToOwned::to_owned).collect::<Vec<_>>()
    };

    let mut located = Vec::with_capacity(hunks.len());
    let mut required_lines = BTreeSet::new();
    for (index, hunk) in hunks.iter().enumerate() {
        let anchor = locate_anchor(
            hunk,
            lines.iter().enumerate().filter_map(|(position, line)| {
                (hunk.anchor.as_ref() == Some(line)).then_some(position)
            }),
            index,
        )?;
        if let Some(anchor) = anchor {
            required_lines.insert(anchor + 1);
        }
        let candidates = candidate_positions(&lines, hunk, anchor);
        let position = unique_position(&candidates, index, None)?;
        located.push((position, hunk));
    }

    located.sort_by_key(|(position, _)| *position);
    validate_located_overlap(
        located
            .iter()
            .map(|(position, hunk)| (*position, hunk.old_lines.len())),
    )?;

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
        added_lines += changed.1;
        removed_lines += changed.0;
    }

    let resulting_known_lines = generated_coverage(&line_edits);
    let mut result = lines;
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

// Edits are sorted by original position. Only actual replacement lines are known;
// the next untouched line after a deletion is not newly observed.
pub(super) fn generated_coverage(line_edits: &[(usize, usize, usize)]) -> BTreeSet<usize> {
    let mut result = BTreeSet::new();
    let mut delta = 0isize;
    for &(position, old_len, new_len) in line_edits {
        let start = (position as isize + delta) as usize;
        result.extend(start + 1..start + new_len + 1);
        delta += new_len as isize - old_len as isize;
    }
    result
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

pub(super) fn parse(lines: &[&str], legacy: bool) -> Result<Patch, ToolError> {
    let lines = if legacy && lines.last() == Some(&"") {
        &lines[..lines.len() - 1]
    } else {
        lines
    };
    let mut hunks = Vec::new();
    let mut index = 0usize;
    while index < lines.len() {
        let (mut boundary, anchor) = match lines[index] {
            "@@" => {
                index += 1;
                (Boundary::Anywhere, None)
            }
            "@@ BOF" if legacy => {
                index += 1;
                (Boundary::Beginning, None)
            }
            "@@ EOF" if legacy => {
                index += 1;
                (Boundary::End, None)
            }
            value if !legacy && value.starts_with("@@ ") => {
                index += 1;
                (Boundary::Anywhere, Some(value[3..].to_string()))
            }
            value if value.starts_with("@@") => {
                return Err(invalid(format!("unsupported hunk header {value:?}")));
            }
            _ if !legacy && hunks.is_empty() => (Boundary::Anywhere, None),
            _ => return Err(invalid("each patch hunk must start with @@")),
        };
        let mut old_lines = Vec::new();
        let mut new_lines = Vec::new();
        while index < lines.len() && !lines[index].starts_with("@@") {
            let line = lines[index];
            if !legacy && matches!(line, "*** Beginning of File" | "*** End of File") {
                boundary = if line == "*** Beginning of File" {
                    Boundary::Beginning
                } else {
                    Boundary::End
                };
                index += 1;
                while index < lines.len() && lines[index].is_empty() {
                    index += 1;
                }
                break;
            }
            if !legacy && line.is_empty() {
                old_lines.push(String::new());
                new_lines.push(String::new());
                index += 1;
                continue;
            }
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
                _ => return Err(invalid("patch lines must start with space, -, or +")),
            }
            index += 1;
        }
        if old_lines.is_empty() && new_lines.is_empty() {
            return Err(invalid("patch hunk cannot be empty"));
        }
        if boundary == Boundary::Anywhere && old_lines.is_empty() {
            if legacy {
                return Err(invalid("an unanchored insertion must use @@ BOF or @@ EOF"));
            }
            boundary = Boundary::End;
        }
        hunks.push(Hunk {
            boundary,
            anchor,
            old_lines,
            new_lines,
        });
    }
    if hunks.is_empty() {
        return Err(ToolError::new(
            "file.emptyOperation",
            "Update File contains no hunks",
        ));
    }
    Ok(Patch(hunks))
}

// Anchors narrow the search without weakening the exact, unique match contract.
// The anchor is itself part of the observed source coverage.
pub(super) fn locate_anchor(
    hunk: &Hunk,
    positions: impl IntoIterator<Item = usize>,
    index: usize,
) -> Result<Option<usize>, ToolError> {
    if hunk.anchor.is_none() {
        return Ok(None);
    }
    let mut positions = positions.into_iter();
    match (positions.next(), positions.next()) {
        (Some(position), None) => Ok(Some(position)),
        (None, _) => Err(ToolError::new(
            "file.patchNotFound",
            "patch anchor did not match the file snapshot",
        )
        .with_details(serde_json::json!({"hunk": index + 1, "candidateLines": []}))),
        (Some(first), Some(second)) => Err(ToolError::new(
            "file.patchAmbiguous",
            "patch anchor matched more than once",
        )
        .with_details(
            serde_json::json!({"hunk": index + 1, "candidateLines": [first + 1, second + 1]}),
        )),
    }
}

pub(super) fn unique_position(
    positions: &[usize],
    index: usize,
    limit: Option<usize>,
) -> Result<usize, ToolError> {
    match positions {
        [position] => Ok(*position),
        [] => Err(ToolError::new(
            "file.patchNotFound",
            "patch context did not match the file snapshot",
        )
        .with_details(serde_json::json!({"hunk": index + 1, "candidateLines": []}))),
        positions => {
            let mut details = serde_json::json!({
                "hunk": index + 1,
                "candidateLines": positions.iter().take(limit.unwrap_or(usize::MAX)).map(|position| position + 1).collect::<Vec<_>>(),
            });
            if let Some(limit) = limit {
                details["candidateLinesTruncated"] = serde_json::json!(positions.len() > limit);
            }
            Err(ToolError::new(
                "file.patchAmbiguous",
                "patch context matched more than once",
            )
            .with_details(details))
        }
    }
}

pub(super) fn position_matches(position: usize, boundary: Boundary, anchor: Option<usize>) -> bool {
    (boundary != Boundary::Beginning || position == 0)
        && anchor.is_none_or(|anchor| position > anchor)
}

fn candidate_positions(lines: &[String], hunk: &Hunk, anchor: Option<usize>) -> Vec<usize> {
    if hunk.old_lines.is_empty() {
        let position = match hunk.boundary {
            Boundary::Beginning => 0,
            Boundary::End => lines.len(),
            Boundary::Anywhere => unreachable!(),
        };
        return if position_matches(position, hunk.boundary, anchor) {
            vec![position]
        } else {
            vec![]
        };
    }
    if hunk.old_lines.len() > lines.len() {
        return Vec::new();
    }
    (0..=lines.len() - hunk.old_lines.len())
        .filter(|position| {
            position_matches(*position, hunk.boundary, anchor)
                && (hunk.boundary != Boundary::End
                    || *position + hunk.old_lines.len() == lines.len())
                && lines[*position..*position + hunk.old_lines.len()] == hunk.old_lines
        })
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

    use crate::tool::ToolCancellation;

    use super::{PatchApplication, parse};
    use crate::tool::ToolError;
    use crate::tool::file::edit::patch::stream::StreamingPatchPlan;

    fn apply(base: &str, source: &str) -> Result<PatchApplication, ToolError> {
        super::apply(base, &parse(&source.split('\n').collect::<Vec<_>>(), true)?)
    }

    fn plan_streaming(
        file: fs::File,
        source: &str,
        cancellation: &ToolCancellation,
    ) -> Result<StreamingPatchPlan, ToolError> {
        super::stream::plan_streaming(
            file,
            &parse(&source.split('\n').collect::<Vec<_>>(), true)?,
            cancellation,
        )
    }

    #[test]
    fn canonical_hunks_match_in_both_snapshot_paths() {
        let cases = [
            (
                "same\nBOF\nsame\n",
                "@@ BOF\n-same\n+updated",
                "same\nBOF\nupdated\n",
            ),
            (
                "same\nEOF\nsame\n",
                "@@ EOF\n-same\n+updated",
                "same\nEOF\nupdated\n",
            ),
            ("old\n", "-old\n+new", "new\n"),
            ("old\n", "@@\n+tail", "old\ntail\n"),
            ("old\n", "@@\n+head\n*** Beginning of File", "head\nold\n"),
            (
                "same\nmiddle\nsame\n",
                "@@\n-same\n+tail\n*** End of File\n\n",
                "same\nmiddle\ntail\n",
            ),
            (
                "same\nmiddle\nsame\n",
                "@@\n-same\n+head\n*** Beginning of File",
                "head\nmiddle\nsame\n",
            ),
        ];
        let directory = crate::testing::temp_dir();
        let path = directory.path().join("document.txt");
        let cancellation = ToolCancellation::default();
        for (base, source, expected) in cases {
            let patch = parse(&source.split('\n').collect::<Vec<_>>(), false).unwrap();
            let full = super::apply(base, &patch).unwrap();
            assert_eq!(full.normalized, expected, "{source}");
            fs::write(&path, base).unwrap();
            let plan = super::stream::plan_streaming(
                fs::File::open(&path).unwrap(),
                &patch,
                &cancellation,
            )
            .unwrap();
            let mut output = Vec::new();
            plan.write(fs::File::open(&path).unwrap(), &mut output, &cancellation)
                .unwrap();
            assert_eq!(String::from_utf8(output).unwrap(), expected, "{source}");
            assert_eq!(plan.required_lines, full.required_lines, "{source}");
            if source.starts_with("@@ BOF") || source.starts_with("@@ EOF") {
                assert!(
                    full.required_lines.contains(&2),
                    "anchor must require read coverage"
                );
            }
        }
    }

    #[test]
    fn canonical_nonoverlapping_hunks_preserve_content_and_exact_coverage() {
        use std::collections::BTreeSet;

        // Finite model: unique 4-line source, every pair of distinct nonoverlapping
        // single-line edits or boundary insertions, both input orders, all 16
        // original coverage sets. The oracle constructs output from the source
        // in forward order, independently of the production splice/remap code.
        let source = ["a", "b", "c", "d"];
        let base = source.join("\n") + "\n";
        let mut edits = vec![(0, 0, 1), (0, 0, 2), (4, 0, 1), (4, 0, 2)];
        for pos in 0..source.len() {
            for new_len in 0..=2 {
                edits.push((pos, 1, new_len));
            }
        }
        let directory = crate::testing::temp_dir();
        let path = directory.path().join("document.txt");
        fs::write(&path, &base).unwrap();
        let cancellation = ToolCancellation::default();

        for &(p1, old1, new1) in &edits {
            for &(p2, old2, new2) in &edits {
                if p1 == p2 || (p1 < p2 && p1 + old1 > p2) || (p2 < p1 && p2 + old2 > p1) {
                    continue;
                }
                let input = [(p1, old1, new1, "x"), (p2, old2, new2, "y")];
                let mut patch_lines = Vec::new();
                let mut required = BTreeSet::new();
                for (pos, old_len, new_len, label) in input {
                    patch_lines.push("@@".to_string());
                    if old_len == 1 {
                        patch_lines.push(format!("-{}", source[pos]));
                        required.insert(pos + 1);
                    } else {
                        required.insert(if pos == 0 { 1 } else { source.len() });
                    }
                    for n in 0..new_len {
                        patch_lines.push(format!("+{label}{n}"));
                    }
                    if old_len == 0 && pos == 0 {
                        patch_lines.push("*** Beginning of File".to_string());
                    }
                }
                let patch = parse(
                    &patch_lines.iter().map(String::as_str).collect::<Vec<_>>(),
                    false,
                )
                .unwrap();
                let full = super::apply(&base, &patch).unwrap();
                let plan = super::stream::plan_streaming(
                    fs::File::open(&path).unwrap(),
                    &patch,
                    &cancellation,
                )
                .unwrap();
                let mut output = Vec::new();
                plan.write(fs::File::open(&path).unwrap(), &mut output, &cancellation)
                    .unwrap();

                // Each output row carries its original source line (if any).
                let mut rows = Vec::new();
                let mut pos = 0;
                while pos <= source.len() {
                    if let Some(&(_, old_len, new_len, label)) =
                        input.iter().find(|edit| edit.0 == pos)
                    {
                        for n in 0..new_len {
                            rows.push((format!("{label}{n}"), None));
                        }
                        if old_len > 0 {
                            pos += old_len;
                            continue;
                        }
                    }
                    if pos < source.len() {
                        rows.push((source[pos].to_string(), Some(pos + 1)));
                    }
                    pos += 1;
                }
                let expected = rows
                    .iter()
                    .map(|(line, _)| line.as_str())
                    .collect::<Vec<_>>()
                    .join("\n")
                    + "\n";
                assert_eq!(full.normalized, expected, "{patch_lines:?}");
                assert_eq!(
                    String::from_utf8(output).unwrap(),
                    expected,
                    "{patch_lines:?}"
                );
                assert_eq!(full.required_lines, required);
                assert_eq!(plan.required_lines, required);
                let generated = rows
                    .iter()
                    .enumerate()
                    .filter_map(|(i, (_, original))| original.is_none().then_some(i + 1))
                    .collect::<BTreeSet<_>>();
                assert_eq!(full.resulting_known_lines, generated);
                assert_eq!(plan.resulting_known_lines, generated);
                for mask in 0..16 {
                    let seen = (1..=source.len())
                        .filter(|i| mask & (1 << (i - 1)) != 0)
                        .collect::<BTreeSet<_>>();
                    if !required.is_subset(&seen) {
                        continue;
                    }
                    let expected_seen = rows
                        .iter()
                        .enumerate()
                        .filter_map(|(i, (_, original))| {
                            original
                                .is_none_or(|line| seen.contains(&line))
                                .then_some(i + 1)
                        })
                        .collect::<BTreeSet<_>>();
                    assert_eq!(
                        full.remap_seen_lines(&seen),
                        expected_seen,
                        "{patch_lines:?} {seen:?}"
                    );
                    assert_eq!(
                        plan.remap_seen_lines(&seen),
                        expected_seen,
                        "{patch_lines:?} {seen:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn canonical_anchor_and_boundary_errors_agree_in_both_snapshot_paths() {
        let directory = crate::testing::temp_dir();
        let path = directory.path().join("document.txt");
        let cancellation = ToolCancellation::default();
        for (base, source, code) in [
            (
                "anchor\nsame\nanchor\nsame\n",
                "@@ anchor\n-same\n+new",
                "file.patchAmbiguous",
            ),
            (
                "anchor\nsame\nsame\n",
                "@@ anchor\n-same\n+new",
                "file.patchAmbiguous",
            ),
            (
                "same\nanchor\n",
                "@@ anchor\n-same\n+new",
                "file.patchNotFound",
            ),
            (
                "one\ntwo\n",
                "@@\n-one\n+new\n*** End of File",
                "file.patchNotFound",
            ),
            (
                "one\ntwo\n",
                "@@\n-two\n+new\n*** Beginning of File",
                "file.patchNotFound",
            ),
        ] {
            let patch = parse(&source.split('\n').collect::<Vec<_>>(), false).unwrap();
            assert_eq!(
                super::apply(base, &patch).unwrap_err().code,
                code,
                "{source}"
            );
            fs::write(&path, base).unwrap();
            assert_eq!(
                super::stream::plan_streaming(
                    fs::File::open(&path).unwrap(),
                    &patch,
                    &cancellation
                )
                .unwrap_err()
                .code,
                code,
                "{source}"
            );
        }
    }

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
