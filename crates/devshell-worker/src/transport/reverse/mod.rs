mod sse;
mod websocket;

use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::blocking::Client;
use url::Url;

use crate::daemon::log::append_log;
use crate::instance::storage::InstancePaths;
use crate::instance::storage::ensure_file_mode;
use crate::instance::{InstanceName, WorkerReverseConfig};
use crate::transport::frame::{
    Frame, FrameDecoder, FrameEvent, FrameProtocol, FrameRole, RESET_SERVICE_FAILED,
    RESET_UNSUPPORTED_SERVICE, encode_frame,
};

const WSS_FAILURES_BEFORE_SSE: u32 = 3;
const MAX_RECONNECT_BACKOFF: Duration = Duration::from_secs(30);
const SSE_RETRY_AFTER: Duration = Duration::from_secs(5);
const SSE_READ_TIMEOUT: Duration = Duration::from_secs(45);
const REVERSE_SERVICE_RECEIVE_WINDOW: u32 = 256 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReversePayloadFrame {
    pub frame: Vec<u8>,
    pub opaque_id: Option<String>,
}

pub trait ReversePayload: Send + Sync {
    fn is_stopping(&self) -> bool;
    fn prepare_connection(&self) -> Result<(), String>;
    fn accept_inbound(&self, frame: &[u8]) -> Result<Option<ReversePayloadFrame>, String>;
    fn queue_outbound(&self, frame: ReversePayloadFrame) -> Result<(), String>;
    fn try_pop_outbound(&self) -> Result<Option<ReversePayloadFrame>, String>;
    fn wait_pop_outbound(&self, timeout: Duration) -> Result<Option<ReversePayloadFrame>, String>;
    fn requeue_front(&self, frame: ReversePayloadFrame) -> Result<(), String>;
    fn wake_outbound(&self);
}

struct PendingReversePayload {
    offset: usize,
    output: ReversePayloadFrame,
}

struct ReverseWireFrame {
    frame: Vec<u8>,
    requeue: Option<ReversePayloadFrame>,
}

struct ReverseFrameState {
    decoder: FrameDecoder,
    pending: Option<PendingReversePayload>,
    protocol: FrameProtocol,
    stream_id: Option<u32>,
    wire_outbound: VecDeque<ReverseWireFrame>,
}

impl ReverseFrameState {
    fn new() -> Self {
        Self {
            decoder: FrameDecoder::default(),
            pending: None,
            protocol: FrameProtocol::new(FrameRole::Acceptor),
            stream_id: None,
            wire_outbound: VecDeque::new(),
        }
    }

    fn reset(&mut self) -> Option<ReversePayloadFrame> {
        let pending = self.pending.take().map(|pending| pending.output);
        *self = Self::new();
        pending
    }

    fn accept_bytes(&mut self, bytes: &[u8], service: &str) -> Result<Vec<Vec<u8>>, String> {
        let mut payloads = Vec::new();
        for frame in self.decoder.push(bytes)? {
            let Some(event) = self.protocol.accept_frame(frame)? else {
                continue;
            };
            match event {
                FrameEvent::Open {
                    stream_id,
                    service: requested,
                    metadata,
                } => {
                    if requested != service {
                        let reset = self.protocol.reject_open(
                            stream_id,
                            RESET_UNSUPPORTED_SERVICE,
                            format!("unsupported reverse Service {requested}"),
                        )?;
                        self.push_wire(reset)?;
                        continue;
                    }
                    if !metadata.is_empty() || self.stream_id.is_some() {
                        let reset = self.protocol.reject_open(
                            stream_id,
                            RESET_SERVICE_FAILED,
                            "reverse Service requires empty metadata and one active stream"
                                .to_string(),
                        )?;
                        self.push_wire(reset)?;
                        continue;
                    }
                    self.stream_id = Some(stream_id);
                    let window = self
                        .protocol
                        .accept_open(stream_id, REVERSE_SERVICE_RECEIVE_WINDOW)?;
                    self.push_wire(window)?;
                }
                FrameEvent::Data { stream_id } => {
                    if self.stream_id != Some(stream_id) {
                        return Err("reverse DATA is not on the active Service stream".to_string());
                    }
                    while let Some(data) = self.protocol.read_data(stream_id)? {
                        let byte_len = u32::try_from(data.len())
                            .map_err(|_| "reverse Service DATA exceeds u32".to_string())?;
                        payloads.push(data);
                        if let Some(window) = self.protocol.consume(stream_id, byte_len)? {
                            self.push_wire(window)?;
                        }
                    }
                }
                FrameEvent::Fin { .. } => {}
                FrameEvent::Reset { stream_id, .. } => {
                    if self.stream_id == Some(stream_id) {
                        self.stream_id = None;
                        if let Some(pending) = self.pending.as_mut() {
                            pending.offset = 0;
                        }
                    }
                }
            }
        }
        Ok(payloads)
    }

    fn has_pending(&self) -> bool {
        self.pending.is_some()
    }

    fn install(&mut self, output: ReversePayloadFrame) {
        debug_assert!(self.pending.is_none());
        self.pending = Some(PendingReversePayload { offset: 0, output });
    }

    fn pop_wire(&mut self) -> Result<Option<ReverseWireFrame>, String> {
        if let Some(frame) = self.wire_outbound.pop_front() {
            return Ok(Some(frame));
        }
        let Some(stream_id) = self.stream_id else {
            return Ok(None);
        };
        let Some(mut pending) = self.pending.take() else {
            return Ok(None);
        };
        let Some((used, frame)) = self
            .protocol
            .next_data_frame(stream_id, &pending.output.frame[pending.offset..])?
        else {
            self.pending = Some(pending);
            return Ok(None);
        };
        pending.offset += used;
        let requeue = pending.output.clone();
        if pending.offset < pending.output.frame.len() {
            self.pending = Some(pending);
        }
        Ok(Some(ReverseWireFrame {
            frame: encode_frame(&frame)?,
            requeue: Some(requeue),
        }))
    }

    fn push_wire(&mut self, frame: Frame) -> Result<(), String> {
        self.wire_outbound.push_back(ReverseWireFrame {
            frame: encode_frame(&frame)?,
            requeue: None,
        });
        Ok(())
    }
}

struct ReverseFramePayload {
    payload: Arc<dyn ReversePayload>,
    service: String,
    state: Mutex<ReverseFrameState>,
}

impl ReverseFramePayload {
    fn new(service: String, payload: Arc<dyn ReversePayload>) -> Self {
        Self {
            payload,
            service,
            state: Mutex::new(ReverseFrameState::new()),
        }
    }

    fn is_stopping(&self) -> bool {
        self.payload.is_stopping()
    }

    fn prepare_connection(&self) -> Result<(), String> {
        let pending = self
            .state
            .lock()
            .map_err(|_| "reverse Frame state lock poisoned".to_string())?
            .reset();
        if let Some(pending) = pending {
            self.payload.requeue_front(pending)?;
        }
        self.payload.prepare_connection()
    }

    fn accept_inbound(&self, bytes: &[u8]) -> Result<Option<ReverseWireFrame>, String> {
        let payloads = self
            .state
            .lock()
            .map_err(|_| "reverse Frame state lock poisoned".to_string())?
            .accept_bytes(bytes, &self.service)?;
        for payload in payloads {
            if let Some(response) = self.payload.accept_inbound(&payload)? {
                self.payload.queue_outbound(response)?;
            }
        }
        self.try_pop_outbound()
    }

    fn queue_outbound(&self, frame: ReverseWireFrame) -> Result<(), String> {
        self.state
            .lock()
            .map_err(|_| "reverse Frame state lock poisoned".to_string())?
            .wire_outbound
            .push_back(frame);
        Ok(())
    }

    fn try_pop_outbound(&self) -> Result<Option<ReverseWireFrame>, String> {
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "reverse Frame state lock poisoned".to_string())?;
            if let Some(frame) = state.pop_wire()? {
                return Ok(Some(frame));
            }
            if state.has_pending() {
                return Ok(None);
            }
        }
        let Some(output) = self.payload.try_pop_outbound()? else {
            return Ok(None);
        };
        self.install_and_pop(output)
    }

    fn wait_pop_outbound(&self, timeout: Duration) -> Result<Option<ReverseWireFrame>, String> {
        if let Some(frame) = self.try_pop_outbound()? {
            return Ok(Some(frame));
        }
        let has_pending = self
            .state
            .lock()
            .map_err(|_| "reverse Frame state lock poisoned".to_string())?
            .has_pending();
        if has_pending {
            thread::sleep(timeout);
            return self.try_pop_outbound();
        }
        let Some(output) = self.payload.wait_pop_outbound(timeout)? else {
            return self.try_pop_outbound();
        };
        self.install_and_pop(output)
    }

    fn requeue_front(&self, frame: ReverseWireFrame) -> Result<(), String> {
        let Some(requeue) = frame.requeue else {
            return Ok(());
        };
        let mut state = self
            .state
            .lock()
            .map_err(|_| "reverse Frame state lock poisoned".to_string())?;
        if state
            .pending
            .as_ref()
            .is_some_and(|pending| pending.output == requeue)
        {
            state.pending = None;
        }
        drop(state);
        self.payload.requeue_front(requeue)
    }

    fn wake_outbound(&self) {
        self.payload.wake_outbound();
    }

    fn install_and_pop(
        &self,
        output: ReversePayloadFrame,
    ) -> Result<Option<ReverseWireFrame>, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "reverse Frame state lock poisoned".to_string())?;
        if state.stream_id.is_none() {
            drop(state);
            self.payload.requeue_front(output)?;
            return Ok(None);
        }
        state.install(output);
        state.pop_wire()
    }
}

#[derive(Clone)]
pub struct ReverseConnector {
    instance: InstanceName,
    paths: InstancePaths,
    config: WorkerReverseConfig,
    payload: Arc<ReverseFramePayload>,
}

impl ReverseConnector {
    pub fn new(
        instance: InstanceName,
        paths: InstancePaths,
        config: WorkerReverseConfig,
        service: String,
        payload: Arc<dyn ReversePayload>,
    ) -> Self {
        Self {
            instance,
            paths,
            config,
            payload: Arc::new(ReverseFramePayload::new(service, payload)),
        }
    }

    pub fn spawn(self) -> thread::JoinHandle<()> {
        thread::spawn(move || self.run())
    }

    fn run(mut self) {
        let client = match Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(SSE_READ_TIMEOUT)
            .build()
        {
            Ok(client) => client,
            Err(error) => {
                let _ = append_log(
                    &self.paths,
                    &format!("reverse connector client setup failed: {error}"),
                );
                return;
            }
        };
        let mut wss_failures = 0_u32;
        let mut backoff = Duration::from_secs(1);

        while !self.payload.is_stopping() {
            let generation = match self.next_generation() {
                Ok(generation) => generation,
                Err(error) => {
                    let _ = append_log(
                        &self.paths,
                        &format!("reverse generation persistence failed: {error}"),
                    );
                    return;
                }
            };
            let (transport, established, result) = if wss_failures < WSS_FAILURES_BEFORE_SSE {
                match self.connect_wss(generation) {
                    Ok(socket) => {
                        wss_failures = 0;
                        backoff = Duration::from_secs(1);
                        ("wss", true, self.run_wss(socket))
                    }
                    Err(error) => ("wss", false, Err(error)),
                }
            } else {
                ("sse", false, self.run_sse(&client, generation))
            };

            match result {
                Ok(()) => {
                    wss_failures = 0;
                    backoff = Duration::from_secs(1);
                }
                Err(error) => {
                    let _ = append_log(
                        &self.paths,
                        &format!("reverse {transport} connection ended: {error}"),
                    );
                    if transport == "wss" && !established {
                        wss_failures = wss_failures.saturating_add(1);
                    } else if transport == "sse" {
                        wss_failures = 0;
                    }
                }
            }

            if self.payload.is_stopping() {
                break;
            }
            thread::sleep(if wss_failures >= WSS_FAILURES_BEFORE_SSE {
                SSE_RETRY_AFTER
            } else {
                backoff
            });
            backoff = (backoff * 2).min(MAX_RECONNECT_BACKOFF);
        }
    }

    fn next_generation(&mut self) -> Result<u64, String> {
        let generation_file = self.paths.state_dir.join("reverse-generation");
        let persisted = match fs::read_to_string(&generation_file) {
            Ok(value) => value
                .trim()
                .parse::<u64>()
                .map_err(|error| format!("invalid {}: {error}", generation_file.display()))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
            Err(error) => {
                return Err(format!(
                    "failed to read {}: {error}",
                    generation_file.display()
                ));
            }
        };
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(u64::MAX as u128) as u64;
        let generation = next_generation_value(self.config.generation, persisted, now);
        let temporary = generation_file.with_extension("tmp");
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| format!("failed to open {}: {error}", temporary.display()))?;
        writeln!(file, "{generation}")
            .map_err(|error| format!("failed to write {}: {error}", temporary.display()))?;
        file.sync_all()
            .map_err(|error| format!("failed to sync {}: {error}", temporary.display()))?;
        fs::rename(&temporary, &generation_file)
            .map_err(|error| format!("failed to replace {}: {error}", generation_file.display()))?;
        ensure_file_mode(&generation_file, 0o600)?;
        self.config.generation = generation;
        Ok(generation)
    }
}

pub(crate) fn next_generation_value(configured: u64, persisted: u64, now: u64) -> u64 {
    configured.max(persisted).saturating_add(1).max(now)
}

pub(crate) fn reverse_endpoint(
    base: &str,
    endpoint_path: &str,
    websocket: bool,
) -> Result<Url, String> {
    let mut url = Url::parse(base).map_err(|error| format!("invalid controller URL: {error}"))?;
    let base_path = url.path().trim_end_matches('/');
    let endpoint = endpoint_path.trim_start_matches('/');
    url.set_path(&format!("{base_path}/{endpoint}"));
    url.set_query(None);
    url.set_fragment(None);
    if websocket {
        let scheme = match url.scheme() {
            "https" => "wss",
            "http" => "ws",
            "wss" => "wss",
            "ws" => "ws",
            other => return Err(format!("unsupported controller URL scheme: {other}")),
        };
        url.set_scheme(scheme)
            .map_err(|_| "failed to set websocket URL scheme".to_string())?;
    }
    Ok(url)
}
