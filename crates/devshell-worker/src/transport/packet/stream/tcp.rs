use std::net::{Shutdown, TcpStream, ToSocketAddrs};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TcpMetadata {
    host: String,
    port: u16,
}

pub struct TcpService {
    stream: TcpStream,
}

impl TcpService {
    pub fn open(metadata: &[u8]) -> Result<Self, String> {
        let metadata: TcpMetadata = serde_json::from_slice(metadata)
            .map_err(|error| format!("network.tcp metadata is invalid: {error}"))?;
        if metadata.host.trim().is_empty() {
            return Err("network.tcp host must not be empty.".to_string());
        }
        if metadata.port == 0 {
            return Err("network.tcp port must be positive.".to_string());
        }
        let deadline = Instant::now() + CONNECT_TIMEOUT;
        // Name resolution can block too. Its result shares the connect deadline.
        let addresses = resolve_with_timeout(CONNECT_TIMEOUT, move || {
            (metadata.host.as_str(), metadata.port).to_socket_addrs()
                .map(|addresses| addresses.collect::<Vec<_>>())
        })?;
        if addresses.is_empty() {
            return Err("network.tcp host resolved to no addresses.".to_string());
        }
        let mut failure = "network.tcp connect timed out.".to_string();
        let mut connected = None;
        for address in addresses {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                failure = "network.tcp connect timed out.".to_string();
                break;
            }
            match TcpStream::connect_timeout(&address, remaining) {
                Ok(stream) => {
                    connected = Some(stream);
                    break;
                }
                Err(error) => failure = format!("network.tcp connect failed: {error}"),
            }
        }
        let stream = connected.ok_or(failure)?;
        let _ = stream.set_nodelay(true);
        Ok(Self { stream })
    }

    pub fn reset(&mut self) {
        let _ = self.stream.shutdown(Shutdown::Both);
    }

    pub fn clone_stream(&self) -> Result<TcpStream, String> {
        self.stream
            .try_clone()
            .map_err(|error| format!("network.tcp stream clone failed: {error}"))
    }
}

impl Drop for TcpService {
    fn drop(&mut self) {
        let _ = self.stream.shutdown(Shutdown::Both);
    }
}

fn resolve_with_timeout<F>(timeout: Duration, resolve: F) -> Result<Vec<std::net::SocketAddr>, String>
where
    F: FnOnce() -> std::io::Result<Vec<std::net::SocketAddr>> + Send + 'static,
{
    let (resolved_tx, resolved_rx) = mpsc::channel();
    thread::spawn(move || {
        let _ = resolved_tx.send(resolve());
    });
    resolved_rx
        .recv_timeout(timeout)
        .map_err(|_| "network.tcp name resolution timed out.".to_string())?
        .map_err(|error| format!("network.tcp name resolution failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stalled_resolution_has_a_bounded_deadline() {
        let (release_tx, release_rx) = mpsc::channel();
        let started = Instant::now();
        let error = resolve_with_timeout(Duration::from_millis(20), move || {
            let _ = release_rx.recv_timeout(Duration::from_secs(2));
            Ok(vec![])
        }).unwrap_err();
        release_tx.send(()).unwrap();
        assert!(error.contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn invalid_tcp_metadata_is_rejected_before_connect() {
        for metadata in [br#"{"host":"","port":22}"#.as_slice(),
                         br#"{"host":"fixture","port":0}"#.as_slice(),
                         br#"{"host":"fixture","port":22,"extra":true}"#.as_slice()] {
            assert!(TcpService::open(metadata).is_err());
        }
    }
}
