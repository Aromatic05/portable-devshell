use std::num::NonZeroUsize;

use lru::LruCache;
use uuid::Uuid;

use crate::tools::ToolCall;
use crate::tools::ToolError;

const MAX_CURSORS: usize = 128;

#[derive(Clone)]
struct Cursor<T> {
    state: T,
    ctx_id: String,
    workspace: std::path::PathBuf,
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
    pub fn issue(&mut self, call: &ToolCall, state: T) -> String {
        let id = Uuid::new_v4().to_string();
        self.cursors.put(
            id.clone(),
            Cursor {
                state,
                ctx_id: call.ctx_id.clone(),
                workspace: call.workspace.clone(),
            },
        );
        id
    }

    pub fn resolve(&mut self, call: &ToolCall, id: &str) -> Result<T, ToolError> {
        let cursor = self
            .cursors
            .get(id)
            .ok_or_else(|| {
                ToolError::new(
                    "file.invalidCursor",
                    "cursor expired, was evicted, or belongs to an earlier worker process; rerun the original query",
                )
            })?;
        if cursor.ctx_id != call.ctx_id || cursor.workspace != call.workspace {
            return Err(ToolError::new(
                "file.invalidCursor",
                "cursor belongs to a different context or workspace",
            ));
        }
        Ok(cursor.state.clone())
    }
}

#[cfg(test)]
mod tests {
    // Cursor scope is exercised through the file tool contract tests because it is
    // defined by the complete ToolCall context rather than by the token alone.
}
