mod bridge;
mod frame;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use bridge::ReverseServiceBridge;
use frame::{ReverseFrameState, ReverseInboundAction};

use super::{ReversePayload, ReversePayloadFrame};

#[derive(Clone, Debug)]
pub(super) struct ReverseWireFrame {
    pub(super) frame: Vec<u8>,
    pub(super) requeue: Option<ReversePayloadFrame>,
}

pub(super) struct ReverseFramePayload {
    bridge: Mutex<ReverseServiceBridge>,
    prefer_rpc: AtomicBool,
    rpc: Arc<dyn ReversePayload>,
    state: Mutex<ReverseFrameState>,
    transport_socket: PathBuf,
}

impl ReverseFramePayload {
    pub(super) fn new(transport_socket: PathBuf, rpc: Arc<dyn ReversePayload>) -> Self {
        Self {
            bridge: Mutex::new(ReverseServiceBridge::new()),
            prefer_rpc: AtomicBool::new(true),
            rpc,
            state: Mutex::new(ReverseFrameState::new()),
            transport_socket,
        }
    }

    pub(super) fn is_stopping(&self) -> bool {
        self.rpc.is_stopping()
    }

    pub(super) fn prepare_connection(&self) -> Result<(), String> {
        let pending = self
            .state
            .lock()
            .map_err(|_| "reverse Frame state lock poisoned".to_string())?
            .reset();
        if let Some(pending) = pending {
            self.rpc.requeue_front(pending)?;
        }
        self.bridge
            .lock()
            .map_err(|_| "reverse Service bridge lock poisoned".to_string())?
            .prepare(&self.transport_socket)?;
        self.rpc.prepare_connection()
    }

    pub(super) fn accept_inbound(&self, bytes: &[u8]) -> Result<Option<ReverseWireFrame>, String> {
        let actions = self
            .state
            .lock()
            .map_err(|_| "reverse Frame state lock poisoned".to_string())?
            .accept_bytes(bytes)?;
        for action in actions {
            match action {
                ReverseInboundAction::Rpc(payload) => {
                    if let Some(response) = self.rpc.accept_inbound(&payload)? {
                        self.rpc.queue_outbound(response)?;
                    }
                }
                ReverseInboundAction::Service(frame) => {
                    self.bridge
                        .lock()
                        .map_err(|_| "reverse Service bridge lock poisoned".to_string())?
                        .send(&frame)?;
                }
            }
        }
        self.try_pop_outbound()
    }

    pub(super) fn queue_outbound(&self, frame: ReverseWireFrame) -> Result<(), String> {
        self.state
            .lock()
            .map_err(|_| "reverse Frame state lock poisoned".to_string())?
            .push_wire(frame);
        Ok(())
    }

    pub(super) fn try_pop_outbound(&self) -> Result<Option<ReverseWireFrame>, String> {
        if let Some(frame) = self.pop_state_wire()? {
            return Ok(Some(frame));
        }

        let rpc_first = self.prefer_rpc.fetch_xor(true, Ordering::Relaxed);
        if rpc_first {
            if let Some(frame) = self.try_pop_rpc()? {
                return Ok(Some(frame));
            }
            if let Some(frame) = self.try_pop_service()? {
                return Ok(Some(frame));
            }
        } else {
            if let Some(frame) = self.try_pop_service()? {
                return Ok(Some(frame));
            }
            if let Some(frame) = self.try_pop_rpc()? {
                return Ok(Some(frame));
            }
        }
        Ok(None)
    }

    pub(super) fn wait_pop_outbound(
        &self,
        timeout: Duration,
    ) -> Result<Option<ReverseWireFrame>, String> {
        if let Some(frame) = self.try_pop_outbound()? {
            return Ok(Some(frame));
        }
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return self.try_pop_outbound();
            }
            let slice = remaining.min(Duration::from_millis(20));
            let rpc_pending = self
                .state
                .lock()
                .map_err(|_| "reverse Frame state lock poisoned".to_string())?
                .has_rpc_pending();
            if rpc_pending {
                thread::sleep(slice);
            } else if let Some(output) = self.rpc.wait_pop_outbound(slice)? {
                self.install_rpc(output)?;
            }
            if let Some(frame) = self.try_pop_outbound()? {
                return Ok(Some(frame));
            }
        }
    }

    pub(super) fn requeue_front(&self, frame: ReverseWireFrame) -> Result<(), String> {
        let Some(requeue) = frame.requeue else {
            return Ok(());
        };
        self.state
            .lock()
            .map_err(|_| "reverse Frame state lock poisoned".to_string())?
            .clear_pending_if_matches(&requeue);
        self.rpc.requeue_front(requeue)
    }

    pub(super) fn wake_outbound(&self) {
        self.rpc.wake_outbound();
    }

    fn pop_state_wire(&self) -> Result<Option<ReverseWireFrame>, String> {
        self.state
            .lock()
            .map_err(|_| "reverse Frame state lock poisoned".to_string())?
            .pop_wire()
    }

    fn try_pop_rpc(&self) -> Result<Option<ReverseWireFrame>, String> {
        let has_pending = self
            .state
            .lock()
            .map_err(|_| "reverse Frame state lock poisoned".to_string())?
            .has_rpc_pending();
        if !has_pending && let Some(output) = self.rpc.try_pop_outbound()? {
            self.install_rpc(output)?;
        }
        self.pop_state_wire()
    }

    fn try_pop_service(&self) -> Result<Option<ReverseWireFrame>, String> {
        Ok(self
            .bridge
            .lock()
            .map_err(|_| "reverse Service bridge lock poisoned".to_string())?
            .try_pop()?
            .map(|frame| ReverseWireFrame {
                frame,
                requeue: None,
            }))
    }

    fn install_rpc(&self, output: ReversePayloadFrame) -> Result<(), String> {
        self.state
            .lock()
            .map_err(|_| "reverse Frame state lock poisoned".to_string())?
            .install_rpc(output)
    }
}
