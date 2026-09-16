mod exec;
mod tcp;

use exec::ExecService;
use tcp::TcpService;

pub enum ServiceConnection {
    Tcp(TcpService),
    Exec(ExecService),
}

impl ServiceConnection {
    pub fn open(service: &str, metadata: &[u8]) -> Result<Self, String> {
        match service {
            "network.tcp" => TcpService::open(metadata).map(Self::Tcp),
            "process.exec" => ExecService::open(metadata).map(Self::Exec),
            _ => Err(format!("unsupported transport Service {service}")),
        }
    }

    pub fn write(&mut self, data: &[u8]) -> Result<(), String> {
        match self {
            Self::Tcp(service) => service.write(data),
            Self::Exec(service) => service.write(data),
        }
    }

    pub fn finish_input(&mut self) -> Result<(), String> {
        match self {
            Self::Tcp(service) => service.finish_input(),
            Self::Exec(service) => service.finish_input(),
        }
    }

    pub fn read(&mut self, buffer: &mut [u8]) -> Result<usize, String> {
        match self {
            Self::Tcp(service) => service.read(buffer),
            Self::Exec(service) => service.read(buffer),
        }
    }

    pub fn reset(&mut self) {
        match self {
            Self::Tcp(service) => service.reset(),
            Self::Exec(service) => service.reset(),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::{Shutdown, TcpListener};
    use std::thread;

    use serde_json::json;

    use super::*;
    use crate::transport::frame::{FrameEvent, FrameProtocol, FrameRole, RESET_CANCELLED};

    #[test]
    fn network_tcp_round_trips_raw_protocol_bytes() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("listen");
        let port = listener.local_addr().expect("address").port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = Vec::new();
            stream.read_to_end(&mut request).expect("read request");
            assert_eq!(request, b"ping");
            stream.write_all(b"pong").expect("write response");
            stream.shutdown(Shutdown::Write).expect("finish response");
        });
        let metadata = serde_json::to_vec(&json!({
            "host": "127.0.0.1",
            "port": port,
        }))
        .unwrap();
        let response = run_frame_service("network.tcp", metadata, b"ping").expect("round trip");
        assert_eq!(response, b"pong");
        server.join().expect("server thread");
    }

    #[test]
    fn network_tcp_carries_http_without_transport_parsing() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("listen");
        let port = listener.local_addr().expect("address").port();
        let request = b"GET /transport HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n";
        let response = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK";
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut received = Vec::new();
            stream.read_to_end(&mut received).expect("read request");
            assert_eq!(received, request);
            stream.write_all(response).expect("write response");
            stream.shutdown(Shutdown::Write).expect("finish response");
        });
        let metadata = serde_json::to_vec(&json!({
            "host": "127.0.0.1",
            "port": port,
        }))
        .unwrap();
        let received = run_frame_service("network.tcp", metadata, request).expect("HTTP flow");
        assert_eq!(received, response);
        server.join().expect("server thread");
    }

    #[test]
    fn process_exec_round_trips_stdio_protocol_bytes() {
        let (executable, args) = echo_process();
        let metadata = serde_json::to_vec(&json!({
            "executable": executable,
            "args": args,
        }))
        .unwrap();
        let response = run_frame_service("process.exec", metadata, b"ping\n").expect("round trip");
        #[cfg(unix)]
        assert_eq!(response, b"ping\n");
        #[cfg(windows)]
        assert!(String::from_utf8_lossy(&response).contains("ping"));
    }

    #[cfg(unix)]
    #[test]
    fn process_exec_carries_real_rsync_server_protocol_bytes() {
        if std::process::Command::new("rsync")
            .arg("--version")
            .output()
            .is_err()
        {
            eprintln!("rsync is not installed; skipping rsync server-mode smoke");
            return;
        }

        let temp = tempfile::tempdir().expect("tempdir");
        let source = temp.path().join("source.txt");
        std::fs::write(&source, b"hello-rsync\n").expect("write source");
        let metadata = serde_json::to_vec(&json!({
            "executable": "rsync",
            "args": [
                "--server",
                "--sender",
                ".",
                source.to_string_lossy(),
            ],
        }))
        .unwrap();

        let mut client = FrameProtocol::new(FrameRole::Opener);
        let mut worker = FrameProtocol::new(FrameRole::Acceptor);
        let (stream_id, open) = client
            .open("process.exec".into(), metadata, 64 * 1024)
            .expect("open process.exec");
        let event = worker
            .accept_frame(open)
            .expect("accept OPEN")
            .expect("OPEN event");
        let (opened_id, service, metadata) = match event {
            FrameEvent::Open {
                stream_id,
                service,
                metadata,
            } => (stream_id, service, metadata),
            _ => panic!("expected OPEN event"),
        };
        let mut connection = ServiceConnection::open(&service, &metadata).expect("spawn rsync");
        let window = worker
            .accept_open(opened_id, 64 * 1024)
            .expect("accept process.exec");
        client.accept_frame(window).expect("grant client credit");

        let mut greeting = [0u8; 4];
        let mut offset = 0;
        while offset < greeting.len() {
            let read = connection
                .read(&mut greeting[offset..])
                .expect("read rsync greeting");
            assert!(read > 0, "rsync closed before protocol greeting");
            offset += read;
        }
        let (_, frame) = worker
            .next_data_frame(stream_id, &greeting)
            .expect("frame rsync greeting")
            .expect("worker has send credit");
        client.accept_frame(frame).expect("deliver rsync greeting");
        let (bytes, window) = client
            .read(stream_id)
            .expect("read Frame stream")
            .expect("rsync greeting DATA");
        assert_eq!(bytes, greeting);
        assert!(u32::from_le_bytes(greeting) >= 20);
        if let Some(window) = window {
            worker.accept_frame(window).expect("return credit");
        }

        let reset = worker
            .reset(stream_id, RESET_CANCELLED, "rsync smoke complete".into())
            .expect("reset rsync stream");
        client.accept_frame(reset).expect("deliver reset");
        connection.reset();
    }

    #[test]
    fn service_dispatch_rejects_unknown_names_and_metadata() {
        assert!(ServiceConnection::open("unknown", b"{}").is_err());
        assert!(ServiceConnection::open("network.tcp", br#"{"host":"127.0.0.1"}"#).is_err());
        assert!(ServiceConnection::open("process.exec", br#"{"executable":""}"#).is_err());
    }

    fn run_frame_service(
        service_name: &str,
        metadata: Vec<u8>,
        request: &[u8],
    ) -> Result<Vec<u8>, String> {
        let mut client = FrameProtocol::new(FrameRole::Opener);
        let mut worker = FrameProtocol::new(FrameRole::Acceptor);
        let (stream_id, open) = client.open(service_name.to_string(), metadata, 64 * 1024)?;
        let event = worker
            .accept_frame(open)?
            .ok_or_else(|| "OPEN event missing.".to_string())?;
        let (opened_id, service, metadata) = match event {
            FrameEvent::Open {
                stream_id,
                service,
                metadata,
            } => (stream_id, service, metadata),
            _ => return Err("Expected OPEN event.".to_string()),
        };
        let mut connection = ServiceConnection::open(&service, &metadata)?;
        let window = worker.accept_open(opened_id, 64 * 1024)?;
        client.accept_frame(window)?;

        let mut offset = 0;
        while offset < request.len() {
            let Some((used, frame)) = client.next_data_frame(stream_id, &request[offset..])? else {
                return Err("request stream ran out of send credit.".to_string());
            };
            offset += used;
            worker.accept_frame(frame)?;
            let (data, window) = worker
                .read(stream_id)?
                .ok_or_else(|| "request DATA event missing.".to_string())?;
            connection.write(&data)?;
            if let Some(window) = window {
                client.accept_frame(window)?;
            }
        }

        let fin = client.finish(stream_id)?;
        worker.accept_frame(fin)?;
        connection.finish_input()?;

        let mut response = Vec::new();
        let mut buffer = [0u8; 4096];
        loop {
            let read = connection.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            let mut output_offset = 0;
            while output_offset < read {
                let Some((used, frame)) =
                    worker.next_data_frame(stream_id, &buffer[output_offset..read])?
                else {
                    return Err("response stream ran out of send credit.".to_string());
                };
                output_offset += used;
                client.accept_frame(frame)?;
                let (data, window) = client
                    .read(stream_id)?
                    .ok_or_else(|| "response DATA event missing.".to_string())?;
                response.extend_from_slice(&data);
                if let Some(window) = window {
                    worker.accept_frame(window)?;
                }
            }
        }

        let fin = worker.finish(stream_id)?;
        client.accept_frame(fin)?;
        Ok(response)
    }

    #[cfg(unix)]
    fn echo_process() -> (String, Vec<String>) {
        ("/bin/cat".to_string(), Vec::new())
    }

    #[cfg(windows)]
    fn echo_process() -> (String, Vec<String>) {
        (
            std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string()),
            vec!["/D".into(), "/Q".into(), "/C".into(), "more".into()],
        )
    }
}
