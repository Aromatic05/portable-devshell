use std::io::{Read, Write};
use std::net::{IpAddr, TcpStream, ToSocketAddrs};

pub(super) fn connect(
    stream: &mut TcpStream,
    host: &str,
    port: u16,
    remote_dns: bool,
) -> Result<(), String> {
    stream
        .write_all(&[0x05, 0x01, 0x00])
        .map_err(|error| format!("failed to write SOCKS5 greeting: {error}"))?;
    let mut greeting = [0_u8; 2];
    stream
        .read_exact(&mut greeting)
        .map_err(|error| format!("failed to read SOCKS5 greeting response: {error}"))?;
    if greeting != [0x05, 0x00] {
        return Err("SOCKS5 proxy does not accept anonymous authentication".to_string());
    }

    let target = if remote_dns {
        host.parse::<IpAddr>()
            .map(Target::Ip)
            .unwrap_or_else(|_| Target::Domain(host.to_string()))
    } else {
        let address = (host, port)
            .to_socket_addrs()
            .map_err(|error| format!("failed to resolve SOCKS5 target {host}:{port}: {error}"))?
            .next()
            .ok_or_else(|| format!("SOCKS5 target {host}:{port} did not resolve"))?;
        Target::Ip(address.ip())
    };

    let mut request = vec![0x05, 0x01, 0x00];
    match target {
        Target::Ip(IpAddr::V4(address)) => {
            request.push(0x01);
            request.extend_from_slice(&address.octets());
        }
        Target::Ip(IpAddr::V6(address)) => {
            request.push(0x04);
            request.extend_from_slice(&address.octets());
        }
        Target::Domain(name) => {
            let bytes = name.as_bytes();
            let length = u8::try_from(bytes.len())
                .map_err(|_| "SOCKS5 target host exceeds 255 bytes".to_string())?;
            request.push(0x03);
            request.push(length);
            request.extend_from_slice(bytes);
        }
    }
    request.extend_from_slice(&port.to_be_bytes());
    stream
        .write_all(&request)
        .map_err(|error| format!("failed to write SOCKS5 CONNECT request: {error}"))?;

    let mut header = [0_u8; 4];
    stream
        .read_exact(&mut header)
        .map_err(|error| format!("failed to read SOCKS5 CONNECT response: {error}"))?;
    if header[0] != 0x05 || header[2] != 0x00 {
        return Err("SOCKS5 proxy returned an invalid CONNECT response".to_string());
    }
    if header[1] != 0x00 {
        return Err(format!(
            "SOCKS5 proxy CONNECT rejected with code {}",
            header[1]
        ));
    }
    discard_address(stream, header[3])?;
    let mut bound_port = [0_u8; 2];
    stream
        .read_exact(&mut bound_port)
        .map_err(|error| format!("failed to read SOCKS5 bound port: {error}"))?;
    Ok(())
}

enum Target {
    Ip(IpAddr),
    Domain(String),
}

fn discard_address(stream: &mut TcpStream, address_type: u8) -> Result<(), String> {
    let byte_length = match address_type {
        0x01 => 4,
        0x04 => 16,
        0x03 => {
            let mut length = [0_u8; 1];
            stream
                .read_exact(&mut length)
                .map_err(|error| format!("failed to read SOCKS5 bound host length: {error}"))?;
            usize::from(length[0])
        }
        other => {
            return Err(format!(
                "SOCKS5 proxy returned unknown address type {other}"
            ));
        }
    };
    let mut address = vec![0_u8; byte_length];
    stream
        .read_exact(&mut address)
        .map_err(|error| format!("failed to read SOCKS5 bound address: {error}"))
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::thread;

    use super::connect;

    #[test]
    fn socks5h_connect_delegates_dns_to_the_proxy_and_keeps_the_tunnel_raw() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let proxy = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut greeting = [0_u8; 3];
            socket.read_exact(&mut greeting).unwrap();
            assert_eq!(greeting, [0x05, 0x01, 0x00]);
            socket.write_all(&[0x05, 0x00]).unwrap();

            let mut header = [0_u8; 5];
            socket.read_exact(&mut header).unwrap();
            assert_eq!(&header[..4], &[0x05, 0x01, 0x00, 0x03]);
            let name_len = usize::from(header[4]);
            let mut name = vec![0_u8; name_len];
            socket.read_exact(&mut name).unwrap();
            assert_eq!(&name, b"target.example");
            let mut port = [0_u8; 2];
            socket.read_exact(&mut port).unwrap();
            assert_eq!(u16::from_be_bytes(port), 443);

            socket
                .write_all(&[0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x1f, 0x90])
                .unwrap();
            let mut payload = [0_u8; 4];
            socket.read_exact(&mut payload).unwrap();
            assert_eq!(&payload, b"ping");
            socket.write_all(b"pong").unwrap();
        });

        let mut stream = TcpStream::connect(address).unwrap();
        connect(&mut stream, "target.example", 443, true).unwrap();
        stream.write_all(b"ping").unwrap();
        let mut response = [0_u8; 4];
        stream.read_exact(&mut response).unwrap();
        assert_eq!(&response, b"pong");
        proxy.join().unwrap();
    }
}
