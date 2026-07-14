use std::collections::{HashSet, VecDeque};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::num::NonZeroUsize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use lru::LruCache;
use reqwest::blocking::Client;
use reqwest::header::{AUTHORIZATION, CACHE_CONTROL};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tungstenite::client::IntoClientRequest;
use tungstenite::http::HeaderValue;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Error as WebSocketError, Message, WebSocket, connect};
use url::Url;

use crate::daemon::log_writer::append_log;
use crate::instance::{InstanceName, WorkerReverseConfig};
use crate::rpc::codec::{decode_request_frame, encode_json};
use crate::rpc::response::RpcResponse;
use crate::rpc::router::RpcRouter;
use crate::storage::InstancePaths;
use crate::storage::permissions::ensure_file_mode;

const WSS_FAILURES_BEFORE_SSE: u32 = 3;
const MAX_RECONNECT_BACKOFF: Duration = Duration::from_secs(30);
const SSE_RETRY_AFTER: Duration = Duration::from_secs(5);
const REQUEST_CACHE_SIZE: usize = 1024;

#[derive(Clone)]
pub struct ReverseConnector {
    instance: InstanceName,
    paths: InstancePaths,
    config: WorkerReverseConfig,
    router: Arc<RpcRouter>,
    dispatcher: Arc<ReverseDispatcher>,
    responses: Arc<ReverseResponseQueue>,
}

impl ReverseConnector {
    pub fn new(
        instance: InstanceName,
        paths: InstancePaths,
        config: WorkerReverseConfig,
        router: Arc<RpcRouter>,
    ) -> Self {
        let responses = Arc::new(ReverseResponseQueue::default());
        Self {
            instance,
            paths,
            config,
            router: Arc::clone(&router),
            dispatcher: Arc::new(ReverseDispatcher::new(router, Arc::clone(&responses))),
            responses,
        }
    }

    pub fn spawn(self) -> thread::JoinHandle<()> {
        thread::spawn(move || self.run())
    }

    fn run(mut self) {
        let client = match Client::builder()
            .connect_timeout(Duration::from_secs(15))
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

        while !self.router.shutdown_requested() {
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
            let result = if wss_failures < WSS_FAILURES_BEFORE_SSE {
                self.run_wss(generation)
            } else {
                self.run_sse(&client, generation)
            };

            match result {
                Ok(()) => {
                    wss_failures = 0;
                    backoff = Duration::from_secs(1);
                }
                Err(error) => {
                    let transport = if wss_failures < WSS_FAILURES_BEFORE_SSE {
                        "wss"
                    } else {
                        "sse"
                    };
                    let _ = append_log(
                        &self.paths,
                        &format!("reverse {transport} connection ended: {error}"),
                    );
                    if transport == "wss" {
                        wss_failures = wss_failures.saturating_add(1);
                    } else {
                        wss_failures = 0;
                    }
                }
            }

            if self.router.shutdown_requested() {
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

    fn run_wss(&self, generation: u64) -> Result<(), String> {
        let endpoint = reverse_endpoint(&self.config.controller_url, "/reverse/v1/connect", true)?;
        let mut request = endpoint
            .as_str()
            .into_client_request()
            .map_err(|error| format!("failed to build websocket request: {error}"))?;
        let headers = request.headers_mut();
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", self.config.device_token))
                .map_err(|error| error.to_string())?,
        );
        headers.insert(
            "x-devshell-instance",
            HeaderValue::from_str(self.instance.as_str()).map_err(|error| error.to_string())?,
        );
        headers.insert(
            "x-devshell-generation",
            HeaderValue::from_str(&generation.to_string()).map_err(|error| error.to_string())?,
        );
        headers.insert(
            "sec-websocket-protocol",
            HeaderValue::from_static("devshell-worker-rpc.v1"),
        );

        let (mut socket, _) = connect(request)
            .map_err(|error| format!("failed to connect reverse websocket: {error}"))?;
        set_websocket_read_timeout(&mut socket, Some(Duration::from_millis(50)))?;
        append_log(
            &self.paths,
            &format!("reverse connection established transport=wss generation={generation}"),
        )?;

        while !self.router.shutdown_requested() {
            self.flush_wss_responses(&mut socket)?;
            match socket.read() {
                Ok(Message::Binary(frame)) => {
                    if let Some(response) = self.dispatcher.dispatch(&frame)?
                        && let Err(error) =
                            socket.send(Message::Binary(response.frame.clone().into()))
                    {
                        self.responses.push_front(response)?;
                        return Err(error.to_string());
                    }
                }
                Ok(Message::Ping(payload)) => {
                    socket
                        .send(Message::Pong(payload))
                        .map_err(|error| error.to_string())?;
                }
                Ok(Message::Close(_)) => return Err("controller closed websocket".to_string()),
                Ok(Message::Text(_)) => {
                    return Err("controller sent text on binary RPC websocket".to_string());
                }
                Ok(Message::Pong(_) | Message::Frame(_)) => {}
                Err(WebSocketError::Io(error))
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) => {}
                Err(error) => return Err(error.to_string()),
            }
        }

        let _ = socket.close(None);
        Ok(())
    }

    fn flush_wss_responses(
        &self,
        socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    ) -> Result<(), String> {
        while let Some(response) = self.responses.try_pop()? {
            if let Err(error) = socket.send(Message::Binary(response.frame.clone().into())) {
                self.responses.push_front(response)?;
                return Err(error.to_string());
            }
        }
        Ok(())
    }

    fn run_sse(&self, client: &Client, generation: u64) -> Result<(), String> {
        let endpoint = reverse_endpoint(&self.config.controller_url, "/reverse/v1/events", false)?;
        let response = client
            .get(endpoint)
            .header(
                AUTHORIZATION,
                format!("Bearer {}", self.config.device_token),
            )
            .header("x-devshell-instance", self.instance.as_str())
            .header("x-devshell-generation", generation.to_string())
            .header(CACHE_CONTROL, "no-cache")
            .send()
            .map_err(|error| format!("failed to connect reverse SSE: {error}"))?
            .error_for_status()
            .map_err(|error| format!("reverse SSE rejected: {error}"))?;

        append_log(
            &self.paths,
            &format!("reverse connection established transport=sse generation={generation}"),
        )?;

        let upload_error = Arc::new(Mutex::new(None));
        let uploader = SseUploader::spawn(
            self.clone(),
            client.clone(),
            generation,
            Arc::clone(&upload_error),
        );
        let mut event_id: Option<u64> = None;
        let mut event_name = String::new();
        let mut data = String::new();
        let reader = BufReader::new(response);

        for line in reader.lines() {
            if self.router.shutdown_requested() {
                return Ok(());
            }
            if let Some(error) = take_upload_error(&upload_error)? {
                return Err(error);
            }
            let line = line.map_err(|error| format!("failed to read reverse SSE: {error}"))?;
            if line.is_empty() {
                if event_name == "frame" && !data.is_empty() {
                    let frame = BASE64
                        .decode(data.as_bytes())
                        .map_err(|error| format!("invalid reverse SSE frame: {error}"))?;
                    if let Some(response) = self.dispatcher.dispatch(&frame)? {
                        self.responses.push_back(response)?;
                    }
                }
                event_id = None;
                event_name.clear();
                data.clear();
                continue;
            }
            if line.starts_with(':') {
                continue;
            }
            if let Some(value) = line.strip_prefix("id:") {
                event_id = value.trim().parse::<u64>().ok();
            } else if let Some(value) = line.strip_prefix("event:") {
                event_name = value.trim().to_string();
            } else if let Some(value) = line.strip_prefix("data:") {
                if !data.is_empty() {
                    data.push('\n');
                }
                data.push_str(value.trim());
            }
            let _ = event_id;
        }

        drop(uploader);
        if let Some(error) = take_upload_error(&upload_error)? {
            return Err(error);
        }
        Err("reverse SSE stream ended".to_string())
    }

    fn post_upstream(
        &self,
        client: &Client,
        generation: u64,
        seq: u64,
        frame: &[u8],
    ) -> Result<(), String> {
        let endpoint = reverse_endpoint(&self.config.controller_url, "/reverse/v1/frames", false)?;
        let body = UpstreamBatch {
            generation,
            frames: vec![UpstreamFrame {
                seq,
                frame: BASE64.encode(frame),
            }],
        };
        let response = client
            .post(endpoint)
            .timeout(Duration::from_secs(30))
            .header(
                AUTHORIZATION,
                format!("Bearer {}", self.config.device_token),
            )
            .header("x-devshell-instance", self.instance.as_str())
            .header("x-devshell-generation", generation.to_string())
            .json(&body)
            .send()
            .map_err(|error| format!("failed to upload reverse frame: {error}"))?
            .error_for_status()
            .map_err(|error| format!("reverse frame upload rejected: {error}"))?
            .json::<UpstreamAck>()
            .map_err(|error| format!("invalid reverse frame acknowledgement: {error}"))?;
        if response.generation != generation || response.accepted_through < seq {
            return Err(
                "reverse frame acknowledgement did not accept the uploaded frame".to_string(),
            );
        }
        Ok(())
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

struct SseUploader {
    handle: Option<thread::JoinHandle<()>>,
    responses: Arc<ReverseResponseQueue>,
    running: Arc<AtomicBool>,
}

impl SseUploader {
    fn spawn(
        connector: ReverseConnector,
        client: Client,
        generation: u64,
        upload_error: Arc<Mutex<Option<String>>>,
    ) -> Self {
        let running = Arc::new(AtomicBool::new(true));
        let responses = Arc::clone(&connector.responses);
        let thread_running = Arc::clone(&running);
        let thread_responses = Arc::clone(&responses);
        let handle = thread::spawn(move || {
            let mut upstream_seq = 0_u64;
            while thread_running.load(Ordering::SeqCst) && !connector.router.shutdown_requested() {
                let response = match thread_responses.wait_pop(Duration::from_millis(100)) {
                    Ok(Some(response)) => response,
                    Ok(None) => continue,
                    Err(error) => {
                        set_upload_error(&upload_error, error);
                        return;
                    }
                };
                upstream_seq = upstream_seq.saturating_add(1);
                if let Err(error) =
                    connector.post_upstream(&client, generation, upstream_seq, &response.frame)
                {
                    let _ = thread_responses.push_front(response);
                    set_upload_error(&upload_error, error);
                    return;
                }
            }
        });
        Self {
            handle: Some(handle),
            responses,
            running,
        }
    }
}

impl Drop for SseUploader {
    fn drop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
        self.responses.wake();
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

fn set_upload_error(upload_error: &Mutex<Option<String>>, error: String) {
    if let Ok(mut current) = upload_error.lock() {
        *current = Some(error);
    }
}

fn take_upload_error(upload_error: &Mutex<Option<String>>) -> Result<Option<String>, String> {
    Ok(upload_error
        .lock()
        .map_err(|_| "reverse upload error lock poisoned".to_string())?
        .take())
}

fn set_websocket_read_timeout(
    socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    timeout: Option<Duration>,
) -> Result<(), String> {
    match socket.get_mut() {
        MaybeTlsStream::Plain(stream) => stream
            .set_read_timeout(timeout)
            .map_err(|error| format!("failed to configure websocket read timeout: {error}")),
        MaybeTlsStream::Rustls(stream) => stream
            .sock
            .set_read_timeout(timeout)
            .map_err(|error| format!("failed to configure websocket read timeout: {error}")),
        _ => Ok(()),
    }
}

fn next_generation_value(configured: u64, persisted: u64, now: u64) -> u64 {
    configured.max(persisted).saturating_add(1).max(now)
}

#[derive(Clone)]
struct ReverseOutboundResponse {
    key: Option<String>,
    frame: Vec<u8>,
}

#[derive(Default)]
struct ReverseResponseQueue {
    ready: Condvar,
    responses: Mutex<VecDeque<ReverseOutboundResponse>>,
}

impl ReverseResponseQueue {
    fn push_back(&self, response: ReverseOutboundResponse) -> Result<(), String> {
        self.responses
            .lock()
            .map_err(|_| "reverse response queue lock poisoned".to_string())?
            .push_back(response);
        self.ready.notify_one();
        Ok(())
    }

    fn push_front(&self, response: ReverseOutboundResponse) -> Result<(), String> {
        self.responses
            .lock()
            .map_err(|_| "reverse response queue lock poisoned".to_string())?
            .push_front(response);
        self.ready.notify_one();
        Ok(())
    }

    fn try_pop(&self) -> Result<Option<ReverseOutboundResponse>, String> {
        Ok(self
            .responses
            .lock()
            .map_err(|_| "reverse response queue lock poisoned".to_string())?
            .pop_front())
    }

    fn wait_pop(&self, timeout: Duration) -> Result<Option<ReverseOutboundResponse>, String> {
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

    fn remove_key(&self, key: &str) -> Result<(), String> {
        let mut responses = self
            .responses
            .lock()
            .map_err(|_| "reverse response queue lock poisoned".to_string())?;
        responses.retain(|response| response.key.as_deref() != Some(key));
        Ok(())
    }

    fn wake(&self) {
        self.ready.notify_all();
    }
}

struct ReverseDispatcher {
    router: Arc<RpcRouter>,
    completed: Mutex<LruCache<String, Vec<u8>>>,
    in_flight: Mutex<HashSet<String>>,
    responses: Arc<ReverseResponseQueue>,
}

impl ReverseDispatcher {
    fn new(router: Arc<RpcRouter>, responses: Arc<ReverseResponseQueue>) -> Self {
        Self {
            router,
            completed: Mutex::new(LruCache::new(
                NonZeroUsize::new(REQUEST_CACHE_SIZE).expect("request cache size must be non-zero"),
            )),
            in_flight: Mutex::new(HashSet::new()),
            responses,
        }
    }

    fn dispatch(self: &Arc<Self>, frame: &[u8]) -> Result<Option<ReverseOutboundResponse>, String> {
        let request = match decode_request_frame(frame) {
            Ok(request) => request,
            Err(error) => {
                return encode_json(&RpcResponse::failure(error.id, error.error))
                    .map(|frame| Some(ReverseOutboundResponse { key: None, frame }));
            }
        };
        let key = request_cache_key(&request.id, frame);
        if self
            .in_flight
            .lock()
            .map_err(|_| "reverse in-flight request lock poisoned".to_string())?
            .contains(&key)
        {
            return Ok(None);
        }
        if let Some(cached) = self
            .completed
            .lock()
            .map_err(|_| "reverse request cache lock poisoned".to_string())?
            .get(&key)
            .cloned()
        {
            self.responses.remove_key(&key)?;
            return Ok(Some(ReverseOutboundResponse {
                key: Some(key),
                frame: cached,
            }));
        }

        if self.router.is_control_method(&request.method) {
            let response = self.router.dispatch_control(request);
            let encoded = encode_json(&response)?;
            self.completed
                .lock()
                .map_err(|_| "reverse request cache lock poisoned".to_string())?
                .put(key.clone(), encoded.clone());
            return Ok(Some(ReverseOutboundResponse {
                key: Some(key),
                frame: encoded,
            }));
        }

        {
            let mut in_flight = self
                .in_flight
                .lock()
                .map_err(|_| "reverse in-flight request lock poisoned".to_string())?;
            if !in_flight.insert(key.clone()) {
                return Ok(None);
            }
        }

        let permit = match self.router.acquire_tool_permit(&request) {
            Ok(permit) => permit,
            Err(error) => {
                self.in_flight
                    .lock()
                    .map_err(|_| "reverse in-flight request lock poisoned".to_string())?
                    .remove(&key);
                let response = RpcResponse::failure(request.id, error);
                let encoded = encode_json(&response)?;
                self.completed
                    .lock()
                    .map_err(|_| "reverse request cache lock poisoned".to_string())?
                    .put(key.clone(), encoded.clone());
                return Ok(Some(ReverseOutboundResponse {
                    key: Some(key),
                    frame: encoded,
                }));
            }
        };

        let dispatcher = Arc::clone(self);
        thread::spawn(move || {
            let response = dispatcher.router.dispatch_tool(request, permit);
            let encoded =
                encode_json(&response).expect("serializing a reverse RPC response should not fail");
            if let Ok(mut completed) = dispatcher.completed.lock() {
                completed.put(key.clone(), encoded.clone());
            }
            let _ = dispatcher.responses.push_back(ReverseOutboundResponse {
                key: Some(key.clone()),
                frame: encoded,
            });
            if let Ok(mut in_flight) = dispatcher.in_flight.lock() {
                in_flight.remove(&key);
            }
        });
        Ok(None)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpstreamBatch {
    generation: u64,
    frames: Vec<UpstreamFrame>,
}

#[derive(Serialize)]
struct UpstreamFrame {
    seq: u64,
    frame: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpstreamAck {
    accepted_through: u64,
    generation: u64,
}

fn request_cache_key(request_id: &str, frame: &[u8]) -> String {
    let digest = Sha256::digest(frame);
    format!("{request_id}:{}", hex(&digest))
}

fn reverse_endpoint(base: &str, endpoint_path: &str, websocket: bool) -> Result<Url, String> {
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

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(DIGITS[(byte >> 4) as usize] as char);
        output.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    output
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::thread;
    use std::time::Duration;

    use serde_json::json;

    use super::{
        ReverseDispatcher, ReverseResponseQueue, next_generation_value, request_cache_key,
        reverse_endpoint,
    };
    use crate::daemon::process::{PlatformInfo, WorkerRuntimeContext};
    use crate::instance::config::WorkerToolsConfig;
    use crate::instance::{InstanceName, WorkerConfig};
    use crate::rpc::codec::{decode_json, encode_json};
    use crate::rpc::request::RpcRequest;
    use crate::rpc::response::RpcResponse;
    use crate::rpc::router::RpcRouter;
    use crate::security::SecurityMode;
    use crate::tools::artifact::payload::ArtifactPayloadStore;
    use crate::tools::artifact::receive::ArtifactReceiveStore;
    use crate::tools::artifact::store::ArtifactStore;
    use crate::tools::file::FileToolState;
    use crate::tools::{
        ToolCall, ToolCapability, ToolCatalogEntry, ToolError, ToolHandler, ToolName, ToolRegistry,
    };

    struct CancellableWaitTool {
        name: ToolName,
        started: Arc<AtomicBool>,
    }

    impl ToolHandler for CancellableWaitTool {
        fn name(&self) -> &ToolName {
            &self.name
        }

        fn catalog_entry(&self) -> ToolCatalogEntry {
            ToolCatalogEntry {
                group: "test".to_string(),
                name: "test_wait".to_string(),
                description: "Wait until cancelled.".to_string(),
                input_schema: json!({ "type": "object" }),
                output_schema: json!({ "type": "object" }),
                required_capabilities: vec![ToolCapability::Execute],
            }
        }

        fn call(&self, call: ToolCall) -> Result<serde_json::Value, ToolError> {
            self.started.store(true, Ordering::SeqCst);
            loop {
                call.check_cancelled()?;
                thread::sleep(Duration::from_millis(5));
            }
        }
    }

    #[test]
    fn endpoint_preserves_public_base_path() {
        assert_eq!(
            reverse_endpoint("https://example.test/base", "/reverse/v1/connect", true)
                .unwrap()
                .as_str(),
            "wss://example.test/base/reverse/v1/connect"
        );
    }

    #[test]
    fn cache_key_changes_when_request_payload_changes() {
        assert_ne!(request_cache_key("1", b"a"), request_cache_key("1", b"b"));
    }

    #[test]
    fn generation_remains_monotonic_when_the_clock_moves_backwards() {
        assert_eq!(next_generation_value(150, 200, 100), 201);
        assert_eq!(next_generation_value(0, 0, 500), 500);
    }

    #[test]
    fn reverse_dispatcher_accepts_cancel_while_a_tool_is_running() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let instance = InstanceName::parse("reverse-cancel").unwrap();
        let started = Arc::new(AtomicBool::new(false));
        let mut registry = ToolRegistry::new();
        registry
            .register(Arc::new(CancellableWaitTool {
                name: ToolName::parse("test_wait").unwrap(),
                started: Arc::clone(&started),
            }))
            .unwrap();
        let artifacts = ArtifactStore::new(root.path().join("artifacts")).unwrap();
        let payloads = ArtifactPayloadStore::new(root.path().join("payloads"), artifacts).unwrap();
        let receives = ArtifactReceiveStore::new(root.path().join("receives")).unwrap();
        let router = Arc::new(RpcRouter::new(
            WorkerConfig {
                version: 1,
                instance: instance.as_str().to_string(),
                created_at: 1,
                tools: WorkerToolsConfig::default(),
                reverse: None,
            },
            WorkerRuntimeContext {
                instance,
                workspace,
                platform: PlatformInfo {
                    os: std::env::consts::OS,
                    arch: std::env::consts::ARCH,
                },
                security_mode: SecurityMode::Disabled,
                worker_sha256: Some("0".repeat(64)),
            },
            Arc::new(registry),
            FileToolState::new(),
            payloads,
            receives,
            #[cfg(unix)]
            None,
        ));
        let responses = Arc::new(ReverseResponseQueue::default());
        let dispatcher = Arc::new(ReverseDispatcher::new(router, Arc::clone(&responses)));

        let run_request: RpcRequest = serde_json::from_value(json!({
            "type": "request",
            "id": "long-tool",
            "method": "test_wait",
            "params": {},
            "context": {
                "requestId": "mcp-long-tool",
                "sessionId": "reverse-session",
                "source": "mcp"
            }
        }))
        .unwrap();
        let run = encode_json(&run_request).unwrap();
        let immediate = dispatcher.dispatch(&run).unwrap();
        if let Some(response) = immediate {
            let value: RpcResponse = decode_json(&response.frame).unwrap();
            panic!("expected asynchronous dispatch, got {value:?}");
        }
        assert!(dispatcher.dispatch(&run).unwrap().is_none());
        for _ in 0..100 {
            if started.load(Ordering::SeqCst) {
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
        assert!(started.load(Ordering::SeqCst));

        let cancel_request: RpcRequest = serde_json::from_value(json!({
            "type": "request",
            "id": "cancel-control",
            "method": "tool.call.cancel",
            "params": {
                "reason": "client timeout",
                "rpcRequestId": "long-tool",
                "sessionId": "reverse-session"
            }
        }))
        .unwrap();
        let cancel = encode_json(&cancel_request).unwrap();
        let cancel_response = dispatcher.dispatch(&cancel).unwrap().unwrap();
        let cancel_response: RpcResponse = decode_json(&cancel_response.frame).unwrap();
        let cancel_json = serde_json::to_value(&cancel_response).unwrap();
        assert_eq!(cancel_json["result"]["cancelled"], true, "{cancel_json}");

        let tool_response = responses
            .wait_pop(Duration::from_secs(2))
            .unwrap()
            .expect("cancelled tool response");
        let tool_response: RpcResponse = decode_json(&tool_response.frame).unwrap();
        let tool_json = serde_json::to_value(&tool_response).unwrap();
        assert_eq!(tool_json["id"], "long-tool", "{tool_json}");
        assert_eq!(tool_json["error"]["code"], "tool.cancelled", "{tool_json}");
        assert!(responses.try_pop().unwrap().is_none());
    }
}
