use std::collections::VecDeque;
use std::sync::Mutex;

use serde_json::Value;

pub const DEFAULT_MAX_NOTIFICATION_BYTES: usize = 4 * 1024 * 1024;

pub struct WorkerNotificationQueue {
    inner: Mutex<WorkerNotificationQueueState>,
    max_bytes: usize,
}

struct WorkerNotificationQueueState {
    bytes: usize,
    notifications: VecDeque<WorkerNotification>,
}

struct WorkerNotification {
    value: Value,
    bytes: usize,
    lossy: bool,
}

impl WorkerNotificationQueue {
    pub fn new(max_bytes: usize) -> Self {
        Self {
            inner: Mutex::new(WorkerNotificationQueueState {
                bytes: 0,
                notifications: VecDeque::new(),
            }),
            max_bytes,
        }
    }

    pub fn push_json(&self, notification: &Value) -> Result<(), String> {
        self.push(notification.clone(), false)
    }

    pub fn push_lossy_json(&self, notification: &Value) -> Result<(), String> {
        self.push(notification.clone(), true)
    }

    fn push(&self, value: Value, lossy: bool) -> Result<(), String> {
        let bytes = serde_json::to_vec(&value)
            .map_err(|error| error.to_string())?
            .len();
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "notification queue lock poisoned".to_string())?;
        inner.bytes += bytes;
        inner.notifications.push_back(WorkerNotification {
            value,
            bytes,
            lossy,
        });
        while inner.bytes > self.max_bytes && inner.notifications.len() > 1 {
            if let Some(index) = inner
                .notifications
                .iter()
                .position(|notification| notification.lossy)
            {
                if let Some(notification) = inner.notifications.remove(index) {
                    inner.bytes = inner.bytes.saturating_sub(notification.bytes);
                }
                continue;
            }
            if let Some(notification) = inner.notifications.pop_front() {
                inner.bytes = inner.bytes.saturating_sub(notification.bytes);
            }
        }
        Ok(())
    }

    pub fn try_pop(&self) -> Result<Option<Value>, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "notification queue lock poisoned".to_string())?;
        let notification = inner.notifications.pop_front();
        if let Some(notification) = &notification {
            inner.bytes = inner.bytes.saturating_sub(notification.bytes);
        }
        Ok(notification.map(|notification| notification.value))
    }


}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::WorkerNotificationQueue;

    #[test]
    fn bounded_queue_drops_oldest_notifications() {
        let queue = WorkerNotificationQueue::new(15);
        queue.push(Value::String("first".into()), false).unwrap();
        queue.push(Value::String("second".into()), false).unwrap();
        queue.push(Value::String("third".into()), false).unwrap();

        assert_eq!(
            queue.try_pop().unwrap(),
            Some(Value::String("second".into()))
        );
        assert_eq!(
            queue.try_pop().unwrap(),
            Some(Value::String("third".into()))
        );
        assert_eq!(queue.try_pop().unwrap(), None);
    }

    #[test]
    fn lossy_progress_is_evicted_before_terminal_notifications() {
        let queue = WorkerNotificationQueue::new(18);
        queue.push(Value::String("term-a".into()), false).unwrap();
        queue.push(Value::String("progress".into()), true).unwrap();
        queue.push(Value::String("term-b".into()), false).unwrap();

        assert_eq!(
            queue.try_pop().unwrap(),
            Some(Value::String("term-a".into()))
        );
        assert_eq!(
            queue.try_pop().unwrap(),
            Some(Value::String("term-b".into()))
        );
        assert_eq!(queue.try_pop().unwrap(), None);
    }
}
