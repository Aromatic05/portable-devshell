mod http;
mod socks;

use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use reqwest::blocking::ClientBuilder;
use url::Url;

const PROXY_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

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

pub(crate) fn connect_tcp(proxy_url: &str, target: &Url) -> Result<TcpStream, String> {
    let proxy = parse_proxy_url(proxy_url)?;
    let proxy_host = proxy
        .host_str()
        .ok_or_else(|| "reverse proxy URL requires a host".to_string())?;
    let proxy_port = proxy.port().unwrap_or(match proxy.scheme() {
        "http" => 80,
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

    let mut last_error = None;
    let mut stream = None;
    for address in (proxy_host, proxy_port)
        .to_socket_addrs()
        .map_err(|error| {
            format!("failed to resolve reverse proxy {proxy_host}:{proxy_port}: {error}")
        })?
    {
        match TcpStream::connect_timeout(&address, PROXY_CONNECT_TIMEOUT) {
            Ok(candidate) => {
                stream = Some(candidate);
                break;
            }
            Err(error) => last_error = Some(error),
        }
    }
    let mut stream = stream.ok_or_else(|| {
        format!(
            "failed to connect reverse proxy {proxy_host}:{proxy_port}: {}",
            last_error
                .map(|error| error.to_string())
                .unwrap_or_else(|| "proxy did not resolve to an address".to_string())
        )
    })?;
    stream
        .set_read_timeout(Some(PROXY_CONNECT_TIMEOUT))
        .map_err(|error| format!("failed to configure reverse proxy read timeout: {error}"))?;
    stream
        .set_write_timeout(Some(PROXY_CONNECT_TIMEOUT))
        .map_err(|error| format!("failed to configure reverse proxy write timeout: {error}"))?;

    match proxy.scheme() {
        "http" => http::connect(&mut stream, target_host, target_port)?,
        "socks5" => socks::connect(&mut stream, target_host, target_port, false)?,
        "socks5h" => socks::connect(&mut stream, target_host, target_port, true)?,
        _ => unreachable!(),
    }

    stream
        .set_read_timeout(None)
        .map_err(|error| format!("failed to clear reverse proxy read timeout: {error}"))?;
    stream
        .set_write_timeout(None)
        .map_err(|error| format!("failed to clear reverse proxy write timeout: {error}"))?;
    stream
        .set_nodelay(true)
        .map_err(|error| format!("failed to enable reverse proxy TCP_NODELAY: {error}"))?;
    Ok(stream)
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;
    use std::time::Duration;

    use reqwest::blocking::Client;

    use super::apply_http_client_proxy;

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
