use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::platform::unix_time_millis;
use crate::tools::ToolError;
use crate::tools::artifact::payload::ArtifactPayloadStore;
use crate::tools::artifact::receive::ArtifactReceiveStore;

const MAX_DIRECT_CHUNK_BYTES: usize = 1024 * 1024;
const MAX_RECEIVER_TTL_MS: u128 = 10 * 60 * 1000;
const DIRECT_PATH_PREFIX: &str = "/devshell-artifact-transfer/";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactDirectReceiveOpenInput {
    pub expires_at_ms: u128,
    pub receive_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactDirectReceiveOpenResult {
    pub expires_at_ms: u128,
    pub next_offset_bytes: u64,
    pub receiver_id: String,
    pub urls: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactDirectPushInput {
    pub max_bytes: usize,
    pub offset_bytes: u64,
    pub payload_id: String,
    pub urls: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactDirectPushResult {
    pub next_offset_bytes: u64,
    pub pushed_bytes: usize,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectChunkResponse {
    next_offset_bytes: u64,
}

struct DirectReceiver {
    stop: Arc<AtomicBool>,
}

pub struct ArtifactDirectTransfer {
    payloads: Arc<ArtifactPayloadStore>,
    receives: Arc<ArtifactReceiveStore>,
    receivers: Arc<Mutex<HashMap<String, DirectReceiver>>>,
}

impl ArtifactDirectTransfer {
    pub fn new(
        payloads: Arc<ArtifactPayloadStore>,
        receives: Arc<ArtifactReceiveStore>,
    ) -> Arc<Self> {
        Arc::new(Self {
            payloads,
            receives,
            receivers: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub fn open_receiver(
        &self,
        input: ArtifactDirectReceiveOpenInput,
    ) -> Result<ArtifactDirectReceiveOpenResult, ToolError> {
        let now = unix_time_millis();
        if input.expires_at_ms <= now
            || input.expires_at_ms.saturating_sub(now) > MAX_RECEIVER_TTL_MS
        {
            return Err(ToolError::new(
                "tool.invalidArguments",
                "direct receiver expiresAtMs must be within the next 10 minutes",
            ));
        }
        let next_offset_bytes = self.receives.received_bytes(&input.receive_id)?;
        let listener = TcpListener::bind(("0.0.0.0", 0))
            .map_err(|error| ToolError::new("artifact.directUnavailable", error.to_string()))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| ToolError::new("artifact.directUnavailable", error.to_string()))?;
        let port = listener
            .local_addr()
            .map_err(|error| ToolError::new("artifact.directUnavailable", error.to_string()))?
            .port();
        let receiver_id = Uuid::new_v4().to_string();
        let path = format!("{DIRECT_PATH_PREFIX}{receiver_id}");
        let urls = advertised_hosts()
            .into_iter()
            .map(|host| format!("http://{host}:{port}{path}"))
            .collect::<Vec<_>>();
        let stop = Arc::new(AtomicBool::new(false));
        self.receivers
            .lock()
            .map_err(|_| ToolError::new("artifact.storageFailed", "direct receiver lock poisoned"))?
            .insert(
                receiver_id.clone(),
                DirectReceiver {
                    stop: Arc::clone(&stop),
                },
            );

        let receives = Arc::clone(&self.receives);
        let registry = Arc::clone(&self.receivers);
        let receive_id = input.receive_id.clone();
        let thread_receiver_id = receiver_id.clone();
        let expires_at_ms = input.expires_at_ms;
        thread::spawn(move || {
            while !stop.load(Ordering::SeqCst) && unix_time_millis() < expires_at_ms {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let _ = handle_direct_request(
                            stream,
                            &thread_receiver_id,
                            &receive_id,
                            &receives,
                        );
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(20));
                    }
                    Err(_) => break,
                }
            }
            if let Ok(mut receivers) = registry.lock() {
                receivers.remove(&thread_receiver_id);
            }
        });

        Ok(ArtifactDirectReceiveOpenResult {
            expires_at_ms: input.expires_at_ms,
            next_offset_bytes,
            receiver_id,
            urls,
        })
    }

    pub fn close_receiver(&self, receiver_id: &str) -> Result<(), ToolError> {
        let receiver = self
            .receivers
            .lock()
            .map_err(|_| ToolError::new("artifact.storageFailed", "direct receiver lock poisoned"))?
            .remove(receiver_id);
        if let Some(receiver) = receiver {
            receiver.stop.store(true, Ordering::SeqCst);
        }
        Ok(())
    }

    pub fn push_chunk(
        &self,
        input: ArtifactDirectPushInput,
    ) -> Result<ArtifactDirectPushResult, ToolError> {
        if input.urls.is_empty() || input.max_bytes == 0 || input.max_bytes > MAX_DIRECT_CHUNK_BYTES
        {
            return Err(ToolError::new(
                "tool.invalidArguments",
                "direct push requires urls and maxBytes between 1 and 1048576",
            ));
        }
        let (bytes, total_bytes) =
            self.payloads
                .read_bytes(&input.payload_id, input.offset_bytes, input.max_bytes)?;
        if bytes.is_empty() && input.offset_bytes < total_bytes as u64 {
            return Err(ToolError::new(
                "artifact.payloadInvalid",
                "direct payload read returned no bytes before EOF",
            ));
        }
        let expected_next = input.offset_bytes.saturating_add(bytes.len() as u64);
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|error| ToolError::new("artifact.directUnavailable", error.to_string()))?;
        let mut last_error = "no direct receiver accepted the chunk".to_string();
        for url in &input.urls {
            let result = client
                .put(url)
                .header("x-devshell-offset", input.offset_bytes.to_string())
                .body(bytes.clone())
                .send()
                .and_then(|response| response.error_for_status())
                .and_then(|response| response.json::<DirectChunkResponse>());
            match result {
                Ok(response) if response.next_offset_bytes == expected_next => {
                    return Ok(ArtifactDirectPushResult {
                        next_offset_bytes: response.next_offset_bytes,
                        pushed_bytes: bytes.len(),
                    });
                }
                Ok(_) => last_error = "direct receiver returned an unexpected offset".to_string(),
                Err(error) => last_error = error.to_string(),
            }
        }
        Err(ToolError::new("artifact.directUnavailable", last_error))
    }
}

fn advertised_hosts() -> Vec<String> {
    let mut hosts = Vec::new();
    let route_ip = UdpSocket::bind(("0.0.0.0", 0)).ok().and_then(|socket| {
        socket.connect(("192.0.2.1", 9)).ok()?;
        let address = socket.local_addr().ok()?;
        match address.ip() {
            std::net::IpAddr::V4(ip) => Some(ip),
            std::net::IpAddr::V6(_) => None,
        }
    });
    if let Some(ip) = route_ip {
        let octets = ip.octets();
        let shared = octets[0] == 100 && (64..=127).contains(&octets[1]);
        if ip.is_private() || ip.is_link_local() || shared {
            hosts.push(ip.to_string());
        }
    }
    hosts.push("127.0.0.1".to_string());
    hosts.dedup();
    hosts
}

fn handle_direct_request(
    mut stream: TcpStream,
    receiver_id: &str,
    receive_id: &str,
    receives: &ArtifactReceiveStore,
) -> Result<(), ToolError> {
    stream
        .set_read_timeout(Some(Duration::from_secs(15)))
        .map_err(|error| ToolError::new("artifact.directUnavailable", error.to_string()))?;
    let mut buffer = Vec::with_capacity(16 * 1024);
    let header_end = loop {
        if buffer.len() >= 16 * 1024 {
            write_http_error(&mut stream, 400, "headers_too_large");
            return Ok(());
        }
        let mut chunk = [0u8; 4096];
        let read = stream
            .read(&mut chunk)
            .map_err(|error| ToolError::new("artifact.directUnavailable", error.to_string()))?;
        if read == 0 {
            return Ok(());
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(index) = find_header_end(&buffer) {
            break index;
        }
    };
    let headers = std::str::from_utf8(&buffer[..header_end])
        .map_err(|_| ToolError::new("artifact.directUnavailable", "invalid HTTP headers"))?;
    let mut lines = headers.split("\r\n");
    let request = lines.next().unwrap_or_default();
    let expected_path = format!("{DIRECT_PATH_PREFIX}{receiver_id}");
    if request != format!("PUT {expected_path} HTTP/1.1") {
        write_http_error(&mut stream, 404, "not_found");
        return Ok(());
    }
    let mut content_length = None;
    let mut offset_bytes = None;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.eq_ignore_ascii_case("content-length") {
            content_length = value.trim().parse::<usize>().ok();
        } else if name.eq_ignore_ascii_case("x-devshell-offset") {
            offset_bytes = value.trim().parse::<u64>().ok();
        }
    }
    let Some(content_length) = content_length else {
        write_http_error(&mut stream, 400, "content_length_required");
        return Ok(());
    };
    let Some(offset_bytes) = offset_bytes else {
        write_http_error(&mut stream, 400, "offset_required");
        return Ok(());
    };
    if content_length > MAX_DIRECT_CHUNK_BYTES {
        write_http_error(&mut stream, 413, "chunk_too_large");
        return Ok(());
    }
    let body_start = header_end + 4;
    let mut body = buffer[body_start..].to_vec();
    if body.len() > content_length {
        body.truncate(content_length);
    }
    while body.len() < content_length {
        let remaining = content_length - body.len();
        let mut chunk = vec![0u8; remaining.min(64 * 1024)];
        stream
            .read_exact(&mut chunk)
            .map_err(|error| ToolError::new("artifact.directUnavailable", error.to_string()))?;
        body.extend_from_slice(&chunk);
    }
    match receives.write_bytes(receive_id, offset_bytes, &body) {
        Ok(written) => write_http_json(
            &mut stream,
            200,
            &DirectChunkResponse {
                next_offset_bytes: written.next_offset_bytes,
            },
        ),
        Err(error) => {
            write_http_error(&mut stream, 409, &error.code);
        }
    }
    Ok(())
}

fn find_header_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|window| window == b"\r\n\r\n")
}

fn write_http_json(stream: &mut TcpStream, status: u16, body: &DirectChunkResponse) {
    if let Ok(body) = serde_json::to_vec(body) {
        let reason = if status == 200 { "OK" } else { "Error" };
        let _ = write!(
            stream,
            "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let _ = stream.write_all(&body);
        let _ = stream.flush();
    }
}

fn write_http_error(stream: &mut TcpStream, status: u16, code: &str) {
    let body = serde_json::json!({ "error": code }).to_string();
    let reason = match status {
        404 => "Not Found",
        413 => "Payload Too Large",
        409 => "Conflict",
        _ => "Bad Request",
    };
    let _ = write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.flush();
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::Arc;

    use super::{advertised_hosts, ArtifactDirectPushInput, ArtifactDirectReceiveOpenInput, ArtifactDirectTransfer};
    use crate::platform::unix_time_millis;
    use crate::security::policy::DisabledSecurityPolicy;
    use crate::tools::artifact::payload::ArtifactPayloadStore;
    use crate::tools::artifact::receive::{ArtifactReceiveBeginInput, ArtifactReceiveStore};
    use crate::tools::artifact::store::ArtifactStore;

    #[test]
    fn only_advertises_private_or_loopback_ipv4_addresses() {
        for host in advertised_hosts() {
            let ip: std::net::Ipv4Addr = host.parse().unwrap();
            let octets = ip.octets();
            let shared = octets[0] == 100 && (64..=127).contains(&octets[1]);
            assert!(ip.is_loopback() || ip.is_private() || ip.is_link_local() || shared);
        }
    }

    #[test]
    fn pushes_raw_chunks_through_http_into_the_existing_receive_commit_path() {
        let root = crate::testing::temp_dir();
        let source_workspace = root.path().join("source");
        let target_workspace = root.path().join("target");
        fs::create_dir(&source_workspace).unwrap();
        fs::create_dir(&target_workspace).unwrap();
        let bytes = b"direct artifact payload";
        fs::write(source_workspace.join("payload.bin"), bytes).unwrap();

        let artifacts = ArtifactStore::new(root.path().join("artifacts")).unwrap();
        let payloads = ArtifactPayloadStore::new(root.path().join("payloads"), artifacts).unwrap();
        let opened = payloads
            .open_path(
                &source_workspace,
                "./payload.bin",
                &DisabledSecurityPolicy,
                unix_time_millis() + 60_000,
            )
            .unwrap();
        let receives = ArtifactReceiveStore::new(root.path().join("receives")).unwrap();
        let receive = receives
            .begin(
                &target_workspace,
                &DisabledSecurityPolicy,
                ArtifactReceiveBeginInput {
                    descriptor: opened.descriptor.clone(),
                    overwrite: false,
                    target_path: "./payload.bin".to_string(),
                },
            )
            .unwrap();
        let direct = ArtifactDirectTransfer::new(Arc::clone(&payloads), Arc::clone(&receives));
        let receiver = direct
            .open_receiver(ArtifactDirectReceiveOpenInput {
                expires_at_ms: unix_time_millis() + 60_000,
                receive_id: receive.receive_id.clone(),
            })
            .unwrap();

        let mut offset = 0;
        while offset < opened.descriptor.payload_bytes as u64 {
            let pushed = direct
                .push_chunk(ArtifactDirectPushInput {
                    max_bytes: 5,
                    offset_bytes: offset,
                    payload_id: opened.payload_id.clone(),
                    urls: receiver.urls.clone(),
                })
                .unwrap();
            offset = pushed.next_offset_bytes;
        }
        direct.close_receiver(&receiver.receiver_id).unwrap();
        let finished = receives.finish(&receive.receive_id).unwrap();

        assert_eq!(finished.bytes, bytes.len());
        assert_eq!(finished.blake3, opened.descriptor.payload_blake3);
        assert_eq!(
            fs::read(target_workspace.join("payload.bin")).unwrap(),
            bytes
        );
    }
}
