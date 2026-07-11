use std::collections::{BTreeSet, HashMap, VecDeque};
use std::fs;
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

#[derive(Clone)]
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
        if let Some(id) = self.by_content.get(&key).cloned() {
            if let Some(snapshot) = self.snapshots.get_mut(&id) {
                snapshot.seen_lines.extend(seen_lines);
                snapshot.last_accessed_at_ms = now;
                let reference = SnapshotReference {
                    id: snapshot.id.clone(),
                    tag: snapshot.tag.clone(),
                };
                self.touch(&id);
                return reference;
            }
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

    use super::{FULL_SNAPSHOT_LIMIT, SnapshotContent, SnapshotStore, TextFile};

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
