use std::collections::{HashSet, VecDeque};

use crate::transport::frame::{
    Frame, FrameDecoder, FrameEvent, FrameProtocol, FrameRole, RESET_SERVICE_FAILED, encode_frame,
};
use crate::transport::reverse::ReversePayloadFrame;

use super::ReverseWireFrame;

const REVERSE_SERVICE_RECEIVE_WINDOW: u32 = 256 * 1024;

struct PendingReversePayload {
    offset: usize,
    output: ReversePayloadFrame,
}

pub(super) enum ReverseInboundAction {
    Rpc(Vec<u8>),
    Service(Vec<u8>),
}

pub(super) struct ReverseFrameState {
    decoder: FrameDecoder,
    last_stream_id: u32,
    rpc_pending: Option<PendingReversePayload>,
    rpc_protocol: FrameProtocol,
    rpc_stream_id: Option<u32>,
    rpc_streams: HashSet<u32>,
    wire_outbound: VecDeque<ReverseWireFrame>,
}

impl ReverseFrameState {
    pub(super) fn new() -> Self {
        Self {
            decoder: FrameDecoder::default(),
            last_stream_id: 0,
            rpc_pending: None,
            rpc_protocol: FrameProtocol::new(FrameRole::Acceptor),
            rpc_stream_id: None,
            rpc_streams: HashSet::new(),
            wire_outbound: VecDeque::new(),
        }
    }

    pub(super) fn reset(&mut self) -> Option<ReversePayloadFrame> {
        let pending = self.rpc_pending.take().map(|pending| pending.output);
        *self = Self::new();
        pending
    }

    pub(super) fn accept_bytes(
        &mut self,
        bytes: &[u8],
    ) -> Result<Vec<ReverseInboundAction>, String> {
        let mut actions = Vec::new();
        for frame in self.decoder.push(bytes)? {
            let open = match &frame {
                Frame::Open {
                    stream_id,
                    service,
                    metadata,
                    ..
                } => Some((*stream_id, service.clone(), metadata.clone())),
                _ => None,
            };
            if let Some((stream_id, service, metadata)) = open {
                if stream_id <= self.last_stream_id {
                    return Err(format!("Frame stream id {stream_id} is not monotonic."));
                }
                self.last_stream_id = stream_id;
                if service == "worker.rpc" {
                    self.accept_rpc_open(frame, stream_id, &metadata)?;
                } else {
                    actions.push(ReverseInboundAction::Service(encode_frame(&frame)?));
                }
                continue;
            }

            let stream_id = frame.stream_id();
            if self.rpc_streams.contains(&stream_id) {
                self.accept_rpc_frame(frame, &mut actions)?;
                continue;
            }
            if stream_id <= self.last_stream_id {
                actions.push(ReverseInboundAction::Service(encode_frame(&frame)?));
                continue;
            }
            return Err(format!("Frame references unknown stream {stream_id}."));
        }
        Ok(actions)
    }

    pub(super) fn pop_wire(&mut self) -> Result<Option<ReverseWireFrame>, String> {
        if let Some(frame) = self.wire_outbound.pop_front() {
            return Ok(Some(frame));
        }
        let Some(stream_id) = self.rpc_stream_id else {
            return Ok(None);
        };
        let Some(mut pending) = self.rpc_pending.take() else {
            return Ok(None);
        };
        let Some((used, frame)) = self
            .rpc_protocol
            .next_data_frame(stream_id, &pending.output.frame[pending.offset..])?
        else {
            self.rpc_pending = Some(pending);
            return Ok(None);
        };
        pending.offset += used;
        let requeue = pending.output.clone();
        if pending.offset < pending.output.frame.len() {
            self.rpc_pending = Some(pending);
        }
        Ok(Some(ReverseWireFrame {
            frame: encode_frame(&frame)?,
            requeue: Some(requeue),
        }))
    }

    pub(super) fn has_rpc_pending(&self) -> bool {
        self.rpc_pending.is_some()
    }

    pub(super) fn install_rpc(&mut self, output: ReversePayloadFrame) -> Result<(), String> {
        if self.rpc_pending.is_some() {
            return Err("reverse RPC output is already pending".to_string());
        }
        self.rpc_pending = Some(PendingReversePayload { offset: 0, output });
        Ok(())
    }

    pub(super) fn push_wire(&mut self, frame: ReverseWireFrame) {
        self.wire_outbound.push_back(frame);
    }

    pub(super) fn clear_pending_if_matches(&mut self, output: &ReversePayloadFrame) {
        if self
            .rpc_pending
            .as_ref()
            .is_some_and(|pending| pending.output == *output)
        {
            self.rpc_pending = None;
        }
    }

    fn accept_rpc_open(
        &mut self,
        frame: Frame,
        stream_id: u32,
        metadata: &[u8],
    ) -> Result<(), String> {
        let event = self
            .rpc_protocol
            .accept_frame(frame)?
            .ok_or_else(|| "worker.rpc OPEN event is missing".to_string())?;
        if !matches!(event, FrameEvent::Open { .. }) {
            return Err("worker.rpc expected OPEN event".to_string());
        }
        self.rpc_streams.insert(stream_id);
        if !metadata.is_empty() || self.rpc_stream_id.is_some() {
            let reset = self.rpc_protocol.reject_open(
                stream_id,
                RESET_SERVICE_FAILED,
                "worker.rpc requires empty metadata and one active stream".to_string(),
            )?;
            self.queue_rpc_frame(reset)?;
            return Ok(());
        }
        self.rpc_stream_id = Some(stream_id);
        let window = self
            .rpc_protocol
            .accept_open(stream_id, REVERSE_SERVICE_RECEIVE_WINDOW)?;
        self.queue_rpc_frame(window)
    }

    fn accept_rpc_frame(
        &mut self,
        frame: Frame,
        actions: &mut Vec<ReverseInboundAction>,
    ) -> Result<(), String> {
        let is_window = matches!(&frame, Frame::Window { .. });
        let event = self.rpc_protocol.accept_frame(frame)?;
        match event {
            Some(FrameEvent::Data { stream_id }) => {
                while let Some(data) = self.rpc_protocol.read_data(stream_id)? {
                    let byte_len = u32::try_from(data.len())
                        .map_err(|_| "worker.rpc DATA exceeds u32".to_string())?;
                    actions.push(ReverseInboundAction::Rpc(data));
                    if let Some(window) = self.rpc_protocol.consume(stream_id, byte_len)? {
                        self.queue_rpc_frame(window)?;
                    }
                }
            }
            Some(FrameEvent::Fin { .. }) => {}
            Some(FrameEvent::Reset { stream_id, .. }) => {
                if self.rpc_stream_id == Some(stream_id) {
                    self.rpc_stream_id = None;
                    if let Some(pending) = self.rpc_pending.as_mut() {
                        pending.offset = 0;
                    }
                }
            }
            Some(FrameEvent::Open { .. }) => {
                return Err("unexpected nested worker.rpc OPEN".to_string());
            }
            None if is_window => {}
            None => {}
        }
        Ok(())
    }

    fn queue_rpc_frame(&mut self, frame: Frame) -> Result<(), String> {
        self.wire_outbound.push_back(ReverseWireFrame {
            frame: encode_frame(&frame)?,
            requeue: None,
        });
        Ok(())
    }
}
