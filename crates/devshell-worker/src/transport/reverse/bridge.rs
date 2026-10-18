use std::collections::VecDeque;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, TryRecvError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use crate::capability::rpc::router::RpcRouter;
use crate::transport::endpoint::channel::LocalIpcStream;
use crate::transport::frame::{FrameDecoder, encode_frame};

const OUTPUT_QUEUE_CAPACITY: usize = 64;
const MAX_UNACKNOWLEDGED_WSS_FRAMES: usize = 64;

pub(super) struct ReverseBridge {
    output: Mutex<Option<Receiver<Result<Vec<u8>, String>>>>,
    pending: Mutex<VecDeque<Vec<u8>>>,
    wss_inflight: Mutex<VecDeque<(u64, Vec<u8>)>>,
    wss_session: Mutex<[u8; 16]>,
    wss_next_seq: AtomicU64,
    router: Arc<RpcRouter>,
    transport_endpoint: PathBuf,
    writer: Mutex<Option<LocalIpcStream>>,
}

impl ReverseBridge {
    pub(super) fn new(transport_endpoint: PathBuf, router: Arc<RpcRouter>) -> Self {
        Self {
            output: Mutex::new(None),
            pending: Mutex::new(VecDeque::new()),
            wss_inflight: Mutex::new(VecDeque::new()),
            wss_session: Mutex::new(*uuid::Uuid::new_v4().as_bytes()),
            wss_next_seq: AtomicU64::new(1),
            router,
            transport_endpoint,
            writer: Mutex::new(None),
        }
    }

    pub(super) fn is_stopping(&self) -> bool {
        self.router.shutdown_requested()
    }

    pub(super) fn prepare(&self) -> Result<usize, String> {
        self.close();
        // New transports have new Frame/Envelope streams. Old DATA fragments
        // cannot be replayed into one: their RPC result is uncertain instead.
        let abandoned = {
            let mut pending = self
                .pending
                .lock()
                .map_err(|_| "reverse pending queue lock poisoned".to_string())?;
            let mut inflight = self
                .wss_inflight
                .lock()
                .map_err(|_| "reverse WSS inflight lock poisoned".to_string())?;
            let count = pending.len() + inflight.len();
            pending.clear();
            inflight.clear();
            count
        };
        *self
            .wss_session
            .lock()
            .map_err(|_| "reverse WSS session lock poisoned".to_string())? =
            *uuid::Uuid::new_v4().as_bytes();
        self.wss_next_seq.store(1, Ordering::Relaxed);
        let writer = LocalIpcStream::connect(&self.transport_endpoint).map_err(|error| {
            format!(
                "failed to connect reverse Endpoint bridge {}: {error}",
                self.transport_endpoint.display(),
            )
        })?;
        let mut reader = writer
            .try_clone()
            .map_err(|error| format!("failed to clone reverse Endpoint bridge: {error}"))?;
        let (output_tx, output_rx) = mpsc::sync_channel(OUTPUT_QUEUE_CAPACITY);
        thread::spawn(move || {
            let mut buffer = vec![0_u8; 64 * 1024];
            let mut frame_decoder = FrameDecoder::new();
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => {
                        let _ = output_tx.send(Err("reverse Endpoint bridge closed".to_string()));
                        return;
                    }
                    Ok(read) => {
                        // TCP/IPC reads may split a Frame mid-header or mid-payload.
                        // Never acknowledge a fragment and later replay that fragment
                        // into a fresh FrameProtocol stream.
                        let complete = frame_decoder.push(&buffer[..read]).and_then(|frames| {
                            frames
                                .iter()
                                .map(encode_frame)
                                .collect::<Result<Vec<_>, _>>()
                        });
                        match complete {
                            Ok(frames) => {
                                for frame in frames {
                                    if output_tx.send(Ok(frame)).is_err() {
                                        return;
                                    }
                                }
                            }
                            Err(error) => {
                                let _ = output_tx.send(Err(error));
                                return;
                            }
                        }
                    }
                    Err(error) => {
                        let _ = output_tx.send(Err(format!(
                            "reverse Endpoint bridge read failed: {error}",
                        )));
                        return;
                    }
                }
            }
        });
        *self
            .writer
            .lock()
            .map_err(|_| "reverse Endpoint writer lock poisoned".to_string())? = Some(writer);
        *self
            .output
            .lock()
            .map_err(|_| "reverse Endpoint output lock poisoned".to_string())? = Some(output_rx);
        Ok(abandoned)
    }

    pub(super) fn accept_inbound(&self, frame: &[u8]) -> Result<Option<Vec<u8>>, String> {
        {
            let mut writer = self
                .writer
                .lock()
                .map_err(|_| "reverse Endpoint writer lock poisoned".to_string())?;
            let writer = writer
                .as_mut()
                .ok_or_else(|| "reverse Endpoint bridge is not connected".to_string())?;
            writer
                .write_all(frame)
                .map_err(|error| format!("reverse Endpoint bridge write failed: {error}"))?;
            writer
                .flush()
                .map_err(|error| format!("reverse Endpoint bridge flush failed: {error}"))?;
        }
        self.try_pop_outbound()
    }

    pub(super) fn try_pop_outbound(&self) -> Result<Option<Vec<u8>>, String> {
        if let Some(frame) = self
            .pending
            .lock()
            .map_err(|_| "reverse pending queue lock poisoned".to_string())?
            .pop_front()
        {
            return Ok(Some(frame));
        }
        let output = self
            .output
            .lock()
            .map_err(|_| "reverse Endpoint output lock poisoned".to_string())?;
        let Some(output) = output.as_ref() else {
            return Ok(None);
        };
        match output.try_recv() {
            Ok(Ok(frame)) => Ok(Some(frame)),
            Ok(Err(error)) => Err(error),
            Err(TryRecvError::Empty) => Ok(None),
            Err(TryRecvError::Disconnected) => {
                Err("reverse Endpoint bridge output disconnected".to_string())
            }
        }
    }

    pub(super) fn wait_pop_outbound(&self, timeout: Duration) -> Result<Option<Vec<u8>>, String> {
        if let Some(frame) = self
            .pending
            .lock()
            .map_err(|_| "reverse pending queue lock poisoned".to_string())?
            .pop_front()
        {
            return Ok(Some(frame));
        }
        let output = self
            .output
            .lock()
            .map_err(|_| "reverse Endpoint output lock poisoned".to_string())?;
        let Some(output) = output.as_ref() else {
            return Ok(None);
        };
        match output.recv_timeout(timeout) {
            Ok(Ok(frame)) => Ok(Some(frame)),
            Ok(Err(error)) => Err(error),
            Err(RecvTimeoutError::Timeout) => Ok(None),
            Err(RecvTimeoutError::Disconnected) => {
                Err("reverse Endpoint bridge output disconnected".to_string())
            }
        }
    }

    pub(super) fn wss_session(&self) -> Result<[u8; 16], String> {
        self.wss_session
            .lock()
            .map(|session| *session)
            .map_err(|_| "reverse WSS session lock poisoned".to_string())
    }

    pub(super) fn next_wss_frame(
        &self,
        sent_through: u64,
    ) -> Result<Option<(u64, Vec<u8>)>, String> {
        {
            let inflight = self
                .wss_inflight
                .lock()
                .map_err(|_| "reverse WSS inflight lock poisoned".to_string())?;
            if let Some(frame) = next_unacknowledged_frame(&inflight, sent_through) {
                return Ok(Some(frame));
            }
            if inflight.len() >= MAX_UNACKNOWLEDGED_WSS_FRAMES {
                return Ok(None);
            }
        }
        let Some(frame) = self.try_pop_outbound()? else {
            return Ok(None);
        };
        let seq = self.wss_next_seq.fetch_add(1, Ordering::Relaxed);
        if seq == 0 {
            return Err("reverse WSS sequence exhausted".to_string());
        }
        self.wss_inflight
            .lock()
            .map_err(|_| "reverse WSS inflight lock poisoned".to_string())?
            .push_back((seq, frame.clone()));
        Ok(Some((seq, frame)))
    }

    pub(super) fn acknowledge_wss_frame(&self, seq: u64) -> Result<(), String> {
        let mut inflight = self
            .wss_inflight
            .lock()
            .map_err(|_| "reverse WSS inflight lock poisoned".to_string())?;
        retire_acknowledged_frames(&mut inflight, seq);
        Ok(())
    }

    pub(super) fn requeue_front(&self, frame: Vec<u8>) -> Result<(), String> {
        self.pending
            .lock()
            .map_err(|_| "reverse pending queue lock poisoned".to_string())?
            .push_front(frame);
        Ok(())
    }

    fn close(&self) {
        if let Ok(mut writer) = self.writer.lock()
            && let Some(writer) = writer.take()
        {
            let _ = writer.shutdown_both();
        }
        if let Ok(mut output) = self.output.lock() {
            if let Some(receiver) = output.take() {
                // Output already read from the Worker bridge belongs to the
                // completed call, even if the network transport disappeared.
                // Drain the old bounded channel before dropping its receiver.
                let buffered = drain_buffered_output(receiver);
                if !buffered.is_empty()
                    && let Ok(mut pending) = self.pending.lock()
                {
                    pending.extend(buffered);
                }
            }
        }
    }
}

fn next_unacknowledged_frame(
    inflight: &VecDeque<(u64, Vec<u8>)>,
    sent_through: u64,
) -> Option<(u64, Vec<u8>)> {
    inflight
        .iter()
        .find(|(seq, _)| *seq > sent_through)
        .map(|(seq, frame)| (*seq, frame.clone()))
}

fn retire_acknowledged_frames(inflight: &mut VecDeque<(u64, Vec<u8>)>, seq: u64) {
    while inflight.front().is_some_and(|(id, _)| *id <= seq) {
        inflight.pop_front();
    }
}

fn drain_buffered_output(receiver: Receiver<Result<Vec<u8>, String>>) -> VecDeque<Vec<u8>> {
    let mut buffered = VecDeque::new();
    loop {
        match receiver.recv_timeout(Duration::from_millis(20)) {
            Ok(Ok(frame)) => buffered.push_back(frame),
            Ok(Err(_)) | Err(RecvTimeoutError::Disconnected | RecvTimeoutError::Timeout) => break,
        }
    }
    buffered
}

#[cfg(test)]
mod tests {
    use super::{drain_buffered_output, next_unacknowledged_frame, retire_acknowledged_frames};
    use std::collections::VecDeque;
    use std::sync::mpsc;

    #[test]
    fn acknowledged_frames_retire_only_within_the_current_transport() {
        let mut inflight = VecDeque::from([(1_u64, b"one".to_vec()), (2_u64, b"two".to_vec())]);
        assert_eq!(next_unacknowledged_frame(&inflight, 0).unwrap().0, 1);
        retire_acknowledged_frames(&mut inflight, 1);
        assert_eq!(next_unacknowledged_frame(&inflight, 0).unwrap().0, 2);
        retire_acknowledged_frames(&mut inflight, 2);
        assert!(inflight.is_empty());
    }

    #[test]
    fn buffered_responses_survive_bridge_receiver_replacement_in_order() {
        let (send, recv) = mpsc::sync_channel(64);
        send.send(Ok(vec![1, 2, 3])).unwrap();
        send.send(Ok(vec![4, 5])).unwrap();
        drop(send);
        assert_eq!(
            drain_buffered_output(recv).into_iter().collect::<Vec<_>>(),
            vec![vec![1, 2, 3], vec![4, 5]]
        );
    }
}

impl Drop for ReverseBridge {
    fn drop(&mut self) {
        self.close();
    }
}
