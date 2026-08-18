use std::collections::VecDeque;
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::PathBuf;

use super::warning;

use crate::tools::ToolError;
use crate::tools::tmux::types::TmuxWarning;

#[derive(Debug, Clone)]
pub struct TranscriptCursor {
    pub path: PathBuf,
    offset: u64,
}

impl TranscriptCursor {
    pub fn new(path: PathBuf) -> Self {
        Self { path, offset: 0 }
    }

    pub fn has_output(&self, terminal: bool) -> Result<bool, ToolError> {
        let Some(mut reader) = self.reader()? else {
            return Ok(false);
        };
        let mut bytes = Vec::new();
        let count = reader
            .read_until(b'\n', &mut bytes)
            .map_err(transcript_error)?;
        Ok(count > 0 && (terminal || bytes.ends_with(b"\n")))
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
            return self.take_oldest(line as usize, terminal);
        }
        self.take_tail(line.unsigned_abs() as usize, pane_id, warnings, terminal)
    }

    fn take_oldest(&mut self, limit: usize, terminal: bool) -> Result<Vec<String>, ToolError> {
        let Some(mut reader) = self.reader()? else {
            return Ok(Vec::new());
        };
        let mut output = Vec::new();
        let mut committed = self.offset;
        while output.len() < limit {
            let mut bytes = Vec::new();
            let count = reader
                .read_until(b'\n', &mut bytes)
                .map_err(transcript_error)?;
            if count == 0 {
                break;
            }
            let complete = bytes.ends_with(b"\n");
            if !complete && !terminal {
                break;
            }
            committed += count as u64;
            output.push(render_terminal_record(&bytes));
        }
        self.offset = committed;
        Ok(output)
    }

    fn take_tail(
        &mut self,
        limit: usize,
        pane_id: &str,
        warnings: &mut Vec<TmuxWarning>,
        terminal: bool,
    ) -> Result<Vec<String>, ToolError> {
        let Some(mut reader) = self.reader()? else {
            return Ok(Vec::new());
        };
        let mut tail = VecDeque::with_capacity(limit);
        let mut committed = self.offset;
        let mut skipped = false;
        loop {
            let mut bytes = Vec::new();
            let count = reader
                .read_until(b'\n', &mut bytes)
                .map_err(transcript_error)?;
            if count == 0 {
                break;
            }
            let complete = bytes.ends_with(b"\n");
            if !complete && !terminal {
                break;
            }
            committed += count as u64;
            if limit == 0 {
                skipped = true;
                continue;
            }
            if tail.len() == limit {
                tail.pop_front();
                skipped = true;
            }
            tail.push_back(render_terminal_record(&bytes));
        }
        self.offset = committed;
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
        match std::fs::metadata(&self.path) {
            Ok(metadata) => {
                self.offset = metadata.len();
                Ok(())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(transcript_error(error)),
        }
    }

    fn reader(&self) -> Result<Option<BufReader<File>>, ToolError> {
        let file = match File::open(&self.path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(transcript_error(error)),
        };
        let mut reader = BufReader::new(file);
        reader
            .seek(SeekFrom::Start(self.offset))
            .map_err(transcript_error)?;
        Ok(Some(reader))
    }
}

fn render_terminal_record(bytes: &[u8]) -> String {
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
    output
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
    use std::io::Write;

    use super::{TranscriptCursor, render_terminal_record};
    use crate::testing::temp_dir;

    #[test]
    fn terminal_record_keeps_latest_carriage_return_render() {
        assert_eq!(render_terminal_record(b"10%\r20%\r30%\n"), "30%");
        assert_eq!(render_terminal_record(b"abc\x08d\n"), "abd");
        assert_eq!(render_terminal_record(b"\x1b[31mred\x1b[0m\n"), "red");
    }

    #[test]
    fn transcript_cursor_does_not_consume_partial_running_line() {
        let root = temp_dir();
        let path = root.path().join("task.log");
        let mut file = std::fs::File::create(&path).unwrap();
        write!(file, "one\ntwo").unwrap();
        drop(file);

        let mut cursor = TranscriptCursor::new(path.clone());
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
}
