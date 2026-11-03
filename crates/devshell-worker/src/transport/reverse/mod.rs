mod bridge;
pub(crate) mod proxy;
mod sse;
pub(crate) mod state;
mod websocket;

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use reqwest::blocking::Client;
use url::Url;

use crate::capability::rpc::router::RpcRouter;
use crate::daemon::log::append_log;
use crate::instance::storage::InstancePaths;
use crate::instance::storage::ensure_file_mode;
use crate::instance::{InstanceLock, InstanceName, WorkerReverseConfig, read_config};
use bridge::ReverseBridge;

const WSS_FAILURES_BEFORE_SSE: u32 = 3;
const MAX_RECONNECT_BACKOFF: Duration = Duration::from_secs(30);
const SSE_RETRY_AFTER: Duration = Duration::from_secs(5);
const SSE_READ_TIMEOUT: Duration = Duration::from_secs(45);
const UPGRADE_READY_TIMEOUT: Duration = Duration::from_secs(135);

#[derive(Clone)]
pub struct ReverseConnector {
    instance: InstanceName,
    paths: InstancePaths,
    config: WorkerReverseConfig,
    bridge: Arc<ReverseBridge>,
    reconnect_requested: Arc<AtomicBool>,
}

impl ReverseConnector {
    pub fn new(
        instance: InstanceName,
        paths: InstancePaths,
        config: WorkerReverseConfig,
        transport_endpoint: PathBuf,
        router: Arc<RpcRouter>,
        reconnect_requested: Arc<AtomicBool>,
    ) -> Self {
        Self {
            instance,
            paths,
            config,
            bridge: Arc::new(ReverseBridge::new(transport_endpoint, router)),
            reconnect_requested,
        }
    }

    pub fn spawn(self) -> thread::JoinHandle<()> {
        thread::spawn(move || self.run())
    }

    fn run(mut self) {
        let mut client_setup = build_http_client(&self.config);
        let mut wss_failures = 0_u32;
        let mut backoff = Duration::from_secs(1);

        while !self.bridge.is_stopping() {
            let attempt_started = Instant::now();
            let generation = match self.next_generation() {
                Ok(generation) => generation,
                Err(error) => {
                    let _ = append_log(
                        &self.paths,
                        &format!("reverse generation persistence failed: {error}"),
                    );
                    let _ = state::write(&self.paths, "reconnecting", None, Some(&error));
                    thread::sleep(backoff);
                    backoff = (backoff * 2).min(MAX_RECONNECT_BACKOFF);
                    continue;
                }
            };
            let client = match &client_setup {
                Ok(client) => client,
                Err(error) => {
                    let _ = append_log(
                        &self.paths,
                        &format!("reverse connector client setup failed: {error}"),
                    );
                    // Initialization failures own a fresh generation too. Keep
                    // the connector alive so each explicit start can observe a
                    // new failure instead of waiting forever on an old one.
                    let _ = state::write_connection(
                        &self.paths,
                        generation,
                        "failed",
                        None,
                        Some(error),
                    );
                    if !self.wait_for_reconnect() {
                        return;
                    }
                    // Only a failed initialization reloads configuration on an
                    // explicit retry, allowing the user to repair it in place.
                    client_setup = read_config(&self.paths, &self.instance).and_then(|config| {
                        let mut reverse = config.reverse.ok_or("Reverse configuration removed")?;
                        reverse.generation = self.config.generation;
                        self.config = reverse;
                        build_http_client(&self.config)
                    });
                    continue;
                }
            };
            // Invalidate the previous Ready before attempting a new physical connection.
            let _ = state::write(&self.paths, "connecting", None, None);
            let (transport, established, result) = if wss_failures < WSS_FAILURES_BEFORE_SSE {
                match self.connect_wss(generation) {
                    Ok((socket, protocol)) => ("wss", true, self.run_wss(socket, protocol)),
                    Err(error) => ("wss", false, Err(error)),
                }
            } else {
                ("sse", false, self.run_sse(client, generation))
            };

            match result {
                // Keep a terminal Control failure visible until an explicit
                // reconnect. The daemon stays usable and can recover without
                // stopping its tools or launching another connector thread.
                Ok(()) => {
                    if !self.wait_for_reconnect() {
                        return;
                    }
                    continue;
                }
                Err(error) => {
                    let _ = append_log(
                        &self.paths,
                        &format!("reverse {transport} connection ended: {error}"),
                    );
                    let _ =
                        state::write(&self.paths, "reconnecting", Some(transport), Some(&error));
                    if transport == "wss"
                        && (!established
                            || attempt_started.elapsed() < Duration::from_secs(5)
                            || error.contains(websocket::HEARTBEAT_TIMEOUT_ERROR)
                            || error == "reverse Ready timed out")
                    {
                        wss_failures = wss_failures.saturating_add(1);
                    } else if transport == "wss" {
                        wss_failures = 0;
                    } else if transport == "sse" {
                        wss_failures = 0;
                    }
                }
            }

            if self.bridge.is_stopping() {
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

    fn wait_for_reconnect(&self) -> bool {
        while !self.bridge.is_stopping()
            && !self
                .reconnect_requested
                .load(std::sync::atomic::Ordering::SeqCst)
        {
            thread::sleep(Duration::from_millis(200));
        }
        !self.bridge.is_stopping()
    }

    /// Control progress belongs to this physical connection, never to a
    /// generation read later from disk. Failed admission waits for an explicit
    /// start to request another attempt without stopping the daemon.
    fn accept_control_state(&self, transport: &str, data: &str) -> Result<bool, String> {
        #[derive(serde::Deserialize)]
        struct ControlState {
            state: String,
            message: Option<String>,
        }
        let signal: ControlState = serde_json::from_str(data)
            .map_err(|error| format!("invalid reverse Control state: {error}"))?;
        if !matches!(signal.state.as_str(), "upgrading" | "failed") {
            return Err("unknown reverse Control state".to_string());
        }
        state::write_connection(
            &self.paths,
            self.config.generation,
            &signal.state,
            Some(transport),
            signal.message.as_deref(),
        )?;
        Ok(signal.state == "failed")
    }

    fn next_generation(&mut self) -> Result<u64, String> {
        // Serialize generation changes with reconnect requests and the helper's
        // PID/generation check, including its stop/spawn/rollback interval.
        let _lock = InstanceLock::acquire(&self.paths)?;
        self.reconnect_requested
            .store(false, std::sync::atomic::Ordering::SeqCst);
        let generation_file = self.paths.state_dir.join("reverse-generation");
        let persisted = match fs::read_to_string(&generation_file) {
            Ok(value) => value.trim().parse::<u64>().map_err(|error| {
                format!(
                    "invalid reverse generation file {}: {error}",
                    generation_file.display()
                )
            })?,
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
        let previous = self.config.generation.max(persisted);
        if previous == u64::MAX {
            return Err("reverse generation exhausted".to_string());
        }
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

fn build_http_client(config: &WorkerReverseConfig) -> Result<Client, String> {
    let builder = Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(SSE_READ_TIMEOUT);
    proxy::apply_http_client_proxy(builder, config.proxy_url.as_deref())?
        .build()
        .map_err(|error| format!("failed to build reverse HTTP client: {error}"))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capability::artifact::payload::ArtifactPayloadStore;
    use crate::capability::artifact::receive::ArtifactReceiveStore;
    use crate::capability::artifact::store::ArtifactStore;
    use crate::capability::rpc::request::RpcRequest;
    use crate::instance::runtime::{PlatformInfo, WorkerRuntimeContext};
    use crate::instance::sandbox::SecurityMode;
    use crate::instance::storage::ExtensionResourceStore;
    use crate::instance::{build_config, write_config};
    use crate::tool::ToolRegistry;
    use std::sync::atomic::Ordering;

    #[test]
    fn initialization_failure_keeps_connector_alive_for_fresh_failures_and_config_repair() {
        let root = crate::testing::temp_dir();
        let instance = InstanceName::parse("reverse-init-fixture").unwrap();
        let state_dir = root.path().join("state");
        let logs_dir = root.path().join("logs");
        fs::create_dir_all(&state_dir).unwrap();
        fs::create_dir_all(&logs_dir).unwrap();
        let paths = InstancePaths {
            instance_root: root.path().to_path_buf(),
            artifacts_dir: root.path().join("artifacts"),
            config_file: root.path().join("config.toml"),
            log_file: logs_dir.join("worker.log"),
            pid_file: state_dir.join("worker.pid"),
            lock_file: state_dir.join("worker.lock"),
            daemon_lock_file: state_dir.join("worker-daemon.lock"),
            state_dir,
            logs_dir,
        };
        let mut config = build_config(&instance).unwrap();
        config.reverse = Some(WorkerReverseConfig {
            controller_url: "http://127.0.0.1:1".into(),
            device_token: "fixture-token".into(),
            generation: 0,
            proxy_url: Some("https://127.0.0.1:8443".into()),
        });
        write_config(&paths, &config).unwrap();
        let artifacts = ArtifactStore::new(paths.artifacts_dir.clone()).unwrap();
        let payloads = ArtifactPayloadStore::new(root.path().join("payloads"), artifacts).unwrap();
        let receives = ArtifactReceiveStore::new(root.path().join("receives")).unwrap();
        let runtime = WorkerRuntimeContext {
            instance: instance.clone(),
            platform: PlatformInfo {
                os: std::env::consts::OS,
                arch: std::env::consts::ARCH,
            },
            security_mode: SecurityMode::Disabled,
            worker_sha256: None,
        };
        let router = Arc::new(RpcRouter::new(
            config.clone(),
            runtime,
            Arc::new(ToolRegistry::new()),
            payloads,
            receives,
            Arc::new(ExtensionResourceStore::new(root.path().join("resources"))),
        ));
        let signal = router.reverse_reconnect_signal();
        let connector = ReverseConnector::new(
            instance,
            paths.clone(),
            config.reverse.clone().unwrap(),
            root.path().join("unused.sock"),
            Arc::clone(&router),
            Arc::clone(&signal),
        )
        .spawn();
        let observe = |baseline, expected: &str| {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                assert!(
                    !connector.is_finished(),
                    "connector exited after initialization failure"
                );
                if let Some(status) = state::read(&paths) {
                    if status.generation > baseline && status.state == expected {
                        assert_eq!(status.pid, std::process::id());
                        return status;
                    }
                }
                assert!(
                    Instant::now() < deadline,
                    "no fresh {expected}: {:?}",
                    state::read(&paths)
                );
                thread::sleep(Duration::from_millis(10));
            }
        };
        // No IPC listener is needed: exercise the real connector, persistence,
        // lifecycle lock and the same reconnect signal consumed by the RPC.
        let first = observe(0, "failed");
        assert!(
            first
                .last_error
                .unwrap()
                .contains("unsupported reverse proxy URL scheme: https")
        );
        let reconnect = || {
            let _lock = InstanceLock::acquire(&paths).unwrap();
            let baseline = state::generation(&paths);
            signal.store(true, Ordering::SeqCst);
            baseline
        };
        let second = observe(reconnect(), "failed");
        assert!(second.generation > first.generation);
        assert!(
            second
                .last_error
                .unwrap()
                .contains("unsupported reverse proxy URL scheme: https")
        );
        config.reverse.as_mut().unwrap().proxy_url = None;
        write_config(&paths, &config).unwrap();
        let recovered = observe(reconnect(), "reconnecting");
        assert!(
            recovered
                .last_error
                .unwrap()
                .contains("failed to connect reverse connection")
        );
        // The repaired, ordinary-offline connector retries without another
        // explicit signal and never turns an offline attempt into Failed.
        observe(recovered.generation, "reconnecting");
        router.dispatch_control(RpcRequest::request(
            "stop-fixture",
            "worker.stop",
            serde_json::json!({}),
        ));
        connector.join().unwrap();
    }
}
