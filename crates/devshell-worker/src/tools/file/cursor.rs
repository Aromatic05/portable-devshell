use std::collections::{HashMap, VecDeque};

use uuid::Uuid;

use crate::tools::ToolError;

const MAX_CURSORS: usize = 256;

struct Cursor {
    offset: usize,
    query: String,
}

#[derive(Default)]
pub struct CursorStore {
    cursors: HashMap<String, Cursor>,
    order: VecDeque<String>,
}

impl CursorStore {
    pub fn issue(&mut self, query: &serde_json::Value, offset: usize) -> String {
        let id = Uuid::new_v4().to_string();
        self.cursors.insert(
            id.clone(),
            Cursor {
                offset,
                query: query.to_string(),
            },
        );
        self.order.push_back(id.clone());
        while self.order.len() > MAX_CURSORS {
            if let Some(expired) = self.order.pop_front() {
                self.cursors.remove(&expired);
            }
        }
        id
    }

    pub fn resolve(&self, id: &str, query: &serde_json::Value) -> Result<usize, ToolError> {
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
