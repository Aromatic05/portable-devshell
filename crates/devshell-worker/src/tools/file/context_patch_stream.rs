use std::collections::{BTreeSet, VecDeque};
use std::fs;
use std::io::Write;

use crate::tools::file::context_patch::{
    Boundary, Hunk, changed_span, parse, remap_seen_lines, validate_located_overlap,
};
use crate::tools::file::state::{TextInspection, TextMetadata, scan_text_lines};
use crate::tools::{ToolCancellation, ToolError};

const MAX_REPORTED_CANDIDATES: usize = 32;

#[derive(Clone, Debug)]
struct LocatedHunk {
    hunk: Hunk,
    position: usize,
}

#[derive(Debug)]
pub struct StreamingPatchPlan {
    pub inspection: TextInspection,
    pub required_lines: BTreeSet<usize>,
    pub resulting_known_lines: BTreeSet<usize>,
    pub added_lines: usize,
    pub removed_lines: usize,
    line_edits: Vec<(usize, usize, usize)>,
    located: Vec<LocatedHunk>,
}

impl StreamingPatchPlan {
    pub fn remap_seen_lines(&self, old: &BTreeSet<usize>) -> BTreeSet<usize> {
        remap_seen_lines(&self.resulting_known_lines, &self.line_edits, old)
    }

    pub fn write(
        &self,
        file: fs::File,
        writer: &mut dyn Write,
        cancellation: &ToolCancellation,
    ) -> Result<TextMetadata, ToolError> {
        let mut output = EncodedLineWriter::new(writer, self.inspection.format)?;
        let mut next_edit = 0usize;
        let mut skip_until = 0usize;
        let source = scan_text_lines(file, cancellation, |line_no, line| {
            let position = line_no - 1;
            while self
                .located
                .get(next_edit)
                .is_some_and(|edit| edit.position == position)
            {
                let edit = &self.located[next_edit];
                for replacement in &edit.hunk.new_lines {
                    output.write_line(replacement)?;
                }
                skip_until = skip_until.max(position.saturating_add(edit.hunk.old_lines.len()));
                next_edit += 1;
            }
            if position >= skip_until {
                output.write_line(line)?;
            }
            Ok(())
        })?;
        if source.metadata.revision != self.inspection.metadata.revision {
            return Err(ToolError::retryable(
                "file.revisionMismatch",
                "file changed while preparing the patch",
            ));
        }
        while self
            .located
            .get(next_edit)
            .is_some_and(|edit| edit.position == source.metadata.total_lines)
        {
            let edit = &self.located[next_edit];
            for replacement in &edit.hunk.new_lines {
                output.write_line(replacement)?;
            }
            next_edit += 1;
        }
        if next_edit != self.located.len() {
            return Err(ToolError::new(
                "tool.internalError",
                "streaming patch plan did not consume every hunk",
            ));
        }
        output.finish(self.inspection.format.final_newline)
    }
}

pub fn plan_streaming(
    file: fs::File,
    patch: &str,
    cancellation: &ToolCancellation,
) -> Result<StreamingPatchPlan, ToolError> {
    let hunks = parse(patch)?;
    let maximum_old_lines = hunks
        .iter()
        .map(|hunk| hunk.old_lines.len())
        .max()
        .unwrap_or(0);
    let mut tail = VecDeque::<String>::with_capacity(maximum_old_lines);
    let mut candidates = vec![Vec::<usize>::new(); hunks.len()];
    let inspection = scan_text_lines(file, cancellation, |line_no, line| {
        if maximum_old_lines > 0 {
            tail.push_back(line.to_string());
            if tail.len() > maximum_old_lines {
                tail.pop_front();
            }
        }
        for (index, hunk) in hunks.iter().enumerate() {
            if hunk.old_lines.is_empty() || hunk.boundary == Boundary::End {
                continue;
            }
            let count = hunk.old_lines.len();
            if line_no < count {
                continue;
            }
            let position = line_no - count;
            if hunk.boundary == Boundary::Beginning && position != 0 {
                continue;
            }
            if tail_matches(&tail, &hunk.old_lines)
                && candidates[index].len() <= MAX_REPORTED_CANDIDATES
            {
                candidates[index].push(position);
            }
        }
        Ok(())
    })?;

    for (index, hunk) in hunks.iter().enumerate() {
        if hunk.old_lines.is_empty() {
            candidates[index].push(match hunk.boundary {
                Boundary::Beginning => 0,
                Boundary::End => inspection.metadata.total_lines,
                Boundary::Anywhere => unreachable!(),
            });
            continue;
        }
        if hunk.boundary == Boundary::End {
            let count = hunk.old_lines.len();
            if inspection.metadata.total_lines >= count
                && tail_matches(&tail, &hunk.old_lines)
                && candidates[index].len() <= MAX_REPORTED_CANDIDATES
            {
                candidates[index].push(inspection.metadata.total_lines - count);
            }
        }
    }

    let mut located = Vec::with_capacity(hunks.len());
    for (index, hunk) in hunks.into_iter().enumerate() {
        let position = match candidates[index].as_slice() {
            [position] => *position,
            [] => {
                return Err(ToolError::new(
                    "file.patchNotFound",
                    "patch context did not match the file snapshot",
                )
                .with_details(serde_json::json!({
                    "hunk": index + 1,
                    "candidateLines": [],
                })));
            }
            positions => {
                return Err(ToolError::new(
                    "file.patchAmbiguous",
                    "patch context matched more than once",
                )
                .with_details(serde_json::json!({
                    "hunk": index + 1,
                    "candidateLines": positions.iter().take(MAX_REPORTED_CANDIDATES).map(|position| position + 1).collect::<Vec<_>>(),
                    "candidateLinesTruncated": positions.len() > MAX_REPORTED_CANDIDATES,
                })));
            }
        };
        located.push(LocatedHunk { hunk, position });
    }
    located.sort_by_key(|edit| edit.position);
    validate_located_overlap(
        located
            .iter()
            .map(|edit| (edit.position, edit.hunk.old_lines.len())),
    )?;

    let mut required_lines = BTreeSet::new();
    let mut resulting_known_lines = BTreeSet::new();
    let mut line_edits = Vec::with_capacity(located.len());
    let mut added_lines = 0usize;
    let mut removed_lines = 0usize;
    for edit in &located {
        let changed = changed_span(&edit.hunk);
        for offset in 0..edit.hunk.old_lines.len() {
            required_lines.insert(edit.position + offset + 1);
        }
        if edit.hunk.old_lines.is_empty() && inspection.metadata.total_lines > 0 {
            required_lines.insert(match edit.hunk.boundary {
                Boundary::Beginning => 1,
                Boundary::End => inspection.metadata.total_lines,
                Boundary::Anywhere => unreachable!(),
            });
        }
        line_edits.push((
            edit.position,
            edit.hunk.old_lines.len(),
            edit.hunk.new_lines.len(),
        ));
        for offset in 0..edit.hunk.new_lines.len().max(1) {
            resulting_known_lines.insert(edit.position + offset + 1);
        }
        added_lines += changed.1;
        removed_lines += changed.0;
    }

    Ok(StreamingPatchPlan {
        inspection,
        required_lines,
        resulting_known_lines,
        added_lines,
        removed_lines,
        line_edits,
        located,
    })
}

fn tail_matches(tail: &VecDeque<String>, expected: &[String]) -> bool {
    if expected.len() > tail.len() {
        return false;
    }
    tail.iter()
        .skip(tail.len() - expected.len())
        .zip(expected)
        .all(|(left, right)| left == right)
}

struct EncodedLineWriter<'a> {
    writer: &'a mut dyn Write,
    hasher: blake3::Hasher,
    line_ending: &'static str,
    total_bytes: usize,
    logical_lines: usize,
    first_line_empty: bool,
}

impl<'a> EncodedLineWriter<'a> {
    fn new(writer: &'a mut dyn Write, format: crate::tools::file::state::TextFormat) -> Result<Self, ToolError> {
        let mut output = Self {
            writer,
            hasher: blake3::Hasher::new(),
            line_ending: format.line_ending,
            total_bytes: 0,
            logical_lines: 0,
            first_line_empty: false,
        };
        if format.bom {
            output.write_bytes(&[0xEF, 0xBB, 0xBF])?;
        }
        Ok(output)
    }

    fn write_line(&mut self, line: &str) -> Result<(), ToolError> {
        if self.logical_lines > 0 {
            self.write_bytes(self.line_ending.as_bytes())?;
        } else {
            self.first_line_empty = line.is_empty();
        }
        self.write_bytes(line.as_bytes())?;
        self.logical_lines += 1;
        Ok(())
    }

    fn finish(mut self, final_newline: bool) -> Result<TextMetadata, ToolError> {
        if self.logical_lines > 0 && final_newline {
            self.write_bytes(self.line_ending.as_bytes())?;
        }
        let total_lines = if self.logical_lines == 1 && self.first_line_empty && !final_newline {
            0
        } else {
            self.logical_lines
        };
        Ok(TextMetadata {
            revision: self.hasher.finalize().to_hex().to_string(),
            total_bytes: self.total_bytes,
            total_lines,
        })
    }

    fn write_bytes(&mut self, bytes: &[u8]) -> Result<(), ToolError> {
        self.writer
            .write_all(bytes)
            .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
        self.hasher.update(bytes);
        self.total_bytes = self.total_bytes.saturating_add(bytes.len());
        Ok(())
    }
}

