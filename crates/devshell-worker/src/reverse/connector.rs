use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::num::NonZeroUsize;
use std::sync::{Arc, Mutex};
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
use tungstenite::{Message, connect};
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
}

impl ReverseConnector {
    pub fn new(
        instance: InstanceName,
        paths: InstancePaths,
        config: WorkerReverseConfig,
        router: Arc<RpcRouter>,
    ) -> Self {
        Self {
            instance,
            paths,
            config,
            router: Arc::clone(&router),
            dispatcher: Arc::new(ReverseDispatcher::new(router)),
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
        append_log(
            &self.paths,
            &format!("reverse connection established transport=wss generation={generation}"),
        )?;

        while !self.router.shutdown_requested() {
            match socket.read().map_err(|error| error.to_string())? {
                Message::Binary(frame) => {
                    let response = self.dispatcher.dispatch(&frame)?;
                    socket
                        .send(Message::Binary(response.into()))
                        .map_err(|error| error.to_string())?;
                }
                Message::Ping(payload) => {
                    socket
                        .send(Message::Pong(payload))
                        .map_err(|error| error.to_string())?;
                }
                Message::Close(_) => return Err("controller closed websocket".to_string()),
                Message::Text(_) => {
                    return Err("controller sent text on binary RPC websocket".to_string());
                }
                Message::Pong(_) | Message::Frame(_) => {}
            }
        }

        let _ = socket.close(None);
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

        let mut event_id: Option<u64> = None;
        let mut event_name = String::new();
        let mut data = String::new();
        let mut upstream_seq = 0_u64;
        let reader = BufReader::new(response);

        for line in reader.lines() {
            if self.router.shutdown_requested() {
                return Ok(());
            }
            let line = line.map_err(|error| format!("failed to read reverse SSE: {error}"))?;
            if line.is_empty() {
                if event_name == "frame" && !data.is_empty() {
                    let frame = BASE64
                        .decode(data.as_bytes())
                        .map_err(|error| format!("invalid reverse SSE frame: {error}"))?;
                    let response = self.dispatcher.dispatch(&frame)?;
                    upstream_seq = upstream_seq.saturating_add(1);
                    self.post_upstream(client, generation, upstream_seq, &response)?;
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

fn next_generation_value(configured: u64, persisted: u64, now: u64) -> u64 {
    configured.max(persisted).saturating_add(1).max(now)
}

struct ReverseDispatcher {
    router: Arc<RpcRouter>,
    completed: Mutex<LruCache<String, Vec<u8>>>,
}

impl ReverseDispatcher {
    fn new(router: Arc<RpcRouter>) -> Self {
        Self {
            router,
            completed: Mutex::new(LruCache::new(
                NonZeroUsize::new(REQUEST_CACHE_SIZE).expect("request cache size must be non-zero"),
            )),
        }
    }

    fn dispatch(&self, frame: &[u8]) -> Result<Vec<u8>, String> {
        let request = match decode_request_frame(frame) {
            Ok(request) => request,
            Err(error) => {
                return encode_json(&RpcResponse::failure(error.id, error.error));
            }
        };
        let key = request_cache_key(&request.id, frame);
        if let Some(cached) = self
            .completed
            .lock()
            .map_err(|_| "reverse request cache lock poisoned".to_string())?
            .get(&key)
            .cloned()
        {
            return Ok(cached);
        }

        let response = if self.router.is_control_method(&request.method) {
            self.router.dispatch_control(request)
        } else {
            match self.router.acquire_tool_permit() {
                Ok(permit) => self.router.dispatch_tool(request, permit),
                Err(error) => RpcResponse::failure(request.id, error),
            }
        };
        let encoded = encode_json(&response)?;
        self.completed
            .lock()
            .map_err(|_| "reverse request cache lock poisoned".to_string())?
            .put(key, encoded.clone());
        Ok(encoded)
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
    use super::{next_generation_value, request_cache_key, reverse_endpoint};

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
}
