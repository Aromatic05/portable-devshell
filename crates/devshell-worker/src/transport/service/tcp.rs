use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream};

use serde::Deserialize;

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
        let stream = TcpStream::connect((metadata.host.as_str(), metadata.port))
            .map_err(|error| format!("network.tcp connect failed: {error}"))?;
        let _ = stream.set_nodelay(true);
        Ok(Self { stream })
    }

    pub fn write(&mut self, data: &[u8]) -> Result<(), String> {
        self.stream
            .write_all(data)
            .map_err(|error| format!("network.tcp write failed: {error}"))
    }

    pub fn finish_input(&mut self) -> Result<(), String> {
        self.stream
            .shutdown(Shutdown::Write)
            .map_err(|error| format!("network.tcp half-close failed: {error}"))
    }

    pub fn read(&mut self, buffer: &mut [u8]) -> Result<usize, String> {
        self.stream
            .read(buffer)
            .map_err(|error| format!("network.tcp read failed: {error}"))
    }

    pub fn reset(&mut self) {
        let _ = self.stream.shutdown(Shutdown::Both);
    }
}

impl Drop for TcpService {
    fn drop(&mut self) {
        let _ = self.stream.shutdown(Shutdown::Both);
    }
}
