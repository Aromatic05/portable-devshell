use std::collections::{BTreeSet, HashMap, VecDeque};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use uuid::Uuid;

use crate::tools::ToolError;

pub const FULL_SNAPSHOT_LIMIT: usize = 4 * 1024 * 1024;
const MAX_SNAPSHOTS: usize = 64;
const MAX_FULL_TEXT: usize = 64 * 1024 * 1024;

#[derive(Clone)]
pub struct TextFile {
    pub bom: bool,
    pub final_newline: bool,
    pub line_ending: &'static str,
    pub lines: Vec<String>,
    pub revision: String,
    pub total_bytes: usize,
}

#[derive(Clone)]
pub struct TextMetadata {
    pub bom: bool,
    pub final_newline: bool,
    pub line_ending: &'static str,
    pub revision: String,
    pub total_bytes: usize,
    pub total_lines: usize,
}

#[derive(Clone)]
pub struct FileSnapshot {
    pub id: String,
    pub canonical_path: String,
    pub revision: String,
    pub seen_lines: BTreeSet<usize>,
    pub total_lines: usize,
    pub total_bytes: usize,
    pub bom: bool,
    pub line_ending: &'static str,
    pub final_newline: bool,
    pub full_text: Option<String>,
    pub created_at_ms: u128,
    pub last_accessed_at_ms: u128,
}

#[derive(Default)]
pub struct SnapshotStore {
    snapshots: HashMap<String, FileSnapshot>,
    by_content: HashMap<(String, String), String>,
    lru: VecDeque<String>,
    full_text_bytes: usize,
}

impl SnapshotStore {
    pub fn remember(
        &mut self,
        path: &Path,
        text: &TextFile,
        seen_lines: impl IntoIterator<Item = usize>,
    ) -> String {
        let key = (path.display().to_string(), text.revision.clone());
        let now = now_ms();
        if let Some(id) = self.by_content.get(&key).cloned() {
            if let Some(snapshot) = self.snapshots.get_mut(&id) {
                snapshot.seen_lines.extend(seen_lines);
                snapshot.last_accessed_at_ms = now;
            }
            self.touch(&id);
            return id;
        }
        let normalized = text.normalized();
        let full_text = if normalized.len() <= FULL_SNAPSHOT_LIMIT {
            Some(normalized)
        } else {
            None
        };
        let id = Uuid::new_v4().to_string();
        if let Some(content) = &full_text {
            self.full_text_bytes += content.len();
        }
        self.snapshots.insert(
            id.clone(),
            FileSnapshot {
                id: id.clone(),
                canonical_path: key.0.clone(),
                revision: key.1.clone(),
                seen_lines: seen_lines.into_iter().collect(),
                total_lines: text.lines.len(),
                total_bytes: text.total_bytes,
                bom: text.bom,
                line_ending: text.line_ending,
                final_newline: text.final_newline,
                full_text,
                created_at_ms: now,
                last_accessed_at_ms: now,
            },
        );
        self.by_content.insert(key, id.clone());
        self.lru.push_back(id.clone());
        self.evict();
        id
    }

    pub fn remember_sparse(
        &mut self,
        path: &Path,
        metadata: &TextMetadata,
        seen_lines: impl IntoIterator<Item = usize>,
    ) -> String {
        let key = (path.display().to_string(), metadata.revision.clone());
        let now = now_ms();
        if let Some(id) = self.by_content.get(&key).cloned() {
            if let Some(snapshot) = self.snapshots.get_mut(&id) {
                snapshot.seen_lines.extend(seen_lines);
                snapshot.last_accessed_at_ms = now;
            }
            self.touch(&id);
            return id;
        }

        let id = Uuid::new_v4().to_string();
        self.snapshots.insert(
            id.clone(),
            FileSnapshot {
                id: id.clone(),
                canonical_path: key.0.clone(),
                revision: key.1.clone(),
                seen_lines: seen_lines.into_iter().collect(),
                total_lines: metadata.total_lines,
                total_bytes: metadata.total_bytes,
                bom: metadata.bom,
                line_ending: metadata.line_ending,
                final_newline: metadata.final_newline,
                full_text: None,
                created_at_ms: now,
                last_accessed_at_ms: now,
            },
        );
        self.by_content.insert(key, id.clone());
        self.lru.push_back(id.clone());
        self.evict();
        id
    }

    pub fn get(&mut self, id: &str) -> Result<FileSnapshot, ToolError> {
        let snapshot = self.snapshots.get_mut(id).ok_or_else(|| {
            ToolError::retryable("file.snapshotNotFound", "snapshot is no longer available")
        })?;
        snapshot.last_accessed_at_ms = now_ms();
        let snapshot = snapshot.clone();
        self.touch(id);
        Ok(snapshot)
    }

    fn touch(&mut self, id: &str) {
        self.lru.retain(|entry| entry != id);
        self.lru.push_back(id.to_string());
    }
    fn evict(&mut self) {
        while self.snapshots.len() > MAX_SNAPSHOTS || self.full_text_bytes > MAX_FULL_TEXT {
            let Some(id) = self.lru.pop_front() else {
                break;
            };
            if let Some(snapshot) = self.snapshots.remove(&id) {
                self.by_content
                    .remove(&(snapshot.canonical_path, snapshot.revision));
                self.full_text_bytes = self
                    .full_text_bytes
                    .saturating_sub(snapshot.full_text.map_or(0, |text| text.len()));
            }
        }
    }
}

impl TextFile {
    pub fn inspect(path: &Path) -> Result<TextMetadata, ToolError> {
        let file = fs::File::open(path).map_err(|error| {
            ToolError::new(
                "file.notFound",
                format!("failed to read {}: {error}", path.display()),
            )
        })?;
        let mut reader = BufReader::new(file);
        let mut hasher = blake3::Hasher::new();
        let mut buffer = Vec::new();
        let mut first = true;
        let mut bom = false;
        let mut final_newline = false;
        let mut line_ending = "\n";
        let mut total_bytes = 0;
        let mut total_lines = 0;

        loop {
            buffer.clear();
            let count = reader
                .read_until(b'\n', &mut buffer)
                .map_err(|error| ToolError::new("file.writeFailed", error.to_string()))?;
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
                bom = true;
                content = &content[3..];
            }
            first = false;
            let content = content.strip_suffix(b"\n").unwrap_or(content);
            let content = content.strip_suffix(b"\r").unwrap_or(content);
            std::str::from_utf8(content)
                .map_err(|_| ToolError::new("file.notText", "file is not valid UTF-8"))?;
            if had_newline || !content.is_empty() {
                total_lines += 1;
            }
            if had_newline && total_lines == 1 {
                line_ending = if buffer.get(buffer.len().saturating_sub(2)) == Some(&b'\r') {
                    "\r\n"
                } else {
                    "\n"
                };
            }
            final_newline = had_newline;
        }
        Ok(TextMetadata {
            bom,
            final_newline,
            line_ending,
            revision: hasher.finalize().to_hex().to_string(),
            total_bytes,
            total_lines,
        })
    }

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

pub fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
