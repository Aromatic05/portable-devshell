use std::collections::VecDeque;
use std::sync::{Condvar, Mutex};
use std::time::Duration;

use crate::transport::reverse::ReversePayloadFrame;

#[derive(Default)]
pub(super) struct ReverseResponseQueue {
    ready: Condvar,
    responses: Mutex<VecDeque<ReversePayloadFrame>>,
}

impl ReverseResponseQueue {
    pub(super) fn push_back(&self, response: ReversePayloadFrame) -> Result<(), String> {
        self.responses
            .lock()
            .map_err(|_| "reverse response queue lock poisoned".to_string())?
            .push_back(response);
        self.ready.notify_one();
        Ok(())
    }

    pub(super) fn push_front(&self, response: ReversePayloadFrame) -> Result<(), String> {
        self.responses
            .lock()
            .map_err(|_| "reverse response queue lock poisoned".to_string())?
            .push_front(response);
        self.ready.notify_one();
        Ok(())
    }

    pub(super) fn try_pop(&self) -> Result<Option<ReversePayloadFrame>, String> {
        Ok(self
            .responses
            .lock()
            .map_err(|_| "reverse response queue lock poisoned".to_string())?
            .pop_front())
    }

    pub(super) fn wait_pop(
        &self,
        timeout: Duration,
    ) -> Result<Option<ReversePayloadFrame>, String> {
        let responses = self
            .responses
            .lock()
            .map_err(|_| "reverse response queue lock poisoned".to_string())?;
        let (mut responses, _) = self
            .ready
            .wait_timeout_while(responses, timeout, |responses| responses.is_empty())
            .map_err(|_| "reverse response queue lock poisoned".to_string())?;
        Ok(responses.pop_front())
    }

    pub(super) fn remove_key(&self, key: &str) -> Result<(), String> {
        let mut responses = self
            .responses
            .lock()
            .map_err(|_| "reverse response queue lock poisoned".to_string())?;
        responses.retain(|response| response.opaque_id.as_deref() != Some(key));
        Ok(())
    }

    pub(super) fn wake(&self) {
        self.ready.notify_all();
    }
}
