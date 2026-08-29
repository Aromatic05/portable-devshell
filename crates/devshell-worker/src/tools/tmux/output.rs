use std::collections::VecDeque;
use std::ffi::OsStr;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;

use super::transcript_ring::{self, RingWriter};
use super::warning;

use crate::tools::ToolError;
use crate::tools::tmux::types::TmuxWarning;

pub const MAX_TRANSCRIPT_BYTES: u64 = 4 * 1024 * 1024;
pub const MAX_TRANSCRIPT_RING_BYTES: u64 = 4 * 1024 * 1024;
pub const TRANSCRIPT_LOGGER_MODE: &str = "__tmux-transcript-logger";
const MAX_RENDERED_RECORD_BYTES: usize = 4096;

pub fn try_run_transcript_logger() -> Option<Result<(), String>> {
    let mut args = std::env::args_os();
    let _ = args.next();
    if args.next().as_deref() != Some(OsStr::new(TRANSCRIPT_LOGGER_MODE)) {
        return None;
    }
    Some((|| {
        let transcript = PathBuf::from(
            args.next()
                .ok_or_else(|| "tmux transcript logger path is missing".to_string())?,
        );
        let ring = args
            .next()
            .and_then(|value| value.into_string().ok())
            .ok_or_else(|| "tmux transcript logger shared-memory name is missing".to_string())?;
        let done = PathBuf::from(
            args.next()
                .ok_or_else(|| "tmux transcript logger completion path is missing".to_string())?,
        );
        if args.next().is_some() {
            return Err("tmux transcript logger received unexpected arguments".to_string());
        }

        let mut input = std::io::stdin().lock();
        let mut output = OpenOptions::new()
            .append(true)
            .open(&transcript)
            .map_err(|error| format!("failed to open {}: {error}", transcript.display()))?;
        let mut ring = RingWriter::open(&ring, MAX_TRANSCRIPT_RING_BYTES, MAX_TRANSCRIPT_BYTES)
            .map_err(|error| format!("failed to open shared transcript buffer {ring}: {error}"))?;
        drain_transcript(&mut input, &mut output, &mut ring, MAX_TRANSCRIPT_BYTES)
            .map_err(|error| format!("failed to write {}: {error}", transcript.display()))?;
        drop(output);
        std::fs::write(&done, b"done\n")
            .map_err(|error| format!("failed to write {}: {error}", done.display()))?;
        Ok(())
    })())
}

fn drain_transcript(
    input: &mut impl Read,
    output: &mut impl Write,
    ring: &mut RingWriter,
    durable_limit: u64,
) -> std::io::Result<()> {
    let mut logical_offset = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        let durable_remaining = durable_limit.saturating_sub(logical_offset);
        let persisted = count.min(durable_remaining as usize);
        if persisted > 0 {
            output.write_all(&buffer[..persisted])?;
        }
        if persisted < count {
            ring.append(logical_offset + persisted as u64, &buffer[persisted..count])?;
        }
        logical_offset += count as u64;
    }
    output.flush()
}

#[derive(Debug, Clone)]
pub struct TranscriptCursor {
    pub path: PathBuf,
    pub ring_name: String,
    offset: u64,
    rotation_reported_until: u64,
}

impl TranscriptCursor {
    pub fn new(path: PathBuf, ring_name: String) -> Self {
        Self {
            path,
            ring_name,
            offset: 0,
            rotation_reported_until: 0,
        }
    }

    pub fn restore(path: PathBuf, ring_name: String, offset: u64) -> Self {
        Self {
            path,
            ring_name,
            offset,
            rotation_reported_until: 0,
        }
    }

    pub fn offset(&self) -> u64 {
        self.offset
    }

    pub fn has_output(&self, terminal: bool) -> Result<bool, ToolError> {
        let mut cursor = self.clone();
        Ok(!cursor
            .take_oldest(1, "probe", &mut Vec::new(), terminal)?
            .is_empty())
    }

    pub fn take_output(
        &mut self,
        pane_id: &str,
        warnings: &mut Vec<TmuxWarning>,
        line: i64,
        terminal: bool,
    ) -> Result<Vec<String>, ToolError> {
        if line == 0 {
            self.discard()?;
            return Ok(Vec::new());
        }
        if line > 0 {
            return self.take_oldest(line as usize, pane_id, warnings, terminal);
        }
        self.take_tail(line.unsigned_abs() as usize, pane_id, warnings, terminal)
    }

    fn take_oldest(
        &mut self,
        limit: usize,
        pane_id: &str,
        warnings: &mut Vec<TmuxWarning>,
        terminal: bool,
    ) -> Result<Vec<String>, ToolError> {
        let mut output = Vec::new();
        self.consume_records(pane_id, warnings, terminal, Some(limit), |record| {
            output.push(record);
        })?;
        Ok(output)
    }

    fn take_tail(
        &mut self,
        limit: usize,
        pane_id: &str,
        warnings: &mut Vec<TmuxWarning>,
        terminal: bool,
    ) -> Result<Vec<String>, ToolError> {
        let mut tail = VecDeque::with_capacity(limit);
        let mut skipped = false;
        self.consume_records(pane_id, warnings, terminal, None, |record| {
            if limit == 0 {
                skipped = true;
            } else if tail.len() == limit {
                tail.pop_front();
                skipped = true;
                tail.push_back(record);
            } else {
                tail.push_back(record);
            }
        })?;
        if skipped {
            warnings.push(warning(
                Some(pane_id),
                "tmux.outputSkipped",
                "earlier unread task transcript was discarded; only the requested tail was returned",
            ));
        }
        Ok(tail.into_iter().collect())
    }

    fn discard(&mut self) -> Result<(), ToolError> {
        self.offset = self.offset.max(self.logical_end()?);
        Ok(())
    }

    fn consume_records(
        &mut self,
        pane_id: &str,
        warnings: &mut Vec<TmuxWarning>,
        terminal: bool,
        max_records: Option<usize>,
        mut consume: impl FnMut(String),
    ) -> Result<(), ToolError> {
        let mut records = 0_usize;
        loop {
            if max_records.is_some_and(|limit| records >= limit) {
                return Ok(());
            }
            let segment = self.read_segment(self.offset)?;
            if segment.start > self.offset {
                self.warn_rotated(pane_id, warnings, segment.start);
                self.offset = segment.start;
            }
            if segment.bytes.is_empty() {
                if let Some(next_start) = segment.next_start {
                    if next_start > self.offset {
                        self.warn_rotated(pane_id, warnings, next_start);
                        self.offset = next_start;
                        continue;
                    }
                }
                return Ok(());
            }

            let mut position = 0_usize;
            while position < segment.bytes.len() {
                if max_records.is_some_and(|limit| records >= limit) {
                    return Ok(());
                }
                let remaining = &segment.bytes[position..];
                let newline = remaining.iter().position(|byte| *byte == b'\n');
                let count = match newline {
                    Some(index) => index + 1,
                    None if terminal || segment.next_start.is_some() => remaining.len(),
                    None => return Ok(()),
                };
                let bytes = &remaining[..count];
                self.offset = segment.start + (position + count) as u64;
                position += count;
                let (record, truncated) = render_terminal_record(bytes);
                if truncated {
                    warn_record_truncated(pane_id, warnings);
                }
                consume(record);
                records += 1;
            }

            if let Some(next_start) = segment.next_start {
                if next_start > self.offset {
                    self.warn_rotated(pane_id, warnings, next_start);
                    self.offset = next_start;
                    continue;
                }
            }
            return Ok(());
        }
    }

    fn read_segment(&self, offset: u64) -> Result<TranscriptSegment, ToolError> {
        let durable_end = match std::fs::metadata(&self.path) {
            Ok(metadata) => metadata.len().min(MAX_TRANSCRIPT_BYTES),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
            Err(error) => return Err(transcript_error(error)),
        };
        let ring = transcript_ring::snapshot(&self.ring_name).map_err(transcript_error)?;

        if offset < durable_end {
            let mut bytes = read_file_range(&self.path, offset, durable_end)?;
            let mut next_start = None;
            if let Some(ring) = ring.as_ref().filter(|ring| !ring.is_empty()) {
                if ring.base <= durable_end {
                    bytes.extend_from_slice(ring.bytes_from(durable_end));
                } else {
                    next_start = Some(ring.base);
                }
            }
            return Ok(TranscriptSegment {
                bytes,
                next_start,
                start: offset,
            });
        }

        let Some(ring) = ring.filter(|ring| !ring.is_empty()) else {
            return Ok(TranscriptSegment::empty(offset));
        };
        if offset >= ring.end {
            return Ok(TranscriptSegment::empty(offset));
        }
        let start = offset.max(ring.base);
        Ok(TranscriptSegment {
            bytes: ring.bytes_from(start).to_vec(),
            next_start: None,
            start,
        })
    }

    fn logical_end(&self) -> Result<u64, ToolError> {
        let durable_end = match std::fs::metadata(&self.path) {
            Ok(metadata) => metadata.len().min(MAX_TRANSCRIPT_BYTES),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
            Err(error) => return Err(transcript_error(error)),
        };
        let ring_end = transcript_ring::snapshot(&self.ring_name)
            .map_err(transcript_error)?
            .map_or(0, |ring| if ring.is_empty() { 0 } else { ring.end });
        Ok(durable_end.max(ring_end))
    }

    fn warn_rotated(&mut self, pane_id: &str, warnings: &mut Vec<TmuxWarning>, retained_from: u64) {
        if retained_from <= self.rotation_reported_until {
            return;
        }
        warnings.push(warning(
            Some(pane_id),
            "tmux.outputRotated",
            "earlier unread task output was evicted from the volatile 4 MiB rotating buffer; reading continues from the oldest retained output",
        ));
        self.rotation_reported_until = retained_from;
    }
}

struct TranscriptSegment {
    bytes: Vec<u8>,
    next_start: Option<u64>,
    start: u64,
}

impl TranscriptSegment {
    fn empty(offset: u64) -> Self {
        Self {
            bytes: Vec::new(),
            next_start: None,
            start: offset,
        }
    }
}

fn read_file_range(path: &PathBuf, start: u64, end: u64) -> Result<Vec<u8>, ToolError> {
    let mut file = File::open(path).map_err(transcript_error)?;
    file.seek(SeekFrom::Start(start))
        .map_err(transcript_error)?;
    let mut bytes = vec![0_u8; end.saturating_sub(start) as usize];
    file.read_exact(&mut bytes).map_err(transcript_error)?;
    Ok(bytes)
}

fn render_terminal_record(bytes: &[u8]) -> (String, bool) {
    let mut value = String::from_utf8_lossy(bytes).into_owned();
    if value.ends_with('\n') {
        value.pop();
    }
    if value.ends_with('\r') {
        value.pop();
    }
    let chars = value.chars().collect::<Vec<_>>();
    let mut output = String::new();
    let mut index = 0;
    while index < chars.len() {
        match chars[index] {
            '\x1b' => index = skip_escape_sequence(&chars, index + 1),
            '\r' => {
                output.clear();
                index += 1;
            }
            '\u{0008}' | '\u{007f}' => {
                output.pop();
                index += 1;
            }
            '\t' => {
                output.push('\t');
                index += 1;
            }
            ch if !ch.is_control() => {
                output.push(ch);
                index += 1;
            }
            _ => index += 1,
        }
    }
    let truncated = output.len() > MAX_RENDERED_RECORD_BYTES;
    if truncated {
        let mut end = MAX_RENDERED_RECORD_BYTES - '…'.len_utf8();
        while !output.is_char_boundary(end) {
            end -= 1;
        }
        output.truncate(end);
        output.push('…');
    }
    (output, truncated)
}

fn warn_record_truncated(pane_id: &str, warnings: &mut Vec<TmuxWarning>) {
    if warnings
        .iter()
        .any(|warning| warning.code == "tmux.lineTruncated")
    {
        return;
    }
    warnings.push(warning(
        Some(pane_id),
        "tmux.lineTruncated",
        "one or more terminal records exceeded 4096 rendered bytes and were truncated",
    ));
}

fn skip_escape_sequence(chars: &[char], mut index: usize) -> usize {
    if index >= chars.len() {
        return index;
    }
    match chars[index] {
        '[' => {
            index += 1;
            while index < chars.len() {
                let ch = chars[index];
                if ('@'..='~').contains(&ch) {
                    return index + 1;
                }
                index += 1;
            }
            index
        }
        ']' | 'P' | '^' | '_' => skip_string_escape(chars, index + 1),
        _ => index + 1,
    }
}

fn skip_string_escape(chars: &[char], mut index: usize) -> usize {
    while index < chars.len() {
        match chars[index] {
            '\u{0007}' => return index + 1,
            '\x1b' if index + 1 < chars.len() && chars[index + 1] == '\\' => return index + 2,
            _ => index += 1,
        }
    }
    index
}

fn transcript_error(error: std::io::Error) -> ToolError {
    ToolError::new("tmux.transcriptFailed", error.to_string())
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Write};

    use super::transcript_ring::{RingWriter, remove, snapshot};
    use super::{TranscriptCursor, drain_transcript, render_terminal_record};
    use crate::testing::temp_dir;
    use uuid::Uuid;

    fn test_ring_name() -> String {
        format!("/devshell-test-output-{}", Uuid::new_v4().simple())
    }

    #[test]
    fn terminal_record_keeps_latest_carriage_return_render() {
        assert_eq!(render_terminal_record(b"10%\r20%\r30%\n").0, "30%");
        assert_eq!(render_terminal_record(b"abc\x08d\n").0, "abd");
        assert_eq!(render_terminal_record(b"\x1b[31mred\x1b[0m\n").0, "red");
    }

    #[test]
    fn terminal_record_has_a_rendered_size_bound() {
        let (record, truncated) = render_terminal_record(&vec![b'x'; 5000]);
        assert!(truncated);
        assert!(record.len() <= 4096);
        assert!(record.ends_with('…'));
    }

    #[test]
    fn transcript_cursor_does_not_consume_partial_running_line() {
        let root = temp_dir();
        let path = root.path().join("task.log");
        let mut file = std::fs::File::create(&path).unwrap();
        write!(file, "one\ntwo").unwrap();
        drop(file);

        let ring_name = test_ring_name();
        let mut cursor = TranscriptCursor::new(path.clone(), ring_name);
        let mut warnings = Vec::new();
        assert_eq!(
            cursor
                .take_output("pane", &mut warnings, 80, false)
                .unwrap(),
            vec!["one"]
        );
        assert!(!cursor.has_output(false).unwrap());

        let mut file = std::fs::OpenOptions::new().append(true).open(path).unwrap();
        writeln!(file, " continued").unwrap();
        assert_eq!(
            cursor
                .take_output("pane", &mut warnings, 80, false)
                .unwrap(),
            vec!["two continued"]
        );
    }

    #[test]
    fn transcript_cursor_continues_from_the_oldest_retained_rotating_output() {
        let root = temp_dir();
        let path = root.path().join("task.log");
        std::fs::write(&path, b"disk\n").unwrap();
        let ring_name = test_ring_name();
        let mut ring = RingWriter::open(&ring_name, 8, 5).unwrap();
        ring.append(5, b"gone\nold\nnew\n").unwrap();

        let mut cursor = TranscriptCursor::new(path, ring_name.clone());
        let mut warnings = Vec::new();
        assert_eq!(
            cursor.take_output("pane", &mut warnings, 80, true).unwrap(),
            vec!["disk", "old", "new"]
        );
        assert_eq!(warnings.len(), 1);
        assert_eq!(warnings[0].code, "tmux.outputRotated");
        remove(&ring_name).unwrap();
    }

    #[test]
    fn transcript_logger_keeps_accepting_output_in_the_rotating_buffer() {
        let source = vec![b'x'; 16 * 1024];
        let mut input = Cursor::new(source.clone());
        let mut output = Vec::new();
        let ring_name = test_ring_name();
        let mut ring = RingWriter::open(&ring_name, 4096, 4096).unwrap();
        drain_transcript(&mut input, &mut output, &mut ring, 4096).unwrap();
        assert_eq!(input.position(), source.len() as u64);
        assert_eq!(output, source[..4096]);
        let snapshot = snapshot(&ring_name).unwrap().unwrap();
        assert_eq!(snapshot.end, source.len() as u64);
        assert_eq!(snapshot.end - snapshot.base, 4096);
        assert_eq!(
            snapshot.bytes_from(snapshot.base),
            &source[source.len() - 4096..]
        );
        remove(&ring_name).unwrap();
    }
}
