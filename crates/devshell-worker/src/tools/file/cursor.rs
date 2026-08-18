use std::num::NonZeroUsize;

use lru::LruCache;
use uuid::Uuid;

use crate::tools::ToolError;

const MAX_CURSORS: usize = 128;

#[derive(Clone)]
struct Cursor<T> {
    state: T,
    query: serde_json::Value,
}

pub struct CursorStore<T> {
    cursors: LruCache<String, Cursor<T>>,
}

impl<T> Default for CursorStore<T> {
    fn default() -> Self {
        Self {
            cursors: LruCache::new(NonZeroUsize::new(MAX_CURSORS).unwrap()),
        }
    }
}

impl<T: Clone> CursorStore<T> {
    pub fn issue(&mut self, query: &serde_json::Value, state: T) -> String {
        let id = Uuid::new_v4().to_string();
        self.cursors.put(
            id.clone(),
            Cursor {
                state,
                query: query.clone(),
            },
        );
        id
    }

    pub fn resolve(&mut self, id: &str, query: &serde_json::Value) -> Result<T, ToolError> {
        let cursor = self
            .cursors
            .get(id)
            .ok_or_else(|| ToolError::new("file.invalidCursor", "cursor is not available"))?;
        if cursor.query != *query {
            return Err(ToolError::new(
                "file.invalidCursor",
                "cursor does not match this query",
            ));
        }
        Ok(cursor.state.clone())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::CursorStore;

    #[test]
    fn resolves_cursor_for_the_same_query() {
        let mut store = CursorStore::default();
        let query = json!({
            "pattern": "needle",
            "paths": ["./a.txt"],
            "caseSensitive": true
        });
        let cursor = store.issue(&query, 20usize);

        assert_eq!(store.resolve(&cursor, &query).unwrap(), 20);
    }

    #[test]
    fn rejects_cursor_for_a_different_query() {
        let mut store = CursorStore::default();
        let cursor = store.issue(&json!({ "pattern": "needle" }), 20usize);
        let error = store
            .resolve(&cursor, &json!({ "pattern": "different" }))
            .unwrap_err();

        assert_eq!(error.code, "file.invalidCursor");
    }
}
