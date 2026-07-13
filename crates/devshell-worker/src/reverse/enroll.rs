use std::path::PathBuf;
use std::time::Duration;

use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use url::Url;

use crate::instance::{
    InstanceLock, InstanceName, WorkerReverseConfig, build_config, read_config, write_config,
};
use crate::reverse::install::{install_current_binary, start_installed_worker};
use crate::storage::InstancePaths;
use crate::storage::permissions::ensure_dir;

#[derive(Clone, Debug)]
pub struct EnrollOptions {
    pub controller: String,
    pub device_code: String,
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
    workspace: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EnrollResult {
    instance: String,
    installed_binary: String,
    ok: bool,
    started: bool,
    workspace: String,
}

pub fn run(options: EnrollOptions) -> Result<String, String> {
    validate_controller_url(&options.controller)?;
    let endpoint = enrollment_endpoint(&options.controller)?;
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(30))
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
        return Err(format!("worker enrollment rejected ({status}): {body}"));
    }
    let enrollment = response
        .json::<EnrollmentResponse>()
        .map_err(|error| format!("invalid enrollment response: {error}"))?;
    validate_controller_url(&enrollment.controller_url)?;

    let instance = InstanceName::parse(&enrollment.instance)?;
    let workspace = canonical_workspace(&enrollment.workspace)?;
    let paths = InstancePaths::resolve(&instance)?;
    ensure_dir(&paths.instance_root, 0o700)?;
    ensure_dir(&paths.logs_dir, 0o700)?;
    ensure_dir(&paths.artifacts_dir, 0o700)?;
    ensure_dir(&paths.state_dir, 0o700)?;

    {
        let _lock = InstanceLock::acquire(&paths)?;
        let mut config = if paths.config_file.exists() {
            read_config(&paths, &instance)?
        } else {
            build_config(&instance)?
        };
        config.reverse = Some(WorkerReverseConfig {
            controller_url: enrollment.controller_url,
            device_token: enrollment.device_token,
            generation: 0,
        });
        write_config(&paths, &config)?;
    }

    let installed_binary = install_current_binary()?;
    start_installed_worker(&installed_binary, &instance, &workspace)?;
    serde_json::to_string_pretty(&EnrollResult {
        instance: instance.as_str().to_string(),
        installed_binary: installed_binary.to_string_lossy().into_owned(),
        ok: true,
        started: true,
        workspace: workspace.to_string_lossy().into_owned(),
    })
    .map_err(|error| error.to_string())
}

fn canonical_workspace(value: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value);
    let canonical = path.canonicalize().map_err(|error| {
        format!(
            "failed to resolve enrolled workspace {}: {error}",
            path.display()
        )
    })?;
    if !canonical.is_dir() {
        return Err(format!(
            "enrolled workspace is not a directory: {}",
            canonical.display()
        ));
    }
    Ok(canonical)
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
    use super::{enrollment_endpoint, validate_controller_url};

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
}
