pub(crate) mod proxy;
mod service;
mod sse;
mod websocket;

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::blocking::Client;
use url::Url;

use crate::daemon::log::append_log;
use crate::instance::storage::InstancePaths;
use crate::instance::storage::ensure_file_mode;
use crate::instance::{InstanceName, WorkerReverseConfig};
use service::ReverseFramePayload;

const WSS_FAILURES_BEFORE_SSE: u32 = 3;
const MAX_RECONNECT_BACKOFF: Duration = Duration::from_secs(30);
const SSE_RETRY_AFTER: Duration = Duration::from_secs(5);
const SSE_READ_TIMEOUT: Duration = Duration::from_secs(45);

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
        transport_socket: PathBuf,
        payload: Arc<dyn ReversePayload>,
    ) -> Self {
        Self {
            instance,
            paths,
            config,
            payload: Arc::new(ReverseFramePayload::new(transport_socket, payload)),
        }
    }

    pub fn spawn(self) -> thread::JoinHandle<()> {
        thread::spawn(move || self.run())
    }

    fn run(mut self) {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(SSE_READ_TIMEOUT);
        let client = match proxy::apply_http_client_proxy(client, self.config.proxy_url.as_deref())
            .and_then(|builder| {
                builder
                    .build()
                    .map_err(|error| format!("failed to build reverse HTTP client: {error}"))
            }) {
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
