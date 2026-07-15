use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::tools::{ToolCall, ToolError};

const REPLAY_RETENTION_MS: u128 = 10 * 60 * 1_000;
const MAX_REPLAYS: usize = 256;

struct ReplaySlot {
    created_at_ms: u128,
    fingerprint: String,
    outcome: Mutex<Option<Result<serde_json::Value, ToolError>>>,
    ready: Condvar,
}

#[derive(Default)]
pub struct ReplayCache {
    slots: Mutex<HashMap<String, Arc<ReplaySlot>>>,
}

impl ReplayCache {
    pub fn execute<T, F>(&self, call: &ToolCall, method: &str, operation: F) -> Result<T, ToolError>
    where
        T: Clone + DeserializeOwned + Serialize,
        F: FnOnce() -> Result<T, ToolError>,
    {
        let key = format!("{}:{}", call.ctx_id, call.request_id);
        let fingerprint = blake3::hash(
            &serde_json::to_vec(&serde_json::json!({
                "method": method,
                "params": call.params,
            }))
            .map_err(|error| ToolError::new("tmux.internalError", error.to_string()))?,
        )
        .to_hex()
        .to_string();
        let (slot, execute) = {
            let mut slots = self
                .slots
                .lock()
                .map_err(|_| lock_error("tmux replay cache"))?;
            prune(&mut slots)?;
            if let Some(slot) = slots.get(&key) {
                if slot.fingerprint != fingerprint {
                    return Err(ToolError::new(
                        "tmux.requestIdConflict",
                        "the same context request id was reused with different arguments",
                    ));
                }
                (Arc::clone(slot), false)
            } else {
                let slot = Arc::new(ReplaySlot {
                    created_at_ms: now_ms(),
                    fingerprint,
                    outcome: Mutex::new(None),
                    ready: Condvar::new(),
                });
                slots.insert(key, Arc::clone(&slot));
                (slot, true)
            }
        };

        if !execute {
            let mut outcome = slot
                .outcome
                .lock()
                .map_err(|_| lock_error("tmux replay result"))?;
            while outcome.is_none() {
                outcome = slot
                    .ready
                    .wait(outcome)
                    .map_err(|_| lock_error("tmux replay result"))?;
            }
            return decode(outcome.as_ref().expect("replay outcome is ready"));
        }

        let result = operation();
        let stored = match &result {
            Ok(value) => serde_json::to_value(value)
                .map_err(|error| ToolError::new("tmux.internalError", error.to_string())),
            Err(error) => Err(error.clone()),
        };
        let mut outcome = slot
            .outcome
            .lock()
            .map_err(|_| lock_error("tmux replay result"))?;
        *outcome = Some(stored);
        slot.ready.notify_all();
        result
    }
}

fn decode<T>(outcome: &Result<serde_json::Value, ToolError>) -> Result<T, ToolError>
where
    T: DeserializeOwned,
{
    match outcome {
        Ok(value) => serde_json::from_value(value.clone())
            .map_err(|error| ToolError::new("tmux.internalError", error.to_string())),
        Err(error) => Err(error.clone()),
    }
}

fn prune(slots: &mut HashMap<String, Arc<ReplaySlot>>) -> Result<(), ToolError> {
    let now = now_ms();
    let mut expired = Vec::new();
    for (key, slot) in slots.iter() {
        let complete = slot
            .outcome
            .lock()
            .map_err(|_| lock_error("tmux replay result"))?
            .is_some();
        if complete && now.saturating_sub(slot.created_at_ms) > REPLAY_RETENTION_MS {
            expired.push(key.clone());
        }
    }
    for key in expired {
        slots.remove(&key);
    }
    if slots.len() <= MAX_REPLAYS {
        return Ok(());
    }
    let mut ordered = Vec::new();
    for (key, slot) in slots.iter() {
        if slot
            .outcome
            .lock()
            .map_err(|_| lock_error("tmux replay result"))?
            .is_some()
        {
            ordered.push((key.clone(), slot.created_at_ms));
        }
    }
    ordered.sort_by_key(|(_, created)| *created);
    let remove_count = slots.len().saturating_sub(MAX_REPLAYS);
    for (key, _) in ordered.into_iter().take(remove_count) {
        slots.remove(&key);
    }
    Ok(())
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
