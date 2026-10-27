use std::sync::{Arc, Condvar, Mutex};

// Reservations follow producer bytes through the event queue and encoded pending
// output. Only a completed Frame write releases them back to the reader.
pub(super) const OUTPUT_BUFFER_BYTES: usize = 256 * 1024;

#[derive(Default)]
pub(super) struct OutputBudget {
    state: Mutex<(usize, bool)>,
    changed: Condvar,
}

impl OutputBudget {
    pub(super) fn reserve(self: &Arc<Self>, bytes: usize) -> Option<OutputCredit> {
        let mut state = self.state.lock().unwrap();
        while !state.1 && state.0 + bytes > OUTPUT_BUFFER_BYTES {
            state = self.changed.wait(state).unwrap();
        }
        if state.1 {
            return None;
        }
        state.0 += bytes;
        Some(OutputCredit {
            budget: Arc::clone(self),
            bytes,
        })
    }

    #[cfg(test)]
    pub(super) fn reserved_bytes(&self) -> usize {
        self.state.lock().unwrap().0
    }

    pub(super) fn cancel(&self) {
        self.state.lock().unwrap().1 = true;
        self.changed.notify_all();
    }
}

pub(super) struct OutputCredit {
    budget: Arc<OutputBudget>,
    pub(super) bytes: usize,
}

impl Drop for OutputCredit {
    fn drop(&mut self) {
        self.budget.state.lock().unwrap().0 -= self.bytes;
        self.budget.changed.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn byte_reservations_stay_charged_until_the_owner_drops() {
        let budget = Arc::new(OutputBudget::default());
        let credit = budget.reserve(OUTPUT_BUFFER_BYTES).unwrap();
        let (started, ready) = mpsc::channel();
        let (events, receiver) = mpsc::channel();
        let producer_budget = Arc::clone(&budget);
        let producer = thread::spawn(move || {
            started.send(()).unwrap();
            events.send(producer_budget.reserve(1)).unwrap();
        });
        ready.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(receiver.recv_timeout(Duration::from_millis(100)).is_err());
        assert_eq!(budget.reserved_bytes(), OUTPUT_BUFFER_BYTES);
        drop(credit);
        let resumed = receiver
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap();
        assert_eq!(budget.reserved_bytes(), 1);
        drop(resumed);
        producer.join().unwrap();
        assert_eq!(budget.reserved_bytes(), 0);
    }

    #[test]
    fn cancellation_wakes_a_full_budget_without_releasing_pending_output() {
        let budget = Arc::new(OutputBudget::default());
        let pending_credit = budget.reserve(OUTPUT_BUFFER_BYTES).unwrap();
        let (started, ready) = mpsc::channel();
        let (events, receiver) = mpsc::channel();
        let producer_budget = Arc::clone(&budget);
        let producer = thread::spawn(move || {
            started.send(()).unwrap();
            events.send(producer_budget.reserve(1).is_none()).unwrap();
        });
        ready.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(receiver.recv_timeout(Duration::from_millis(100)).is_err());
        budget.cancel();
        assert!(receiver.recv_timeout(Duration::from_secs(2)).unwrap());
        producer.join().unwrap();
        assert_eq!(budget.reserved_bytes(), OUTPUT_BUFFER_BYTES);
        assert!(budget.reserve(1).is_none());
        drop(pending_credit);
        assert_eq!(budget.reserved_bytes(), 0);
    }
}
