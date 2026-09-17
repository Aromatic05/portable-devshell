use std::net::TcpStream;
use std::time::Duration;

use reqwest::header::AUTHORIZATION;
use tungstenite::client::IntoClientRequest;
use tungstenite::http::HeaderValue;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Error as WebSocketError, Message, WebSocket, client_tls, connect};

use crate::daemon::log::append_log;

use super::{ReverseConnector, proxy, reverse_endpoint};

impl ReverseConnector {
    pub(super) fn connect_wss(
        &self,
        generation: u64,
    ) -> Result<WebSocket<MaybeTlsStream<TcpStream>>, String> {
        let endpoint = reverse_endpoint(&self.config.controller_url, "/reverse/v1/connect", true)?;
        let mut request = endpoint
            .as_str()
            .into_client_request()
            .map_err(|error| format!("failed to build websocket request: {error}"))?;
        let headers = request.headers_mut();
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", self.config.device_token))
                .map_err(|error| error.to_string())?,
        );
        headers.insert(
            "x-devshell-instance",
            HeaderValue::from_str(self.instance.as_str()).map_err(|error| error.to_string())?,
        );
        headers.insert(
            "x-devshell-generation",
            HeaderValue::from_str(&generation.to_string()).map_err(|error| error.to_string())?,
        );
        headers.insert(
            "sec-websocket-protocol",
            HeaderValue::from_static("devshell-worker-transport.v1"),
        );

        let (mut socket, _) = if let Some(proxy_url) = self.config.proxy_url.as_deref() {
            let stream = proxy::connect_tcp(proxy_url, &endpoint)?;
            client_tls(request, stream)
                .map_err(|error| format!("failed to connect reverse websocket: {error}"))?
        } else {
            connect(request)
                .map_err(|error| format!("failed to connect reverse websocket: {error}"))?
        };
        set_websocket_read_timeout(&mut socket, Some(Duration::from_millis(50)))?;
        self.payload.prepare_connection()?;
        append_log(
            &self.paths,
            &format!("reverse connection established transport=wss generation={generation}"),
        )?;
        Ok(socket)
    }

    pub(super) fn run_wss(
        &self,
        mut socket: WebSocket<MaybeTlsStream<TcpStream>>,
    ) -> Result<(), String> {
        while !self.payload.is_stopping() {
            self.flush_wss_responses(&mut socket)?;
            match socket.read() {
                Ok(Message::Binary(frame)) => {
                    if let Some(response) = self.payload.accept_inbound(&frame)?
                        && let Err(error) =
                            socket.send(Message::Binary(response.frame.clone().into()))
                    {
                        self.payload.requeue_front(response)?;
                        return Err(error.to_string());
                    }
                }
                Ok(Message::Ping(payload)) => {
                    socket
                        .send(Message::Pong(payload))
                        .map_err(|error| error.to_string())?;
                }
                Ok(Message::Close(_)) => return Err("controller closed websocket".to_string()),
                Ok(Message::Text(_)) => {
                    return Err("controller sent text on binary RPC websocket".to_string());
                }
                Ok(Message::Pong(_) | Message::Frame(_)) => {}
                Err(WebSocketError::Io(error))
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) => {}
                Err(error) => return Err(error.to_string()),
            }
        }

        let _ = socket.close(None);
        Ok(())
    }

    pub(super) fn flush_wss_responses(
        &self,
        socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    ) -> Result<(), String> {
        while let Some(response) = self.payload.try_pop_outbound()? {
            if let Err(error) = socket.send(Message::Binary(response.frame.clone().into())) {
                self.payload.requeue_front(response)?;
                return Err(error.to_string());
            }
        }
        Ok(())
    }
}

fn set_websocket_read_timeout(
    socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    timeout: Option<Duration>,
) -> Result<(), String> {
    match socket.get_mut() {
        MaybeTlsStream::Plain(stream) => stream
            .set_read_timeout(timeout)
            .map_err(|error| format!("failed to configure websocket read timeout: {error}")),
        MaybeTlsStream::Rustls(stream) => stream
            .sock
            .set_read_timeout(timeout)
            .map_err(|error| format!("failed to configure websocket read timeout: {error}")),
        _ => Ok(()),
    }
}
