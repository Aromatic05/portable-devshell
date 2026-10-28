pub(crate) mod deadline;
mod http;
mod socks;

use std::net::{TcpStream, ToSocketAddrs};
use std::time::Instant;

use reqwest::blocking::ClientBuilder;
use url::Url;

pub(crate) fn parse_proxy_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|error| format!("invalid reverse proxy URL: {error}"))?;
    match url.scheme() {
        "http" | "socks5" | "socks5h" => {}
        scheme => {
            return Err(format!("unsupported reverse proxy URL scheme: {scheme}"));
        }
    }
    if url.host_str().is_none() {
        return Err("reverse proxy URL requires a host".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("reverse proxy URL userinfo is not supported".to_string());
    }
    if !matches!(url.path(), "" | "/") || url.query().is_some() || url.fragment().is_some() {
        return Err("reverse proxy URL must not contain path, query, or fragment".to_string());
    }
    Ok(url)
}

pub(crate) fn validate_proxy_url(value: &str) -> Result<(), String> {
    parse_proxy_url(value).map(|_| ())
}

pub(crate) fn apply_http_client_proxy(
    builder: ClientBuilder,
    proxy_url: Option<&str>,
) -> Result<ClientBuilder, String> {
    let Some(proxy_url) = proxy_url else {
        return Ok(builder);
    };
    parse_proxy_url(proxy_url)?;
    let proxy = reqwest::Proxy::all(proxy_url)
        .map_err(|error| format!("invalid reverse proxy URL: {error}"))?;
    Ok(builder.proxy(proxy))
}

pub(crate) fn connect_tcp(
    proxy_url: Option<&str>,
    target: &Url,
    deadline: Instant,
    stopping: impl Fn() -> bool + Send + 'static,
) -> Result<(TcpStream, deadline::SocketDeadline), String> {
    let proxy = proxy_url.map(parse_proxy_url).transpose()?;
    let destination = proxy.as_ref().unwrap_or(target);
    let proxy_host = destination
        .host_str()
        .ok_or_else(|| "reverse connection URL requires a host".to_string())?;
    let proxy_port = destination.port().unwrap_or(match destination.scheme() {
        "http" | "ws" => 80,
        "https" | "wss" => 443,
        "socks5" | "socks5h" => 1080,
        _ => unreachable!(),
    });
    let target_host = target
        .host_str()
        .ok_or_else(|| "reverse target URL requires a host".to_string())?;
    let target_port = target.port().unwrap_or(match target.scheme() {
        "ws" | "http" => 80,
        "wss" | "https" => 443,
        scheme => return Err(format!("unsupported reverse target URL scheme: {scheme}")),
    });

    // OS DNS resolution (including SOCKS5 local target DNS) is synchronous:
    // socket shutdown cannot bound it. TCP connect uses the remaining attempt
    // time; stop can interrupt established sockets within the 50ms poll, but
    // a connect in progress may take the remaining attempt time to return.
    let mut last_error = None;
    let mut stream = None;
    for address in (proxy_host, proxy_port)
        .to_socket_addrs()
        .map_err(|error| {
            format!("failed to resolve reverse connection {proxy_host}:{proxy_port}: {error}")
        })?
    {
        if stopping() {
            return Err("reverse websocket attempt stopped".into());
        }
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| "reverse websocket attempt timed out".to_string())?;
        match TcpStream::connect_timeout(&address, remaining) {
            Ok(candidate) => {
                stream = Some(candidate);
                break;
            }
            Err(error) => last_error = Some(error),
        }
    }
    let mut stream = stream.ok_or_else(|| {
        format!(
            "failed to connect reverse connection {proxy_host}:{proxy_port}: {}",
            last_error
                .map(|error| error.to_string())
                .unwrap_or_else(|| "connection host did not resolve to an address".to_string())
        )
    })?;
    let guard = deadline::SocketDeadline::new(&stream, deadline, stopping)?;
    if let Some(proxy) = proxy {
        match proxy.scheme() {
            "http" => http::connect(&mut stream, target_host, target_port)?,
            "socks5" => socks::connect(&mut stream, target_host, target_port, false)?,
            "socks5h" => socks::connect(&mut stream, target_host, target_port, true)?,
            _ => unreachable!(),
        }
    }

    stream
        .set_nodelay(true)
        .map_err(|error| format!("failed to enable reverse TCP_NODELAY: {error}"))?;
    Ok((stream, guard))
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;
    use std::time::Duration;

    use reqwest::blocking::Client;

    use super::apply_http_client_proxy;

    // The server holds every socket until the client finishes; failures must
    // come from the attempt deadline, never from fixture EOF.
    fn stalled_attempt(proxy_scheme: Option<&str>, target_scheme: &str, tunnel: bool) {
        use std::sync::mpsc;
        use std::time::Instant;
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let (release, wait) = mpsc::channel();
        let proxy_scheme_owned = proxy_scheme.map(str::to_string);
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            if tunnel {
                match proxy_scheme_owned.as_deref().unwrap() {
                    "http" => {
                        let mut header = Vec::new();
                        let mut byte = [0];
                        while !header.ends_with(b"\r\n\r\n") {
                            socket.read_exact(&mut byte).unwrap();
                            header.push(byte[0]);
                        }
                        socket.write_all(b"HTTP/1.1 200 OK\r\n\r\n").unwrap();
                    }
                    "socks5h" => {
                        let mut greeting = [0; 3];
                        socket.read_exact(&mut greeting).unwrap();
                        assert_eq!(greeting, [5, 1, 0]);
                        socket.write_all(&[5, 0]).unwrap();
                        let mut header = [0; 5];
                        socket.read_exact(&mut header).unwrap();
                        assert_eq!(&header[..4], &[5, 1, 0, 3]);
                        let mut rest = vec![0; header[4] as usize + 2];
                        socket.read_exact(&mut rest).unwrap();
                        socket.write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 0]).unwrap();
                    }
                    _ => unreachable!(),
                }
            }
            wait.recv_timeout(Duration::from_secs(4)).unwrap();
        });
        let target = url::Url::parse(&format!(
            "{target_scheme}://localhost:{}/stall",
            address.port()
        ))
        .unwrap();
        let proxy_url =
            proxy_scheme.map(|scheme| format!("{scheme}://127.0.0.1:{}", address.port()));
        let started = Instant::now();
        let result = super::connect_tcp(
            proxy_url.as_deref(),
            &target,
            started + Duration::from_millis(300),
            || false,
        )
        .and_then(|(stream, guard)| {
            let result =
                tungstenite::client_tls(target.as_str(), stream).map_err(|error| error.to_string());
            drop(guard);
            result.map(|_| ())
        });
        let elapsed = started.elapsed();
        release.send(()).unwrap();
        server.join().unwrap();
        assert!(result.is_err());
        assert!(elapsed >= Duration::from_millis(250), "{elapsed:?}");
        assert!(elapsed < Duration::from_secs(3), "{elapsed:?}");
    }

    #[test]
    fn direct_upgrade_stall_obeys_attempt_deadline() {
        stalled_attempt(None, "ws", false);
    }

    #[test]
    fn http_connect_stall_obeys_attempt_deadline() {
        stalled_attempt(Some("http"), "wss", false);
    }

    #[test]
    fn http_connect_success_then_tls_blackhole_obeys_attempt_deadline() {
        stalled_attempt(Some("http"), "wss", true);
    }

    #[test]
    fn socks_connect_success_then_tls_blackhole_obeys_attempt_deadline() {
        stalled_attempt(Some("socks5h"), "wss", true);
    }

    #[test]
    fn proxy_upgrade_stall_obeys_attempt_deadline() {
        stalled_attempt(Some("http"), "ws", true);
    }

    #[test]
    fn explicit_proxy_routes_blocking_http_requests() {
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
            let request = String::from_utf8(request).unwrap();
            assert!(request.starts_with("GET http://target.invalid/probe HTTP/1.1\r\n"));
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .unwrap();
        });

        let builder = Client::builder().timeout(Duration::from_secs(2));
        let client = apply_http_client_proxy(
            builder,
            Some(&format!("http://127.0.0.1:{}", address.port())),
        )
        .unwrap()
        .build()
        .unwrap();
        assert_eq!(
            client
                .get("http://target.invalid/probe")
                .send()
                .unwrap()
                .text()
                .unwrap(),
            "ok"
        );
        proxy.join().unwrap();
    }
}
