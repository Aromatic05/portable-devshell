use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::tools::{ToolCall, ToolError};

const CLOSED_SESSION_RETENTION_MS: u128 = 60 * 60 * 1_000;
const MAX_CLOSED_SESSIONS: usize = 1_024;

#[derive(Default)]
pub struct ClosedSessionRegistry {
    sessions: Mutex<HashMap<String, u128>>,
}

impl ClosedSessionRegistry {
    pub fn close(&self, session_id: &str) -> Result<(), ToolError> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| lock_error("tmux closed sessions"))?;
        prune(&mut sessions);
        sessions.insert(session_id.to_string(), now_ms());
        trim(&mut sessions);
        Ok(())
    }

    pub fn require_open(&self, call: &ToolCall) -> Result<(), ToolError> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| lock_error("tmux closed sessions"))?;
        prune(&mut sessions);
        if sessions.contains_key(&call.session_id) {
            return Err(ToolError::new(
                "tmux.sessionClosed",
                "the MCP/RPC session has already been closed",
            ));
        }
        Ok(())
    }
}

fn prune(sessions: &mut HashMap<String, u128>) {
    let now = now_ms();
    sessions.retain(|_, closed_at| now.saturating_sub(*closed_at) <= CLOSED_SESSION_RETENTION_MS);
}

fn trim(sessions: &mut HashMap<String, u128>) {
    if sessions.len() <= MAX_CLOSED_SESSIONS {
        return;
    }
    let mut ordered = sessions
        .iter()
        .map(|(session, closed_at)| (session.clone(), *closed_at))
        .collect::<Vec<_>>();
    ordered.sort_by_key(|(_, closed_at)| *closed_at);
    for (session, _) in ordered
        .into_iter()
        .take(sessions.len() - MAX_CLOSED_SESSIONS)
    {
        sessions.remove(&session);
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn lock_error(name: &str) -> ToolError {
    ToolError::new("tmux.internalError", format!("{name} lock poisoned"))
}
