use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;

use crate::platform::unix_time_millis;
use crate::tools::ToolError;

pub const FULL_SNAPSHOT_LIMIT: usize = 4 * 1024 * 1024;

#[derive(Clone)]
pub struct TextFile {
    pub bom: bool,
    pub final_newline: bool,
    pub line_ending: &'static str,
    pub lines: Vec<String>,
    pub revision: String,
    pub total_bytes: usize,
}

#[derive(Clone, Debug)]
pub struct TextMetadata {
    pub revision: String,
    pub total_bytes: usize,
    pub total_lines: usize,
}

#[derive(Debug)]
pub struct SelectedLines {
    pub lines: Vec<(usize, String)>,
    pub next_line: Option<usize>,
    pub metadata: TextMetadata,
}

#[derive(Clone, Debug)]
pub enum SnapshotContent {
    Full(String),
    Sparse,
}

#[derive(Clone, Debug)]
pub struct ContextFileSnapshot {
    pub canonical_path: String,
    pub revision: String,
    pub seen_lines: BTreeSet<usize>,
    pub total_lines: usize,
    pub content: SnapshotContent,
    pub ordinal: u64,
    pub last_accessed_at_ms: u128,
}

#[derive(Default)]
pub struct ContextSnapshotStore {
    latest: HashMap<(String, String), ContextFileSnapshot>,
}

impl ContextSnapshotStore {
    pub fn remember_full(
        &mut self,
        ctx_id: &str,
        path: &Path,
        text: &TextFile,
        seen_lines: impl IntoIterator<Item = usize>,
        ordinal: u64,
    ) {
        self.remember(
            ctx_id,
            path,
            text.revision.clone(),
            text.lines.len(),
            SnapshotContent::Full(text.normalized()),
            seen_lines,
            ordinal,
        );
    }

    pub fn remember_sparse(
        &mut self,
        ctx_id: &str,
        path: &Path,
        metadata: &TextMetadata,
        seen_lines: impl IntoIterator<Item = usize>,
        ordinal: u64,
    ) {
        self.remember(
            ctx_id,
            path,
            metadata.revision.clone(),
            metadata.total_lines,
            SnapshotContent::Sparse,
            seen_lines,
            ordinal,
        );
    }

    #[allow(clippy::too_many_arguments)]
    fn remember(
        &mut self,
        ctx_id: &str,
        path: &Path,
        revision: String,
        total_lines: usize,
        content: SnapshotContent,
        seen_lines: impl IntoIterator<Item = usize>,
        ordinal: u64,
    ) {
        let canonical_path = path.display().to_string();
        let key = (ctx_id.to_string(), canonical_path.clone());
        let seen_lines = seen_lines.into_iter().collect::<BTreeSet<_>>();
        let now = unix_time_millis();

        if let Some(current) = self.latest.get_mut(&key) {
            if current.revision == revision {
                current.seen_lines.extend(seen_lines);
                current.last_accessed_at_ms = now;
                if ordinal >= current.ordinal {
                    current.ordinal = ordinal;
                    current.total_lines = total_lines;
                    current.content = content;
                }
                return;
            }
            if ordinal < current.ordinal {
                return;
            }
        }

        self.latest.insert(
            key,
            ContextFileSnapshot {
                canonical_path,
                revision,
                seen_lines,
                total_lines,
                content,
                ordinal,
                last_accessed_at_ms: now,
            },
        );
        self.evict();
    }

    pub fn latest_for_path(
        &mut self,
        ctx_id: &str,
        path: &Path,
    ) -> Result<ContextFileSnapshot, ToolError> {
        let key = (ctx_id.to_string(), path.display().to_string());
        let snapshot = self.latest.get_mut(&key).ok_or_else(|| {
            ToolError::retryable(
                "file.snapshotRequired",
                "file must be read or searched in this context before editing",
            )
            .with_details(serde_json::json!({ "path": path.display().to_string() }))
        })?;
        snapshot.last_accessed_at_ms = unix_time_millis();
        Ok(snapshot.clone())
    }

    pub fn migrate_path(&mut self, ctx_id: &str, source: &Path, target: &Path) {
        let source_key = (ctx_id.to_string(), source.display().to_string());
        let target_key = (ctx_id.to_string(), target.display().to_string());
        self.latest.remove(&target_key);
        if let Some(mut snapshot) = self.latest.remove(&source_key) {
            snapshot.canonical_path = target.display().to_string();
            snapshot.last_accessed_at_ms = unix_time_millis();
            self.latest.insert(target_key, snapshot);
        }
    }

    pub fn remove_path(&mut self, ctx_id: &str, path: &Path) {
        self.latest
            .remove(&(ctx_id.to_string(), path.display().to_string()));
    }

    fn evict(&mut self) {
        const MAX_CONTEXT_SNAPSHOTS: usize = 512;
        while self.latest.len() > MAX_CONTEXT_SNAPSHOTS {
            let Some(oldest) = self
                .latest
                .iter()
                .min_by_key(|(_, snapshot)| snapshot.last_accessed_at_ms)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            self.latest.remove(&oldest);
        }
    }
}

impl TextMetadata {
    pub fn inspect(path: &Path) -> Result<Self, ToolError> {
        let file = fs::File::open(path).map_err(|error| {
            ToolError::new(
                "file.notFound",
                format!("failed to read {}: {error}", path.display()),
            )
        })?;
        let mut reader = BufReader::new(file);
        let mut hasher = blake3::Hasher::new();
        let mut buffer = Vec::new();
        let mut total_bytes = 0usize;
        let mut total_lines = 0usize;
        let mut first = true;
        loop {
            buffer.clear();
            let count = reader
                .read_until(b'\n', &mut buffer)
                .map_err(|error| ToolError::new("file.readFailed", error.to_string()))?;
            if count == 0 {
                break;
            }
            hasher.update(&buffer);
            total_bytes += count;
            if buffer.contains(&0) {
                return Err(ToolError::new("file.notText", "file contains NUL bytes"));
            }
            let had_newline = buffer.last() == Some(&b'\n');
            let mut content = buffer.as_slice();
            if first && content.starts_with(&[0xEF, 0xBB, 0xBF]) {
                content = &content[3..];
            }
            first = false;
            let without_lf = content.strip_suffix(b"\n").unwrap_or(content);
            let without_eol = without_lf.strip_suffix(b"\r").unwrap_or(without_lf);
            std::str::from_utf8(without_eol)
                .map_err(|_| ToolError::new("file.notText", "file is not valid UTF-8"))?;
            if had_newline || !without_eol.is_empty() {
                total_lines += 1;
            }
        }
        Ok(Self {
            revision: hasher.finalize().to_hex().to_string(),
            total_bytes,
            total_lines,
        })
    }

    pub fn read_selected(
        path: &Path,
        ranges: &[(usize, usize)],
        max_rendered_bytes: usize,
    ) -> Result<SelectedLines, ToolError> {
        let file = fs::File::open(path).map_err(|error| {
            ToolError::new(
                "file.notFound",
                format!("failed to read {}: {error}", path.display()),
            )
        })?;
        let mut reader = BufReader::new(file);
        let mut hasher = blake3::Hasher::new();
        let mut buffer = Vec::new();
        let mut line_no = 0usize;
        let mut range_index = 0usize;
        let mut rendered_bytes = 0usize;
        let mut lines = Vec::new();
        let mut next_line = None;
        let mut total_bytes = 0usize;
        let mut total_lines = 0usize;
        let mut first = true;
        loop {
            buffer.clear();
            let count = reader
                .read_until(b'\n', &mut buffer)
                .map_err(|error| ToolError::new("file.readFailed", error.to_string()))?;
            if count == 0 {
                break;
            }
            hasher.update(&buffer);
            total_bytes += count;
            if buffer.contains(&0) {
                return Err(ToolError::new("file.notText", "file contains NUL bytes"));
            }
            line_no += 1;
            let had_newline = buffer.last() == Some(&b'\n');
            let mut content = buffer.as_slice();
            if first && content.starts_with(&[0xEF, 0xBB, 0xBF]) {
                content = &content[3..];
            }
            first = false;
            let without_lf = content.strip_suffix(b"\n").unwrap_or(content);
            let without_eol = without_lf.strip_suffix(b"\r").unwrap_or(without_lf);
            let text = std::str::from_utf8(without_eol)
                .map_err(|_| ToolError::new("file.notText", "file is not valid UTF-8"))?;
            if had_newline || !without_eol.is_empty() {
                total_lines += 1;
            }

            while range_index < ranges.len() && line_no > ranges[range_index].1 {
                range_index += 1;
            }
            if next_line.is_some() || range_index >= ranges.len() {
                continue;
            }
            let (start, end) = ranges[range_index];
            if line_no < start || line_no > end {
                continue;
            }
            let line_bytes =
                line_no.to_string().len() + 1 + text.len() + usize::from(!lines.is_empty());
            if rendered_bytes + line_bytes > max_rendered_bytes {
                if lines.is_empty() {
                    return Err(ToolError::new(
                        "file.lineTooLarge",
                        "one selected line exceeds the file_read output byte limit",
                    ));
                }
                next_line = Some(line_no);
                continue;
            }
            rendered_bytes += line_bytes;
            lines.push((line_no, text.to_string()));
        }
        Ok(SelectedLines {
            lines,
            next_line,
            metadata: TextMetadata {
                revision: hasher.finalize().to_hex().to_string(),
                total_bytes,
                total_lines,
            },
        })
    }
}

impl TextFile {
    pub fn read(path: &Path) -> Result<Self, ToolError> {
        let bytes = fs::read(path).map_err(|error| {
            ToolError::new(
                "file.notFound",
                format!("failed to read {}: {error}", path.display()),
            )
        })?;
        if bytes.contains(&0) {
            return Err(ToolError::new("file.notText", "file contains NUL bytes"));
        }
        let revision = blake3::hash(&bytes).to_hex().to_string();
        let bom = bytes.starts_with(&[0xEF, 0xBB, 0xBF]);
        let content = std::str::from_utf8(if bom { &bytes[3..] } else { &bytes })
            .map_err(|_| ToolError::new("file.notText", "file is not valid UTF-8"))?;
        let line_ending = content
            .find('\n')
            .map(|index| {
                if index > 0 && content.as_bytes()[index - 1] == b'\r' {
                    "\r\n"
                } else {
                    "\n"
                }
            })
            .unwrap_or("\n");
        let final_newline = content.ends_with('\n') || content.ends_with('\r');
        let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
        let body = normalized.strip_suffix('\n').unwrap_or(&normalized);
        let lines = if normalized.is_empty() {
            Vec::new()
        } else {
            body.split('\n').map(ToOwned::to_owned).collect()
        };
        Ok(Self {
            bom,
            final_newline,
            line_ending,
            lines,
            revision,
            total_bytes: bytes.len(),
        })
    }

    pub fn from_normalized(source: &TextFile, normalized: &str) -> Result<Self, ToolError> {
        if normalized.contains('\0') {
            return Err(ToolError::new(
                "file.notText",
                "content cannot contain NUL bytes",
            ));
        }
        let final_newline = normalized.ends_with('\n');
        let body = normalized.strip_suffix('\n').unwrap_or(normalized);
        let lines = if normalized.is_empty() {
            Vec::new()
        } else {
            body.split('\n').map(ToOwned::to_owned).collect()
        };
        let mut text = Self {
            bom: source.bom,
            final_newline,
            line_ending: source.line_ending,
            lines,
            revision: String::new(),
            total_bytes: 0,
        };
        let encoded = text.encoded();
        text.revision = blake3::hash(&encoded).to_hex().to_string();
        text.total_bytes = encoded.len();
        Ok(text)
    }

    pub fn normalized(&self) -> String {
        let mut result = self.lines.join("\n");
        if self.final_newline && !self.lines.is_empty() {
            result.push('\n');
        }
        result
    }

    pub fn encoded(&self) -> Vec<u8> {
        let mut text = self.normalized();
        if self.line_ending == "\r\n" {
            text = text.replace('\n', "\r\n");
        }
        let mut result = if self.bom {
            vec![0xEF, 0xBB, 0xBF]
        } else {
            Vec::new()
        };
        result.extend_from_slice(text.as_bytes());
        result
    }
}
#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{ContextSnapshotStore, TextFile};

    fn text(revision: &str, line: String) -> TextFile {
        TextFile {
            bom: false,
            final_newline: false,
            line_ending: "\n",
            lines: vec![line],
            revision: revision.to_string(),
            total_bytes: 0,
        }
    }

    #[test]
    fn context_snapshot_store_uses_ordinals_and_isolates_contexts() {
        let mut store = ContextSnapshotStore::default();
        let path = Path::new("/workspace/document.txt");
        let newer = text("newer", "newer content".to_string());
        let older = text("older", "older content".to_string());

        store.remember_full("ctx-a", path, &newer, [1], 2);
        store.remember_full("ctx-a", path, &older, [1], 1);
        store.remember_full("ctx-b", path, &older, [1], 3);

        assert_eq!(
            store.latest_for_path("ctx-a", path).unwrap().revision,
            "newer"
        );
        assert_eq!(
            store.latest_for_path("ctx-b", path).unwrap().revision,
            "older"
        );
    }
}
