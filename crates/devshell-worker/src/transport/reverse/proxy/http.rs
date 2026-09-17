use std::io::{Read, Write};
use std::net::TcpStream;

const MAX_CONNECT_RESPONSE_BYTES: usize = 16 * 1024;

pub(super) fn connect(stream: &mut TcpStream, host: &str, port: u16) -> Result<(), String> {
    let authority = authority(host, port);
    let request = format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n\r\n");
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("failed to write HTTP proxy CONNECT request: {error}"))?;
    stream
        .flush()
        .map_err(|error| format!("failed to flush HTTP proxy CONNECT request: {error}"))?;

    let mut response = Vec::new();
    let mut byte = [0_u8; 1];
    while !response.ends_with(b"\r\n\r\n") {
        if response.len() >= MAX_CONNECT_RESPONSE_BYTES {
            return Err("HTTP proxy CONNECT response headers are too large".to_string());
        }
        stream
            .read_exact(&mut byte)
            .map_err(|error| format!("failed to read HTTP proxy CONNECT response: {error}"))?;
        response.push(byte[0]);
    }
    let status_line_end = response
        .windows(2)
        .position(|window| window == b"\r\n")
        .ok_or_else(|| "HTTP proxy CONNECT response has no status line".to_string())?;
    let status_line = std::str::from_utf8(&response[..status_line_end])
        .map_err(|_| "HTTP proxy CONNECT status line is not valid UTF-8".to_string())?;
    let status = status_line
        .split_ascii_whitespace()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| "HTTP proxy CONNECT response has an invalid status line".to_string())?;
    if !(200..300).contains(&status) {
        return Err(format!("HTTP proxy CONNECT rejected with status {status}"));
    }
    Ok(())
}

fn authority(host: &str, port: u16) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::thread;

    use super::connect;

    #[test]
    fn http_connect_establishes_a_raw_tunnel_without_consuming_tunnel_bytes() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let proxy = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut byte = [0_u8; 1];
            while !request.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
                assert!(request.len() < 16 * 1024);
            }
            assert_eq!(
                String::from_utf8(request).unwrap(),
                "CONNECT target.example:443 HTTP/1.1\r\nHost: target.example:443\r\n\r\n"
            );
            socket
                .write_all(b"HTTP/1.1 200 Connection Established\r\nProxy-Agent: test\r\n\r\n")
                .unwrap();
            let mut payload = [0_u8; 4];
            socket.read_exact(&mut payload).unwrap();
            assert_eq!(&payload, b"ping");
            socket.write_all(b"pong").unwrap();
        });

        let mut stream = TcpStream::connect(address).unwrap();
        connect(&mut stream, "target.example", 443).unwrap();
        stream.write_all(b"ping").unwrap();
        let mut response = [0_u8; 4];
        stream.read_exact(&mut response).unwrap();
        assert_eq!(&response, b"pong");
        proxy.join().unwrap();
    }
}
