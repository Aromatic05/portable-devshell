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
const SNAPSHOT_TAG_HEX_LENGTH: usize = 8;

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
    pub bom: bool,
    pub final_newline: bool,
    pub line_ending: &'static str,
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

#[derive(Clone)]
pub struct FileSnapshot {
    pub id: String,
    pub tag: String,
    pub canonical_path: String,
    pub revision: String,
    pub seen_lines: BTreeSet<usize>,
    pub total_lines: usize,
    pub content: SnapshotContent,
    pub last_accessed_at_ms: u128,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SnapshotReference {
    pub id: String,
    pub tag: String,
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
        let now = now_ms();

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
        snapshot.last_accessed_at_ms = now_ms();
        Ok(snapshot.clone())
    }

    pub fn migrate_path(&mut self, ctx_id: &str, source: &Path, target: &Path) {
        let source_key = (ctx_id.to_string(), source.display().to_string());
        let target_key = (ctx_id.to_string(), target.display().to_string());
        self.latest.remove(&target_key);
        if let Some(mut snapshot) = self.latest.remove(&source_key) {
            snapshot.canonical_path = target.display().to_string();
            snapshot.last_accessed_at_ms = now_ms();
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

#[derive(Default)]
pub struct SnapshotStore {
    snapshots: HashMap<String, FileSnapshot>,
    by_content: HashMap<(String, String), String>,
    by_tag: HashMap<String, String>,
    lru: VecDeque<String>,
    full_text_bytes: usize,
}

impl SnapshotStore {
    pub fn remember(
        &mut self,
        path: &Path,
        text: &TextFile,
        seen_lines: impl IntoIterator<Item = usize>,
    ) -> SnapshotReference {
        let key = (path.display().to_string(), text.revision.clone());
        let now = now_ms();
        if let Some(id) = self.by_content.get(&key).cloned()
            && let Some(snapshot) = self.snapshots.get_mut(&id)
        {
            snapshot.seen_lines.extend(seen_lines);
            snapshot.last_accessed_at_ms = now;
            let reference = SnapshotReference {
                id: snapshot.id.clone(),
                tag: snapshot.tag.clone(),
            };
            self.touch(&id);
            return reference;
        }

        let normalized = text.normalized();
        let content = if normalized.len() <= FULL_SNAPSHOT_LIMIT {
            SnapshotContent::Full(normalized)
        } else {
            SnapshotContent::Sparse
        };
        let (id, tag) = self.new_identity();
        if let SnapshotContent::Full(text) = &content {
            self.full_text_bytes += text.len();
        }
        self.snapshots.insert(
            id.clone(),
            FileSnapshot {
                id: id.clone(),
                tag: tag.clone(),
                canonical_path: key.0.clone(),
                revision: key.1.clone(),
                seen_lines: seen_lines.into_iter().collect(),
                total_lines: text.lines.len(),
                content,
                last_accessed_at_ms: now,
            },
        );
        self.by_content.insert(key, id.clone());
        self.by_tag.insert(tag.clone(), id.clone());
        self.lru.push_back(id.clone());
        self.evict();
        SnapshotReference { id, tag }
    }

    pub fn remember_sparse(
        &mut self,
        path: &Path,
        metadata: &TextMetadata,
        seen_lines: impl IntoIterator<Item = usize>,
    ) -> SnapshotReference {
        let key = (path.display().to_string(), metadata.revision.clone());
        let now = now_ms();
        if let Some(id) = self.by_content.get(&key).cloned()
            && let Some(snapshot) = self.snapshots.get_mut(&id)
        {
            snapshot.seen_lines.extend(seen_lines);
            snapshot.last_accessed_at_ms = now;
            let reference = SnapshotReference {
                id: snapshot.id.clone(),
                tag: snapshot.tag.clone(),
            };
            self.touch(&id);
            return reference;
        }
        let (id, tag) = self.new_identity();
        self.snapshots.insert(
            id.clone(),
            FileSnapshot {
                id: id.clone(),
                tag: tag.clone(),
                canonical_path: key.0.clone(),
                revision: key.1.clone(),
                seen_lines: seen_lines.into_iter().collect(),
                total_lines: metadata.total_lines,
                content: SnapshotContent::Sparse,
                last_accessed_at_ms: now,
            },
        );
        self.by_content.insert(key, id.clone());
        self.by_tag.insert(tag.clone(), id.clone());
        self.lru.push_back(id.clone());
        self.evict();
        SnapshotReference { id, tag }
    }

    pub fn get(&mut self, reference: &str) -> Result<FileSnapshot, ToolError> {
        let id = self.resolve_id(reference)?;
        let snapshot = self.snapshots.get_mut(&id).ok_or_else(snapshot_not_found)?;
        snapshot.last_accessed_at_ms = now_ms();
        let snapshot = snapshot.clone();
        self.touch(&id);
        Ok(snapshot)
    }

    pub fn latest_for_path(&mut self, path: &Path) -> Result<FileSnapshot, ToolError> {
        let canonical_path = path.display().to_string();
        let id = self
            .lru
            .iter()
            .rev()
            .find(|id| {
                self.snapshots
                    .get(*id)
                    .is_some_and(|snapshot| snapshot.canonical_path == canonical_path)
            })
            .cloned()
            .ok_or_else(|| {
                ToolError::retryable(
                    "file.snapshotRequired",
                    "file must be read or searched before editing",
                )
            })?;
        self.get(&id)
    }

    pub fn migrate_path(&mut self, source: &Path, target: &Path) {
        let source = source.display().to_string();
        let target = target.display().to_string();
        self.remove_path_by_name(&target);

        let ids = self
            .snapshots
            .iter()
            .filter_map(|(id, snapshot)| (snapshot.canonical_path == source).then_some(id.clone()))
            .collect::<Vec<_>>();
        for id in ids {
            let Some(snapshot) = self.snapshots.get_mut(&id) else {
                continue;
            };
            self.by_content
                .remove(&(snapshot.canonical_path.clone(), snapshot.revision.clone()));
            snapshot.canonical_path = target.clone();
            self.by_content
                .insert((target.clone(), snapshot.revision.clone()), id);
        }
    }

    pub fn remove_path(&mut self, path: &Path) {
        self.remove_path_by_name(&path.display().to_string());
    }

    fn resolve_id(&self, reference: &str) -> Result<String, ToolError> {
        if self.snapshots.contains_key(reference) {
            return Ok(reference.to_string());
        }
        let normalized_id = reference.to_ascii_lowercase();
        if self.snapshots.contains_key(&normalized_id) {
            return Ok(normalized_id);
        }
        self.by_tag
            .get(&reference.to_ascii_uppercase())
            .cloned()
            .ok_or_else(snapshot_not_found)
    }

    fn remove_path_by_name(&mut self, path: &str) {
        let ids = self
            .snapshots
            .iter()
            .filter_map(|(id, snapshot)| (snapshot.canonical_path == path).then_some(id.clone()))
            .collect::<Vec<_>>();
        for id in ids {
            self.remove_snapshot(&id);
        }
    }

    fn new_identity(&self) -> (String, String) {
        loop {
            let id = Uuid::new_v4().to_string();
            let tag = id
                .chars()
                .filter(|character| *character != '-')
                .take(SNAPSHOT_TAG_HEX_LENGTH)
                .collect::<String>()
                .to_ascii_uppercase();
            if !self.by_tag.contains_key(&tag) {
                return (id, tag);
            }
        }
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
            self.remove_snapshot(&id);
        }
    }

    fn remove_snapshot(&mut self, id: &str) {
        self.lru.retain(|entry| entry != id);
        if let Some(snapshot) = self.snapshots.remove(id) {
            self.by_content
                .remove(&(snapshot.canonical_path, snapshot.revision));
            self.by_tag.remove(&snapshot.tag);
            let bytes = match snapshot.content {
                SnapshotContent::Full(text) => text.len(),
                SnapshotContent::Sparse => 0,
            };
            self.full_text_bytes = self.full_text_bytes.saturating_sub(bytes);
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
        let mut bom = false;
        let mut first = true;
        let mut final_newline = false;
        let mut line_ending = "\n";
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
                bom = true;
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
            if had_newline && total_lines == 1 {
                line_ending = if without_lf.len() != without_eol.len() {
                    "\r\n"
                } else {
                    "\n"
                };
            }
            final_newline = had_newline;
        }
        Ok(Self {
            bom,
            final_newline,
            line_ending,
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
        let mut bom = false;
        let mut first = true;
        let mut final_newline = false;
        let mut line_ending = "\n";
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
                bom = true;
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
            if had_newline && total_lines == 1 {
                line_ending = if without_lf.len() != without_eol.len() {
                    "\r\n"
                } else {
                    "\n"
                };
            }
            final_newline = had_newline;

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
                bom,
                final_newline,
                line_ending,
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

pub fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn snapshot_not_found() -> ToolError {
    ToolError::retryable("file.snapshotNotFound", "snapshot is no longer available")
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{
        ContextSnapshotStore, FULL_SNAPSHOT_LIMIT, SnapshotContent, SnapshotStore, TextFile,
    };

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

    #[test]
    fn snapshot_store_reuses_seen_lines_and_uses_sparse_storage_for_large_text() {
        let mut store = SnapshotStore::default();
        let path = Path::new("/workspace/document.txt");
        let small = text("small", "content".to_string());
        let reference = store.remember(path, &small, [1]);
        assert_eq!(store.remember(path, &small, [2]), reference);
        assert!(store.get(&reference.tag).unwrap().seen_lines.contains(&2));

        let large = text("large", "x".repeat(FULL_SNAPSHOT_LIMIT + 1));
        let large_reference = store.remember(Path::new("/workspace/large.txt"), &large, [1]);
        assert!(matches!(
            store.get(&large_reference.id).unwrap().content,
            SnapshotContent::Sparse
        ));
    }
}
