use std::num::NonZeroUsize;

use lru::LruCache;
use uuid::Uuid;

use crate::tools::ToolError;

const MAX_CURSORS: usize = 256;

struct Cursor {
    offset: usize,
    query: String,
}

pub struct CursorStore {
    cursors: LruCache<String, Cursor>,
}

impl Default for CursorStore {
    fn default() -> Self {
        Self {
            cursors: LruCache::new(NonZeroUsize::new(MAX_CURSORS).unwrap()),
        }
    }
}

impl CursorStore {
    pub fn issue(&mut self, query: &serde_json::Value, offset: usize) -> String {
        let id = Uuid::new_v4().to_string();
        self.cursors.put(
            id.clone(),
            Cursor {
                offset,
                query: query.to_string(),
            },
        );
        id
    }

    pub fn resolve(&mut self, id: &str, query: &serde_json::Value) -> Result<usize, ToolError> {
        let cursor = self
            .cursors
            .get(id)
            .ok_or_else(|| ToolError::new("file.invalidCursor", "cursor is not available"))?;
        if cursor.query != query.to_string() {
            return Err(ToolError::new(
                "file.invalidCursor",
                "cursor does not match this query",
            ));
        }
        Ok(cursor.offset)
    }
}
