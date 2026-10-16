use std::thread;
use std::time::{Duration, Instant};

use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use url::Url;

use crate::capability::rpc::path::protocol_path;
use crate::daemon::process::{self, DaemonState};
use crate::host::lifecycle::install::{install_current_binary, start_installed_worker};
use crate::instance::storage::InstancePaths;
use crate::instance::storage::ensure_dir;
use crate::instance::{
    InstanceLock, InstanceName, WorkerReverseConfig, build_config, read_config, write_config,
};
use crate::transport::reverse::proxy::{apply_http_client_proxy, validate_proxy_url};
use crate::transport::reverse::state;

#[derive(Clone, Debug)]
pub struct EnrollOptions {
    pub controller: String,
    pub device_code: String,
    pub proxy_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EnrollmentRequest<'a> {
    arch: &'a str,
    device_code: &'a str,
    os: &'a str,
    worker_version: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnrollmentResponse {
    controller_url: String,
    device_token: String,
    instance: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EnrollResult {
    instance: String,
    installed_binary: String,
    ok: bool,
    started: bool,
    connected: bool,
    connection_state: String,
    retrying: bool,
}

pub fn run(options: EnrollOptions) -> Result<String, String> {
    eprintln!("[1/5] Checking Control enrollment endpoint...");
    validate_controller_url(&options.controller)?;
    if let Some(proxy_url) = options.proxy_url.as_deref() {
        validate_proxy_url(proxy_url)?;
    }
    let endpoint = enrollment_endpoint(&options.controller)?;
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(30));
    let client = apply_http_client_proxy(client, options.proxy_url.as_deref())?
        .build()
        .map_err(|error| format!("failed to create enrollment client: {error}"))?;
    let response = client
        .post(endpoint)
        .json(&EnrollmentRequest {
            arch: std::env::consts::ARCH,
            device_code: &options.device_code,
            os: std::env::consts::OS,
            worker_version: env!("CARGO_PKG_VERSION"),
        })
        .send()
        .map_err(|error| format!("failed to enroll worker: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().unwrap_or_default();
        return Err(format!(
            "worker enrollment rejected ({status}): {body}\nFor an expired, invalid or consumed code, generate a new Device Code from the instance's Connections page or run: devshell instance device-code <instance>"
        ));
    }
    let enrollment = response
        .json::<EnrollmentResponse>()
        .map_err(|error| format!("invalid enrollment response: {error}"))?;
    validate_controller_url(&enrollment.controller_url)?;

    let instance = InstanceName::parse(&enrollment.instance)?;
    let paths = InstancePaths::resolve(&instance)?;
    eprintln!("[2/5] Credential accepted for {instance}; preparing worker binary...");
    // Finish fallible binary preparation before stopping a usable local
    // daemon. The server credential was already issued at this point.
    let installed_binary = install_current_binary()?;
    ensure_dir(&paths.instance_root, 0o700)?;
    ensure_dir(&paths.logs_dir, 0o700)?;
    ensure_dir(&paths.artifacts_dir, 0o700)?;
    ensure_dir(&paths.state_dir, 0o700)?;

    let socket_paths = crate::transport::endpoint::channel::EndpointPaths::resolve(&instance)?;
    let previous_config = if paths.config_file.exists() {
        Some(read_config(&paths, &instance)?)
    } else {
        None
    };
    let previous_running = process::daemon_state(&paths, &socket_paths) == DaemonState::Running;
    eprintln!("[3/5] Preparing local runtime for {instance}...");
    let switched = (|| -> Result<(), String> {
        crate::cli::instance::lifecycle::stop::stop_instance(&instance)?;
        // Keep persisted user config, logs and artifacts across re-enrollment.
        crate::tool::tmux::retire_instance_runtime(&paths, &socket_paths, instance.as_str())?;
        let _lock = InstanceLock::acquire(&paths)?;
        let mut config = match &previous_config {
            Some(config) => config.clone(),
            None => build_config(&instance)?,
        };
        config.reverse = Some(WorkerReverseConfig {
            controller_url: enrollment.controller_url.clone(),
            device_token: enrollment.device_token.clone(),
            generation: 0,
            proxy_url: options.proxy_url.clone(),
        });
        write_config(&paths, &config)?;
        drop(_lock);
        eprintln!("[4/5] Starting worker daemon...");
        start_installed_worker(&installed_binary, &instance)?;
        Ok(())
    })();
    if let Err(error) = switched {
        let rollback = (|| -> Result<(), String> {
            if let Some(config) = &previous_config {
                write_config(&paths, config)?;
            } else if paths.config_file.exists() {
                std::fs::remove_file(&paths.config_file)
                    .map_err(|failure| format!("failed to remove provisional config: {failure}"))?;
            }
            if previous_running {
                start_installed_worker(&installed_binary, &instance)?;
            }
            Ok(())
        })();
        return Err(match rollback {
            Ok(()) => format!(
                "worker enrollment installation failed: {error}. The previous configuration was restored. Generate a new Device Code before retrying."
            ),
            Err(rollback_error) => format!(
                "worker enrollment installation failed: {error}; restoring the previous worker also failed: {rollback_error}. Generate a new Device Code before retrying."
            ),
        });
    }
    eprintln!("[5/5] Checking Reverse connection (the worker will keep retrying)...");
    let deadline = Instant::now() + Duration::from_secs(5);
    let connection = loop {
        let current = state::read(&paths);
        if current
            .as_ref()
            .is_some_and(|status| status.state == "connected")
        {
            break current;
        }
        if Instant::now() >= deadline {
            break current;
        }
        thread::sleep(Duration::from_millis(150));
    };
    let connected = connection
        .as_ref()
        .is_some_and(|status| status.state == "connected");
    let connection_state =
        connection.map_or_else(|| "connecting".to_string(), |status| status.state);
    if connected {
        eprintln!("Reverse transport connected. Check Control for instance readiness.");
    } else {
        eprintln!(
            "Worker installed and running, but Reverse is {connection_state}. Background reconnect is active; do not enroll again. Inspect: devshell-worker logs --instance {instance}"
        );
    }
    serde_json::to_string_pretty(&EnrollResult {
        instance: instance.as_str().to_string(),
        installed_binary: protocol_path(&installed_binary),
        ok: connected,
        started: true,
        connected,
        connection_state,
        retrying: !connected,
    })
    .map_err(|error| error.to_string())
}

fn enrollment_endpoint(base: &str) -> Result<Url, String> {
    let mut url = Url::parse(base).map_err(|error| format!("invalid controller URL: {error}"))?;
    let base_path = url.path().trim_end_matches('/');
    url.set_path(&format!("{base_path}/reverse/v1/enroll"));
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn validate_controller_url(value: &str) -> Result<(), String> {
    let url = Url::parse(value).map_err(|error| format!("invalid controller URL: {error}"))?;
    match url.scheme() {
        "https" => Ok(()),
        "http" if is_loopback(url.host_str()) => Ok(()),
        "http" => {
            Err("unencrypted controller URL is only allowed for loopback development".to_string())
        }
        other => Err(format!("unsupported controller URL scheme: {other}")),
    }
}

fn is_loopback(host: Option<&str>) -> bool {
    matches!(host, Some("localhost" | "127.0.0.1" | "::1"))
}

#[cfg(test)]
mod tests {
    use super::{enrollment_endpoint, validate_controller_url, validate_proxy_url};

    #[test]
    fn enrollment_endpoint_preserves_base_path() {
        assert_eq!(
            enrollment_endpoint("https://example.test/base")
                .unwrap()
                .as_str(),
            "https://example.test/base/reverse/v1/enroll"
        );
    }

    #[test]
    fn rejects_public_plain_http() {
        assert!(validate_controller_url("http://example.test").is_err());
        assert!(validate_controller_url("http://127.0.0.1:17890").is_ok());
    }

    #[test]
    fn reverse_proxy_url_accepts_only_supported_anonymous_proxy_schemes() {
        assert!(validate_proxy_url("http://127.0.0.1:8080").is_ok());
        assert!(validate_proxy_url("socks5://127.0.0.1:1080").is_ok());
        assert!(validate_proxy_url("socks5h://proxy.example:1080").is_ok());
        assert!(validate_proxy_url("https://proxy.example:8443").is_err());
        assert!(validate_proxy_url("socks5://user:secret@127.0.0.1:1080").is_err());
        assert!(validate_proxy_url("http://proxy.example").is_ok());
    }
}
