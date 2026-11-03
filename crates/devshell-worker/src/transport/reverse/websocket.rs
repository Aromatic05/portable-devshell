use std::net::TcpStream;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use reqwest::header::AUTHORIZATION;
use tungstenite::client::IntoClientRequest;
use tungstenite::http::HeaderValue;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Error as WebSocketError, Message, WebSocket, client_tls};

use crate::daemon::log::append_log;

use super::{ReverseConnector, proxy, reverse_endpoint};

const WSS_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(15);
const WSS_WRITE_TIMEOUT: Duration = Duration::from_secs(15);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(15);
pub(super) const HEARTBEAT_TIMEOUT_ERROR: &str = "reverse websocket heartbeat timed out";

/// A readable TCP socket is not necessarily alive: blackholed networks do not
/// send FIN/RST. An explicit Ping/Pong exchange provides a bounded liveness
/// check without confusing a temporary read timeout with a broken link.
struct WssHeartbeat {
    next_ping: Instant,
    outstanding: Option<(Vec<u8>, Instant)>,
    sequence: u64,
}

impl WssHeartbeat {
    fn new(now: Instant) -> Self {
        Self {
            next_ping: now + HEARTBEAT_INTERVAL,
            outstanding: None,
            sequence: 0,
        }
    }

    fn tick(&mut self, now: Instant) -> Result<Option<Vec<u8>>, String> {
        if let Some((_, deadline)) = &self.outstanding {
            if now >= *deadline {
                return Err(HEARTBEAT_TIMEOUT_ERROR.to_string());
            }
            return Ok(None);
        }
        if now < self.next_ping {
            return Ok(None);
        }
        self.sequence = self.sequence.wrapping_add(1);
        let token = self.sequence.to_be_bytes().to_vec();
        self.outstanding = Some((token.clone(), now + HEARTBEAT_TIMEOUT));
        Ok(Some(token))
    }

    fn pong(&mut self, payload: &[u8], now: Instant) -> bool {
        if self
            .outstanding
            .as_ref()
            .is_some_and(|(token, _)| token == payload)
        {
            self.outstanding = None;
            self.next_ping = now + HEARTBEAT_INTERVAL;
            return true;
        }
        false
    }
}

impl ReverseConnector {
    pub(super) fn connect_wss(
        &self,
        generation: u64,
    ) -> Result<(WebSocket<MaybeTlsStream<TcpStream>>, bool), String> {
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
            HeaderValue::from_static("devshell-worker-transport.v1, devshell-worker-transport.v2"),
        );

        let bridge = self.bridge.clone();
        let (stream, attempt) = proxy::connect_tcp(
            self.config.proxy_url.as_deref(),
            &endpoint,
            Instant::now() + WSS_ATTEMPT_TIMEOUT,
            move || bridge.is_stopping(),
        )?;
        let result = client_tls(request, stream)
            .map_err(|error| format!("failed to connect reverse websocket: {error}"));
        drop(attempt);
        let (mut socket, response) = result?;
        let acknowledged = response
            .headers()
            .get("sec-websocket-protocol")
            .is_some_and(|value| value == "devshell-worker-transport.v2");
        set_websocket_read_timeout(&mut socket, Some(Duration::from_millis(50)))?;
        let abandoned = self.bridge.prepare()?;
        if abandoned > 0 {
            let _ = append_log(
                &self.paths,
                &format!(
                    "reverse discarded {abandoned} stale Frame(s) on WSS reconnect; prior RPC result is uncertain"
                ),
            );
        }
        append_log(
            &self.paths,
            &format!(
                "reverse connection established transport=wss generation={generation} acknowledged={acknowledged}"
            ),
        )?;
        Ok((socket, acknowledged))
    }

    pub(super) fn run_wss(
        &self,
        mut socket: WebSocket<MaybeTlsStream<TcpStream>>,
        acknowledged: bool,
    ) -> Result<(), String> {
        let mut remote_frame_received = false;
        let ready_deadline = Instant::now() + Duration::from_secs(60);
        // Each connection starts a fresh Frame/Envelope stream and sequence;
        // never replay raw DATA from the previous physical transport.
        let mut sent_through = 0_u64;
        let mut heartbeat = WssHeartbeat::new(Instant::now());
        while !self.bridge.is_stopping() {
            if !remote_frame_received && Instant::now() >= ready_deadline {
                return Err("reverse Ready timed out".to_string());
            }
            if self.reconnect_requested.swap(false, Ordering::SeqCst) {
                return Err("reverse reconnect requested".to_string());
            }
            if let Some(token) = heartbeat.tick(Instant::now())? {
                self.send_wss(&mut socket, Message::Ping(token.into()))
                    .map_err(|error| error.to_string())?;
            }
            self.flush_wss_responses(&mut socket, acknowledged, &mut sent_through)?;
            match socket.read() {
                Ok(Message::Binary(frame)) => {
                    if let Some(response) = self.bridge.accept_inbound(&frame)? {
                        if acknowledged {
                            self.bridge.requeue_front(response)?;
                        } else if let Err(error) =
                            self.send_wss(&mut socket, Message::Binary(response.clone().into()))
                        {
                            self.bridge.requeue_front(response)?;
                            return Err(error.to_string());
                        }
                    }
                    // Legacy binary traffic does not prove Control completed
                    // its Ready handshake. Only the existing Ready event does.
                }
                Ok(Message::Ping(payload)) => {
                    self.send_wss(&mut socket, Message::Pong(payload))
                        .map_err(|error| error.to_string())?;
                }
                Ok(Message::Close(_)) => return Err("controller closed websocket".to_string()),
                Ok(Message::Text(text)) if acknowledged => {
                    if text.as_str() == "DSR2:ready" {
                        remote_frame_received = true;
                        let _ = super::state::write(&self.paths, "connected", Some("wss"), None);
                    } else {
                        self.accept_wss_ack(text.as_str(), sent_through)?;
                    }
                }
                Ok(Message::Text(_)) => {
                    return Err("controller sent text on binary RPC websocket".to_string());
                }
                Ok(Message::Pong(payload)) => {
                    heartbeat.pong(&payload, Instant::now());
                }
                Ok(Message::Frame(_)) => {}
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
        acknowledged: bool,
        sent_through: &mut u64,
    ) -> Result<(), String> {
        if !acknowledged {
            while let Some(response) = self.bridge.try_pop_outbound()? {
                if let Err(error) = self.send_wss(socket, Message::Binary(response.clone().into()))
                {
                    self.bridge.requeue_front(response)?;
                    return Err(error.to_string());
                }
            }
            return Ok(());
        }
        while let Some((seq, response)) = self.bridge.next_wss_frame(*sent_through)? {
            let mut packet = Vec::with_capacity(28 + response.len());
            packet.extend_from_slice(b"DSR2");
            packet.extend_from_slice(&self.bridge.wss_session()?);
            packet.extend_from_slice(&seq.to_be_bytes());
            packet.extend_from_slice(&response);
            // The frame stays in the bounded inflight queue even after send Ok;
            // only an application ACK can retire it. Never replay the ToolCall.
            self.send_wss(socket, Message::Binary(packet.into()))
                .map_err(|error| error.to_string())?;
            *sent_through = seq;
        }
        Ok(())
    }

    fn send_wss(
        &self,
        socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
        message: Message,
    ) -> Result<(), String> {
        let bridge = self.bridge.clone();
        send_with_deadline(socket, message, WSS_WRITE_TIMEOUT, move || {
            bridge.is_stopping()
        })
    }

    fn accept_wss_ack(&self, ack: &str, sent_through: u64) -> Result<(), String> {
        let (session, seq) = ack
            .strip_prefix("DSR2:")
            .and_then(|value| value.split_once(':'))
            .ok_or_else(|| "invalid reverse WSS acknowledgement".to_string())?;
        let expected = uuid::Uuid::from_bytes(self.bridge.wss_session()?)
            .simple()
            .to_string();
        let seq = seq
            .parse::<u64>()
            .map_err(|_| "invalid reverse WSS acknowledgement sequence".to_string())?;
        if session != expected || seq == 0 || seq > sent_through {
            return Err("reverse WSS acknowledgement does not match a sent frame".to_string());
        }
        self.bridge.acknowledge_wss_frame(seq)
    }
}

fn set_websocket_read_timeout(
    socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    timeout: Option<Duration>,
) -> Result<(), String> {
    let stream = websocket_tcp(socket)?;
    stream
        .set_read_timeout(timeout)
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(WSS_WRITE_TIMEOUT))
        .map_err(|error| error.to_string())
}

fn send_with_deadline(
    socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    message: Message,
    timeout: Duration,
    stopping: impl Fn() -> bool + Send + 'static,
) -> Result<(), String> {
    let guard = proxy::deadline::SocketDeadline::new(
        websocket_tcp(socket)?,
        Instant::now() + timeout,
        stopping,
    )?;
    let result = socket.send(message).map_err(|error| error.to_string());
    drop(guard);
    result
}

fn websocket_tcp(
    socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
) -> Result<&mut TcpStream, String> {
    match socket.get_mut() {
        MaybeTlsStream::Plain(stream) => Ok(stream),
        MaybeTlsStream::Rustls(stream) => Ok(&mut stream.sock),
        _ => Err("unsupported reverse websocket TLS backend".into()),
    }
}

#[cfg(test)]
mod heartbeat_tests {
    use super::{HEARTBEAT_INTERVAL, HEARTBEAT_TIMEOUT, WssHeartbeat};
    use std::time::{Duration, Instant};

    #[test]
    fn established_blocking_write_is_interrupted_by_deadline() {
        use std::net::{TcpListener, TcpStream};
        use tungstenite::{Message, WebSocket, protocol::Role, stream::MaybeTlsStream};
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (_unread_peer, _) = listener.accept().unwrap();
        let mut socket =
            WebSocket::from_raw_socket(MaybeTlsStream::Plain(client), Role::Client, None);
        let started = Instant::now();
        let result = super::send_with_deadline(
            &mut socket,
            Message::Binary(vec![0; 32 * 1024 * 1024].into()),
            Duration::from_millis(200),
            || false,
        );
        assert!(result.is_err());
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn stop_interrupts_blocked_handshake_without_waiting_for_deadline() {
        use std::io::Read;
        use std::net::{TcpListener, TcpStream};
        use std::sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        };
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (_unread_peer, _) = listener.accept().unwrap();
        let stopped = Arc::new(AtomicBool::new(false));
        let signal = stopped.clone();
        let guard = super::proxy::deadline::SocketDeadline::new(
            &client,
            Instant::now() + Duration::from_secs(30),
            move || signal.load(Ordering::SeqCst),
        )
        .unwrap();
        stopped.store(true, Ordering::SeqCst);
        let started = Instant::now();
        let mut byte = [0];
        assert_eq!(client.read(&mut byte).unwrap(), 0);
        assert!(started.elapsed() < Duration::from_secs(2));
        drop(guard);
    }

    #[test]
    fn silent_half_open_socket_times_out_after_unanswered_ping() {
        let start = Instant::now();
        let mut liveness = WssHeartbeat::new(start);
        assert_eq!(liveness.tick(start).unwrap(), None);
        let token = liveness.tick(start + HEARTBEAT_INTERVAL).unwrap().unwrap();
        assert_eq!(token.len(), 8);
        assert_eq!(
            liveness
                .tick(start + HEARTBEAT_INTERVAL + HEARTBEAT_TIMEOUT - Duration::from_millis(1))
                .unwrap(),
            None,
        );
        assert!(
            liveness
                .tick(start + HEARTBEAT_INTERVAL + HEARTBEAT_TIMEOUT)
                .unwrap_err()
                .contains("heartbeat timed out")
        );
    }

    #[test]
    fn matching_pong_resets_deadline_but_stale_pong_does_not() {
        let start = Instant::now();
        let mut liveness = WssHeartbeat::new(start);
        let token = liveness.tick(start + HEARTBEAT_INTERVAL).unwrap().unwrap();
        liveness.pong(b"stale", start + HEARTBEAT_INTERVAL);
        assert!(
            liveness
                .tick(start + HEARTBEAT_INTERVAL + HEARTBEAT_TIMEOUT)
                .is_err()
        );
        let mut liveness = WssHeartbeat::new(start);
        let token = liveness.tick(start + HEARTBEAT_INTERVAL).unwrap().unwrap();
        liveness.pong(&token, start + HEARTBEAT_INTERVAL + Duration::from_secs(2));
        assert_eq!(
            liveness
                .tick(start + HEARTBEAT_INTERVAL + HEARTBEAT_TIMEOUT)
                .unwrap(),
            None
        );
        assert!(
            liveness
                .tick(start + HEARTBEAT_INTERVAL + HEARTBEAT_TIMEOUT + Duration::from_secs(2))
                .unwrap()
                .is_some()
        );
    }
}
