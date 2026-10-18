use std::net::TcpStream;
use std::time::{Duration, Instant};

use reqwest::header::AUTHORIZATION;
use tungstenite::client::IntoClientRequest;
use tungstenite::http::HeaderValue;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Error as WebSocketError, Message, WebSocket, client_tls, connect};

use crate::daemon::log::append_log;

use super::{ReverseConnector, proxy, reverse_endpoint};

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

    fn pong(&mut self, payload: &[u8], now: Instant) {
        if self
            .outstanding
            .as_ref()
            .is_some_and(|(token, _)| token == payload)
        {
            self.outstanding = None;
            self.next_ping = now + HEARTBEAT_INTERVAL;
        }
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

        let (mut socket, response) = if let Some(proxy_url) = self.config.proxy_url.as_deref() {
            let stream = proxy::connect_tcp(proxy_url, &endpoint)?;
            client_tls(request, stream)
                .map_err(|error| format!("failed to connect reverse websocket: {error}"))?
        } else {
            connect(request)
                .map_err(|error| format!("failed to connect reverse websocket: {error}"))?
        };
        let acknowledged = response
            .headers()
            .get("sec-websocket-protocol")
            .is_some_and(|value| value == "devshell-worker-transport.v2");
        set_websocket_read_timeout(&mut socket, Some(Duration::from_millis(50)))?;
        self.bridge.prepare()?;
        if !acknowledged {
            // Older Control versions speak v1. Preserve inflight results in
            // their original order, without presenting v2 headers to v1.
            self.bridge.requeue_wss_inflight()?;
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
        // Old frames refer to the previous FrameProtocol stream. Allow the
        // replacement session to open its Envelope stream and send its first
        // RPC before replaying any old DATA; never prefix a fresh service OPEN
        // with stale DATA from the retired transport.
        let mut sent_through = if acknowledged {
            self.bridge.highest_unacknowledged_wss_sequence()?
        } else {
            0
        };
        let mut replay_waiting = acknowledged && sent_through > 0;
        let mut inbound_frames = 0_u32;
        let mut heartbeat = WssHeartbeat::new(Instant::now());
        while !self.bridge.is_stopping() {
            if let Some(token) = heartbeat.tick(Instant::now())? {
                socket
                    .send(Message::Ping(token.into()))
                    .map_err(|error| error.to_string())?;
            }
            self.flush_wss_responses(&mut socket, acknowledged, &mut sent_through)?;
            match socket.read() {
                Ok(Message::Binary(frame)) => {
                    if let Some(response) = self.bridge.accept_inbound(&frame)? {
                        if acknowledged {
                            self.bridge.requeue_front(response)?;
                        } else if let Err(error) =
                            socket.send(Message::Binary(response.clone().into()))
                        {
                            self.bridge.requeue_front(response)?;
                            return Err(error.to_string());
                        }
                    }
                    // HTTP 101 alone does not mean Control accepted this
                    // connection. Wait until it actually sends a valid frame.
                    if !remote_frame_received {
                        remote_frame_received = true;
                        let _ = super::state::write(&self.paths, "connected", Some("wss"), None);
                    }
                    inbound_frames = inbound_frames.saturating_add(1);
                    if replay_waiting && inbound_frames >= 2 {
                        replay_waiting = false;
                        sent_through = 0;
                    }
                }
                Ok(Message::Ping(payload)) => {
                    socket
                        .send(Message::Pong(payload))
                        .map_err(|error| error.to_string())?;
                }
                Ok(Message::Close(_)) => return Err("controller closed websocket".to_string()),
                Ok(Message::Text(text)) if acknowledged => {
                    self.accept_wss_ack(text.as_str(), sent_through)?;
                }
                Ok(Message::Text(_)) => {
                    return Err("controller sent text on binary RPC websocket".to_string());
                }
                Ok(Message::Pong(payload)) => heartbeat.pong(&payload, Instant::now()),
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
                if let Err(error) = socket.send(Message::Binary(response.clone().into())) {
                    self.bridge.requeue_front(response)?;
                    return Err(error.to_string());
                }
            }
            return Ok(());
        }
        while let Some((seq, response)) = self.bridge.next_wss_frame(*sent_through)? {
            let mut packet = Vec::with_capacity(28 + response.len());
            packet.extend_from_slice(b"DSR2");
            packet.extend_from_slice(&self.bridge.wss_session());
            packet.extend_from_slice(&seq.to_be_bytes());
            packet.extend_from_slice(&response);
            // The frame stays in the bounded inflight queue even after send Ok;
            // only an application ACK can retire it. Never replay the ToolCall.
            socket
                .send(Message::Binary(packet.into()))
                .map_err(|error| error.to_string())?;
            *sent_through = seq;
        }
        Ok(())
    }

    fn accept_wss_ack(&self, ack: &str, sent_through: u64) -> Result<(), String> {
        let (session, seq) = ack
            .strip_prefix("DSR2:")
            .and_then(|value| value.split_once(':'))
            .ok_or_else(|| "invalid reverse WSS acknowledgement".to_string())?;
        let expected = uuid::Uuid::from_bytes(self.bridge.wss_session())
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

#[cfg(test)]
mod heartbeat_tests {
    use super::{HEARTBEAT_INTERVAL, HEARTBEAT_TIMEOUT, WssHeartbeat};
    use std::time::{Duration, Instant};

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
