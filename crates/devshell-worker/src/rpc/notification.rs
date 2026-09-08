use std::collections::VecDeque;
use std::sync::Mutex;

use serde_json::Value;

use crate::rpc::codec::encode_json;

pub const DEFAULT_MAX_NOTIFICATION_BYTES: usize = 4 * 1024 * 1024;

pub struct WorkerNotificationQueue {
    inner: Mutex<WorkerNotificationQueueState>,
    max_bytes: usize,
}

struct WorkerNotificationQueueState {
    bytes: usize,
    frames: VecDeque<WorkerNotificationFrame>,
}

struct WorkerNotificationFrame {
    bytes: Vec<u8>,
    lossy: bool,
}

impl WorkerNotificationQueue {
    pub fn new(max_bytes: usize) -> Self {
        Self {
            inner: Mutex::new(WorkerNotificationQueueState {
                bytes: 0,
                frames: VecDeque::new(),
            }),
            max_bytes,
        }
    }

    pub fn push_json(&self, notification: &Value) -> Result<(), String> {
        self.push(encode_json(notification)?, false)
    }

    pub fn push_lossy_json(&self, notification: &Value) -> Result<(), String> {
        self.push(encode_json(notification)?, true)
    }

    fn push(&self, frame: Vec<u8>, lossy: bool) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "notification queue lock poisoned".to_string())?;
        inner.bytes += frame.len();
        inner.frames.push_back(WorkerNotificationFrame { bytes: frame, lossy });
        while inner.bytes > self.max_bytes && inner.frames.len() > 1 {
            if let Some(index) = inner.frames.iter().position(|frame| frame.lossy) {
                if let Some(frame) = inner.frames.remove(index) {
                    inner.bytes = inner.bytes.saturating_sub(frame.bytes.len());
                }
                continue;
            }
            if let Some(frame) = inner.frames.pop_front() {
                inner.bytes = inner.bytes.saturating_sub(frame.bytes.len());
            }
        }
        Ok(())
    }

    pub fn try_pop(&self) -> Result<Option<Vec<u8>>, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "notification queue lock poisoned".to_string())?;
        let frame = inner.frames.pop_front();
        if let Some(frame) = &frame {
            inner.bytes = inner.bytes.saturating_sub(frame.bytes.len());
        }
        Ok(frame.map(|frame| frame.bytes))
    }

    pub fn clear(&self) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "notification queue lock poisoned".to_string())?;
        inner.bytes = 0;
        inner.frames.clear();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::WorkerNotificationQueue;

    #[test]
    fn bounded_queue_drops_oldest_notifications() {
        let queue = WorkerNotificationQueue::new(12);
        queue.push(b"first".to_vec(), false).unwrap();
        queue.push(b"second".to_vec(), false).unwrap();
        queue.push(b"third".to_vec(), false).unwrap();

        assert_eq!(queue.try_pop().unwrap(), Some(b"second".to_vec()));
        assert_eq!(queue.try_pop().unwrap(), Some(b"third".to_vec()));
        assert_eq!(queue.try_pop().unwrap(), None);
    }

    #[test]
    fn lossy_progress_is_evicted_before_terminal_notifications() {
        let queue = WorkerNotificationQueue::new(12);
        queue.push(b"term-a".to_vec(), false).unwrap();
        queue.push(b"progress".to_vec(), true).unwrap();
        queue.push(b"term-b".to_vec(), false).unwrap();

        assert_eq!(queue.try_pop().unwrap(), Some(b"term-a".to_vec()));
        assert_eq!(queue.try_pop().unwrap(), Some(b"term-b".to_vec()));
        assert_eq!(queue.try_pop().unwrap(), None);
    }
}
