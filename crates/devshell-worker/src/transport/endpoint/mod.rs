pub mod channel;

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream};
use std::process::{ChildStdin, ChildStdout};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::Duration;

use serde_json::Value;

use crate::capability::artifact::payload::{ArtifactPayloadReader, ArtifactPayloadStore};
use crate::capability::artifact::receive::ArtifactReceiveStore;
use crate::capability::rpc::error::RpcError as WorkerRpcError;
use crate::capability::rpc::request::{RpcRequest, RpcRequestContext};
use crate::capability::rpc::response::RpcResponse;
use crate::capability::rpc::router::RpcRouter;
use crate::transport::envelope::{Address, Envelope, EnvelopeDecoder, encode as encode_envelope};
use crate::transport::frame::{
    FRAME_MAX_DATA_SIZE, Frame, FrameDecoder, FrameEvent, FrameProtocol, FrameRole,
    RESET_UNSUPPORTED_SERVICE, encode_frame,
};
use crate::transport::packet::stream::{ExecService, TcpService};
use crate::transport::packet::{
    self, EventPacket, Packet, RpcError, RpcPacket, StreamError, StreamPacket,
};

use channel::LocalIpcStream;

const ENVELOPE_SERVICE: &str = "envelope";
const RECEIVE_WINDOW: u32 = 256 * 1024;
const POLL_INTERVAL: Duration = Duration::from_millis(20);

#[derive(Clone)]
pub struct EndpointContext {
    host: String,
    payloads: Arc<ArtifactPayloadStore>,
    receives: Arc<ArtifactReceiveStore>,
    router: Arc<RpcRouter>,
}

impl EndpointContext {
    pub fn new(
        instance: &str,
        router: Arc<RpcRouter>,
        payloads: Arc<ArtifactPayloadStore>,
        receives: Arc<ArtifactReceiveStore>,
    ) -> Self {
        Self {
            host: format!("{instance}-worker"),
            payloads,
            receives,
            router,
        }
    }
}

enum EndpointEvent {
    ChannelData(Vec<u8>),
    ChannelClosed,
    ChannelFailed(String),
    Outbound(Envelope),
    StreamOpened {
        id: String,
        generation: Arc<()>,
        result: Result<ByteService, String>,
        input: Receiver<StreamInputCommand>,
    },
    StreamData { id: String, data: Vec<u8> },
    StreamInputFinished { id: String },
    StreamOutputFinished { id: String },
    StreamFailed { id: String, error: String },
}

enum StreamInputCommand {
    Data(Vec<u8>),
    Finish,
}

enum StreamInput {
    Tcp(TcpStream),
    Exec(Option<ChildStdin>),
    PayloadRead,
    ReceiveWrite {
        offset_bytes: Arc<AtomicU64>,
        receive_id: String,
        receives: Arc<ArtifactReceiveStore>,
    },
}

impl StreamInput {
    fn write(&mut self, data: &[u8]) -> Result<(), String> {
        match self {
            Self::Tcp(stream) => stream
                .write_all(data)
                .map_err(|error| format!("network.tcp write failed: {error}")),
            Self::Exec(stdin) => stdin
                .as_mut()
                .ok_or_else(|| "process.exec stdin is closed.".to_string())?
                .write_all(data)
                .map_err(|error| format!("process.exec stdin write failed: {error}")),
            Self::PayloadRead => Err("artifact.payload.read does not accept input.".to_string()),
            Self::ReceiveWrite {
                offset_bytes,
                receive_id,
                receives,
                ..
            } => {
                let offset = offset_bytes.load(Ordering::SeqCst);
                let result = receives
                    .write_bytes(receive_id, offset, data)
                    .map_err(|error| error.message)?;
                offset_bytes.store(result.next_offset_bytes, Ordering::SeqCst);
                Ok(())
            }
        }
    }

    fn finish(&mut self) -> Result<(), String> {
        match self {
            Self::Tcp(stream) => stream
                .shutdown(Shutdown::Write)
                .map_err(|error| format!("network.tcp half-close failed: {error}")),
            Self::Exec(stdin) => {
                stdin.take();
                Ok(())
            }
            Self::PayloadRead => Ok(()),
            Self::ReceiveWrite { .. } => Ok(()),
        }
    }
}

enum StreamOutput {
    Tcp(TcpStream),
    Exec(ChildStdout),
    PayloadRead(ArtifactPayloadReader),
    ReceiveWrite,
}

impl StreamOutput {
    fn read(&mut self, buffer: &mut [u8]) -> Result<usize, String> {
        match self {
            Self::Tcp(stream) => stream
                .read(buffer)
                .map_err(|error| format!("network.tcp read failed: {error}")),
            Self::Exec(stdout) => stdout
                .read(buffer)
                .map_err(|error| format!("process.exec stdout read failed: {error}")),
            Self::PayloadRead(reader) => reader
                .read(buffer)
                .map_err(|error| format!("artifact.payload.read failed: {error}")),
            Self::ReceiveWrite => Ok(0),
        }
    }
}

enum ByteService {
    Opening(Arc<()>),
    Tcp(TcpService),
    Exec(ExecService),
    PayloadRead {
        eof: bool,
        offset_bytes: u64,
        payload_id: String,
        reader: Option<ArtifactPayloadReader>,
        returned_bytes: usize,
        total_bytes: usize,
    },
    ReceiveWrite {
        finished: bool,
        offset_bytes: Arc<AtomicU64>,
        receive_id: String,
        receives: Arc<ArtifactReceiveStore>,
    },
}

impl ByteService {
    fn open(
        port: &str,
        name: &str,
        message: Option<Value>,
        context: &EndpointContext,
    ) -> Result<Self, String> {
        let message = message.unwrap_or(Value::Null);
        match (port, name) {
            ("network", "tcp") => TcpService::open(
                &serde_json::to_vec(&message).map_err(|error| error.to_string())?,
            )
            .map(Self::Tcp),
            ("process", "exec") => ExecService::open(
                &serde_json::to_vec(&message).map_err(|error| error.to_string())?,
            )
            .map(Self::Exec),
            ("artifact", "payload.read") => {
                #[derive(serde::Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct Input {
                    max_bytes: usize,
                    offset_bytes: u64,
                    payload_id: String,
                }
                let input: Input =
                    serde_json::from_value(message).map_err(|error| error.to_string())?;
                let reader = context
                    .payloads
                    .open_reader(&input.payload_id, input.offset_bytes, input.max_bytes)
                    .map_err(|error| error.message)?;
                let total_bytes = reader.total_bytes();
                let offset =
                    usize::try_from(input.offset_bytes).map_err(|error| error.to_string())?;
                let returned_bytes = total_bytes
                    .saturating_sub(offset)
                    .min(input.max_bytes);
                Ok(Self::PayloadRead {
                    eof: offset.saturating_add(returned_bytes) >= total_bytes,
                    offset_bytes: input.offset_bytes,
                    payload_id: input.payload_id,
                    reader: Some(reader),
                    returned_bytes,
                    total_bytes,
                })
            }
            ("artifact", "receive.write") => {
                #[derive(serde::Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct Input {
                    offset_bytes: u64,
                    receive_id: String,
                }
                let input: Input =
                    serde_json::from_value(message).map_err(|error| error.to_string())?;
                Ok(Self::ReceiveWrite {
                    finished: false,
                    offset_bytes: Arc::new(AtomicU64::new(input.offset_bytes)),
                    receive_id: input.receive_id,
                    receives: Arc::clone(&context.receives),
                })
            }
            _ => Err(format!("Unsupported Stream {port}:{name}.")),
        }
    }

    fn take_input(&mut self) -> Result<StreamInput, String> {
        match self {
            Self::Opening(_) => Err("Stream is still opening.".to_string()),
            Self::Tcp(service) => service.clone_stream().map(StreamInput::Tcp),
            Self::Exec(service) => service.take_stdin().map(|value| StreamInput::Exec(Some(value))),
            Self::PayloadRead { .. } => Ok(StreamInput::PayloadRead),
            Self::ReceiveWrite {
                offset_bytes,
                receive_id,
                receives,
                ..
            } => Ok(StreamInput::ReceiveWrite {
                offset_bytes: Arc::clone(offset_bytes),
                receive_id: receive_id.clone(),
                receives: Arc::clone(receives),
            }),
        }
    }

    fn take_output(&mut self) -> Result<StreamOutput, String> {
        match self {
            Self::Opening(_) => Err("Stream is still opening.".to_string()),
            Self::Tcp(service) => service.clone_stream().map(StreamOutput::Tcp),
            Self::Exec(service) => service.take_stdout().map(StreamOutput::Exec),
            Self::PayloadRead { reader, .. } => reader
                .take()
                .map(StreamOutput::PayloadRead)
                .ok_or_else(|| "artifact payload reader is already taken.".to_string()),
            Self::ReceiveWrite { .. } => Ok(StreamOutput::ReceiveWrite),
        }
    }

    fn output_complete(&mut self) -> Result<bool, String> {
        match self {
            Self::Opening(_) => Ok(false),
            Self::Tcp(_) => Ok(true),
            Self::Exec(service) => service.poll_status(),
            Self::PayloadRead { .. } => Ok(true),
            Self::ReceiveWrite { finished, .. } => Ok(*finished),
        }
    }

    fn input_finished(&mut self) {
        if let Self::ReceiveWrite { finished, .. } = self {
            *finished = true;
        }
    }

    fn close_message(&self) -> Option<Value> {
        match self {
            Self::PayloadRead {
                eof,
                offset_bytes,
                payload_id,
                returned_bytes,
                total_bytes,
                ..
            } => {
                let next_offset_bytes = offset_bytes.saturating_add(*returned_bytes as u64);
                Some(serde_json::json!({
                    "eof": eof,
                    "nextOffsetBytes": if *eof {
                        Value::Null
                    } else {
                        serde_json::json!(next_offset_bytes)
                    },
                    "offsetBytes": offset_bytes,
                    "payloadId": payload_id,
                    "returnedBytes": returned_bytes,
                    "totalBytes": total_bytes,
                }))
            }
            Self::ReceiveWrite {
                offset_bytes,
                receive_id,
                ..
            } => {
                let offset_bytes = offset_bytes.load(Ordering::SeqCst);
                Some(serde_json::json!({
                    "nextOffsetBytes": offset_bytes,
                    "receivedBytes": offset_bytes,
                    "receiveId": receive_id,
                }))
            }
            Self::Opening(_) | Self::Tcp(_) | Self::Exec(_) => None,
        }
    }

    fn reset(&mut self) {
        match self {
            Self::Opening(_) => {}
            Self::Tcp(service) => service.reset(),
            Self::Exec(service) => service.reset(),
            Self::PayloadRead { .. } | Self::ReceiveWrite { .. } => {}
        }
    }
}

struct ActiveStream {
    service: ByteService,
    input: Sender<StreamInputCommand>,
    source: Address,
    dest: Address,
    recv_seq: u64,
    send_seq: u64,
    output_eof: bool,
}

impl ActiveStream {
    fn opening<F>(
        id: String,
        source: Address,
        dest: Address,
        events: Sender<EndpointEvent>,
        open: F,
    ) -> Self
    where
        F: FnOnce() -> Result<ByteService, String> + Send + 'static,
    {
        let (input, receiver) = mpsc::channel();
        let generation = Arc::new(());
        let pending_generation = Arc::clone(&generation);
        thread::spawn(move || {
            let result = open();
            let _ = events.send(EndpointEvent::StreamOpened {
                id, generation: pending_generation, result, input: receiver,
            });
        });
        Self {
            service: ByteService::Opening(generation),
            input,
            source,
            dest,
            recv_seq: 0,
            send_seq: 0,
            output_eof: false,
        }
    }

    fn open(
        id: &str,
        source: Address,
        dest: Address,
        mut service: ByteService,
        events: Sender<EndpointEvent>,
    ) -> Result<Self, String> {
        let input = service.take_input()?;
        let output = service.take_output()?;
        let (input_tx, input_rx) = mpsc::channel();
        spawn_stream_input(id.to_string(), input, input_rx, events.clone());
        spawn_stream_output(id.to_string(), output, events);
        Ok(Self {
            service,
            input: input_tx,
            source,
            dest,
            recv_seq: 0,
            send_seq: 0,
            output_eof: false,
        })
    }
}

struct PendingOutput {
    data: Vec<u8>,
    offset: usize,
}

pub fn serve_ipc(stream: LocalIpcStream, context: EndpointContext) -> Result<(), String> {
    let input = stream
        .try_clone()
        .map_err(|error| format!("failed to clone transport IPC stream: {error}"))?;
    serve(input, stream, context)
}

fn serve<R, W>(input: R, mut output: W, context: EndpointContext) -> Result<(), String>
where
    R: Read + Send + 'static,
    W: Write,
{
    let (events_tx, events_rx) = mpsc::channel();
    spawn_channel_input(input, events_tx.clone());

    let mut frame_decoder = FrameDecoder::default();
    let mut frame = FrameProtocol::new(FrameRole::Acceptor);
    let mut envelope_decoder = EnvelopeDecoder::default();
    let mut envelope_stream = None;
    let mut pending = VecDeque::<PendingOutput>::new();
    let mut streams = HashMap::<String, ActiveStream>::new();
    let mut peer_host = None::<String>;

    loop {
        match events_rx.recv_timeout(POLL_INTERVAL) {
            Ok(EndpointEvent::ChannelData(data)) => {
                for incoming in frame_decoder.push(&data)? {
                    accept_frame(
                        &mut frame,
                        &mut envelope_decoder,
                        &mut envelope_stream,
                        &mut peer_host,
                        &mut streams,
                        &events_tx,
                        &context,
                        incoming,
                        &mut output,
                    )?;
                }
            }
            Ok(EndpointEvent::ChannelClosed) => return Ok(()),
            Ok(EndpointEvent::ChannelFailed(error)) => return Err(error),
            Ok(EndpointEvent::Outbound(envelope)) => {
                queue_envelope(&mut pending, envelope)?;
            }
            Ok(EndpointEvent::StreamOpened { id, generation, result, input }) => {
                complete_stream_open(&id, &generation, result, input, &mut streams, &events_tx)?;
            }
            Ok(EndpointEvent::StreamData { id, data }) => {
                if let Some(active) = streams.get_mut(&id) {
                    active.send_seq += 1;
                    queue_envelope(
                        &mut pending,
                        stream_envelope(
                            active,
                            StreamPacket::Data {
                                id,
                                seq: active.send_seq,
                                message: None,
                                bytes: Some(data),
                            },
                        )?,
                    )?;
                }
            }
            Ok(EndpointEvent::StreamInputFinished { id }) => {
                if let Some(active) = streams.get_mut(&id) {
                    active.service.input_finished();
                }
                finish_stream_if_ready(&id, &mut streams, &mut pending)?;
            }
            Ok(EndpointEvent::StreamOutputFinished { id }) => {
                if let Some(active) = streams.get_mut(&id) {
                    active.output_eof = true;
                }
                finish_stream_if_ready(&id, &mut streams, &mut pending)?;
            }
            Ok(EndpointEvent::StreamFailed { id, error }) => {
                if let Some(mut active) = streams.remove(&id) {
                    active.service.reset();
                    queue_envelope(
                        &mut pending,
                        stream_envelope(
                            &active,
                            StreamPacket::Cancel {
                                id,
                                error: Some(StreamError {
                                    message: error,
                                    code: None,
                                    details: None,
                                    retryable: None,
                                }),
                            },
                        )?,
                    )?;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
        }

        drain_notifications(&context, peer_host.as_deref(), &mut pending)?;
        let ids = streams
            .iter()
            .filter_map(|(id, active)| active.output_eof.then_some(id.clone()))
            .collect::<Vec<_>>();
        for id in ids {
            finish_stream_if_ready(&id, &mut streams, &mut pending)?;
        }
        if let Some(stream_id) = envelope_stream {
            flush_output(&mut frame, stream_id, &mut pending, &mut output)?;
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn accept_frame<W: Write>(
    frame: &mut FrameProtocol,
    envelope_decoder: &mut EnvelopeDecoder,
    envelope_stream: &mut Option<u32>,
    peer_host: &mut Option<String>,
    streams: &mut HashMap<String, ActiveStream>,
    events: &Sender<EndpointEvent>,
    context: &EndpointContext,
    incoming: Frame,
    output: &mut W,
) -> Result<(), String> {
    let event = frame.accept_frame(incoming)?;
    match event {
        Some(FrameEvent::Open {
            stream_id,
            service,
            ..
        }) => {
            if service != ENVELOPE_SERVICE || envelope_stream.is_some() {
                let reset = frame.reject_open(
                    stream_id,
                    RESET_UNSUPPORTED_SERVICE,
                    format!("Unsupported Endpoint service {service}."),
                )?;
                write_frame(output, &reset)?;
                return Ok(());
            }
            *envelope_stream = Some(stream_id);
            write_frame(output, &frame.accept_open(stream_id, RECEIVE_WINDOW)?)?;
        }
        Some(FrameEvent::Data { stream_id }) => {
            if Some(stream_id) != *envelope_stream {
                return Err("DATA received outside the Envelope stream.".to_string());
            }
            while let Some(data) = frame.read_data(stream_id)? {
                let byte_len = u32::try_from(data.len()).map_err(|error| error.to_string())?;
                for envelope in envelope_decoder.push(&data)? {
                    *peer_host = Some(envelope.source.host.clone());
                    dispatch_envelope(envelope, streams, events, context)?;
                }
                if let Some(window) = frame.consume(stream_id, byte_len)? {
                    write_frame(output, &window)?;
                }
            }
        }
        Some(FrameEvent::Fin { stream_id }) if Some(stream_id) == *envelope_stream => {
            return Err("Envelope stream closed.".to_string());
        }
        Some(FrameEvent::Reset { stream_id, message, .. })
            if Some(stream_id) == *envelope_stream =>
        {
            return Err(message);
        }
        Some(_) | None => {}
    }
    Ok(())
}

fn dispatch_envelope(
    envelope: Envelope,
    streams: &mut HashMap<String, ActiveStream>,
    events: &Sender<EndpointEvent>,
    context: &EndpointContext,
) -> Result<(), String> {
    if envelope.dest.host != context.host {
        return Err(format!("Envelope destination {} is not this Endpoint.", envelope.dest.host));
    }
    let Envelope { source, dest, packet } = envelope;
    match packet {
        Packet::Rpc(packet) => dispatch_rpc(source, dest, packet, events, context),
        Packet::Event(_) => Ok(()),
        Packet::Stream(packet) => {
            dispatch_stream(source, dest, packet, streams, events, context)
        }
    }
}

fn dispatch_rpc(
    source: Address,
    dest: Address,
    packet: RpcPacket,
    events: &Sender<EndpointEvent>,
    context: &EndpointContext,
) -> Result<(), String> {
    match packet {
        RpcPacket::Request {
            id,
            method,
            message,
        } => {
            let router = Arc::clone(&context.router);
            let events = events.clone();
            let port = dest.port.clone();
            // Admission must follow the incoming Envelope order, not thread
            // scheduling order. Otherwise an immediate tool.call.cancel can
            // run before the preceding ToolCall has registered its permit.
            let prepared_tool = if port == "tool" && !router.is_control_method(&method) {
                let request = tool_request(id.clone(), method.clone(), message.clone());
                Some(router.acquire_tool_permit(&request).map(|permit| (request, permit)))
            } else {
                None
            };
            thread::spawn(move || {
                let reply_source = dest;
                let reply_dest = source;
                let response = match prepared_tool {
                    Some(Ok((request, permit))) => router.dispatch_tool(request, permit),
                    Some(Err(error)) => RpcResponse::failure(id, error),
                    None => route_rpc(&router, &port, id, method, message),
                };
                let packet = rpc_response(response);
                let _ = events.send(EndpointEvent::Outbound(Envelope {
                    source: reply_source,
                    dest: reply_dest,
                    packet: Packet::Rpc(packet),
                }));
            });
            Ok(())
        }
        RpcPacket::Cancel { id } => context
            .router
            .cancel_request(&id)
            .map(|_| ())
            .map_err(|error| error.message),
        RpcPacket::Reply { .. } | RpcPacket::Error { .. } => Ok(()),
    }
}

fn route_rpc(
    router: &Arc<RpcRouter>,
    port: &str,
    id: String,
    method: String,
    message: Option<Value>,
) -> RpcResponse {
    if port == "transport" && method == "transport.peer.promote" {
        return RpcResponse::success(id, serde_json::json!({ "promoted": true }));
    }
    if router.is_control_method(&method) {
        if control_port(&method) != port {
            return RpcResponse::failure(
                id,
                WorkerRpcError::new("rpc.methodNotFound", "Control method not found."),
            );
        }
        let request = RpcRequest::request(id.clone(), method, message.unwrap_or(Value::Null));
        if router.is_cancellable_control_method(&request.method) {
            return match router.acquire_control_permit(&request) {
                Ok(permit) => router.dispatch_cancellable_control(request, permit),
                Err(error) => RpcResponse::failure(id, error),
            };
        }
        return router.dispatch_control(request);
    }

    if port != "tool" {
        return RpcResponse::failure(
            id,
            WorkerRpcError::new("rpc.methodNotFound", "Tool method not found."),
        );
    }
    let request = tool_request(id.clone(), method, message);
    match router.acquire_tool_permit(&request) {
        Ok(permit) => router.dispatch_tool(request, permit),
        Err(error) => RpcResponse::failure(id, error),
    }
}

fn tool_request(id: String, method: String, message: Option<Value>) -> RpcRequest {
    let mut body = packet::message_object(message);
    let params = body.remove("input").unwrap_or(Value::Null);
    let context = body
        .remove("context")
        .and_then(|value| serde_json::from_value::<RpcRequestContext>(value).ok());
    let mut request = RpcRequest::request(id, method, params);
    request.context = context;
    request
}

fn control_port(method: &str) -> &'static str {
    if method.starts_with("artifact.") {
        "artifact"
    } else if method.starts_with("terminal.") {
        "terminal"
    } else if method == "tools.list" || method.starts_with("tool.") {
        "tool"
    } else {
        "core"
    }
}

fn rpc_response(response: RpcResponse) -> RpcPacket {
    if response.ok {
        RpcPacket::Reply {
            id: response.id,
            message: response.result,
        }
    } else {
        let error = response.error.expect("failed RPC response requires error");
        RpcPacket::Error {
            id: response.id,
            error: RpcError {
                message: error.message,
                code: Some(error.code),
                details: error.details,
                retryable: Some(error.retryable),
            },
        }
    }
}

fn dispatch_stream(
    source: Address,
    dest: Address,
    packet: StreamPacket,
    streams: &mut HashMap<String, ActiveStream>,
    events: &Sender<EndpointEvent>,
    context: &EndpointContext,
) -> Result<(), String> {
    match packet {
        StreamPacket::Open {
            id,
            name,
            message,
        } => {
            if dest.port == "network" && name == "tcp" {
                // Register the input queue before returning to dispatch so DATA,
                // FIN and cancellation retain their arrival order during connect.
                let context = context.clone();
                let port = dest.port.clone();
                let active = ActiveStream::opening(id.clone(), dest, source, events.clone(), move || {
                    ByteService::open(&port, &name, message, &context)
                });
                streams.insert(id, active);
                return Ok(());
            }
            let service = match ByteService::open(&dest.port, &name, message, context) {
                Ok(service) => service,
                Err(error) => {
                    events
                        .send(EndpointEvent::Outbound(Envelope {
                            source: dest,
                            dest: source,
                            packet: Packet::Stream(StreamPacket::Cancel {
                                id,
                                error: Some(StreamError {
                                    message: error,
                                    code: None,
                                    details: None,
                                    retryable: None,
                                }),
                            }),
                        }))
                        .map_err(|error| error.to_string())?;
                    return Ok(());
                }
            };
            let active = ActiveStream::open(
                &id,
                dest,
                source,
                service,
                events.clone(),
            )?;
            streams.insert(id, active);
        }
        StreamPacket::Data { id, seq, bytes, .. } => {
            let active = streams
                .get_mut(&id)
                .ok_or_else(|| format!("Unknown Stream {id}."))?;
            if seq != active.recv_seq + 1 {
                return Err(format!("Stream {id} sequence is invalid."));
            }
            active.recv_seq = seq;
            let bytes = bytes
                .ok_or_else(|| "Stream byte packet is invalid.".to_string())?;
            active
                .input
                .send(StreamInputCommand::Data(bytes))
                .map_err(|error| error.to_string())?;
        }
        StreamPacket::Fin { id } => {
            if let Some(active) = streams.get(&id) {
                active
                    .input
                    .send(StreamInputCommand::Finish)
                    .map_err(|error| error.to_string())?;
            }
        }
        StreamPacket::Close { id, .. } => {
            if let Some(mut active) = streams.remove(&id) {
                active.service.reset();
            }
        }
        StreamPacket::Cancel { id, .. } => {
            if let Some(mut active) = streams.remove(&id) {
                active.service.reset();
            }
        }
    }
    Ok(())
}

fn complete_stream_open(
    id: &str,
    generation: &Arc<()>,
    result: Result<ByteService, String>,
    input: Receiver<StreamInputCommand>,
    streams: &mut HashMap<String, ActiveStream>,
    events: &Sender<EndpointEvent>,
) -> Result<(), String> {
    let Some(active) = streams.get_mut(id) else {
        return Ok(());
    };
    if !matches!(&active.service, ByteService::Opening(current) if Arc::ptr_eq(current, generation)) {
        return Ok(());
    }
    let opened = result.and_then(|mut service| {
        let writer = service.take_input()?;
        let reader = service.take_output()?;
        spawn_stream_input(id.to_string(), writer, input, events.clone());
        spawn_stream_output(id.to_string(), reader, events.clone());
        active.service = service;
        Ok(())
    });
    if let Err(error) = opened {
        let active = streams.remove(id).expect("opening stream exists");
        events
            .send(EndpointEvent::Outbound(stream_envelope(
                &active,
                StreamPacket::Cancel {
                    id: id.to_string(),
                    error: Some(StreamError {
                        message: error,
                        code: None,
                        details: None,
                        retryable: None,
                    }),
                },
            )?))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn stream_envelope(active: &ActiveStream, packet: StreamPacket) -> Result<Envelope, String> {
    Ok(Envelope {
        source: active.source.clone(),
        dest: active.dest.clone(),
        packet: Packet::Stream(packet),
    })
}

fn finish_stream_if_ready(
    id: &str,
    streams: &mut HashMap<String, ActiveStream>,
    pending: &mut VecDeque<PendingOutput>,
) -> Result<(), String> {
    let ready = match streams.get_mut(id) {
        Some(active) if active.output_eof => active.service.output_complete(),
        _ => return Ok(()),
    };
    match ready {
        Ok(true) => {
            let active = streams.remove(id).expect("stream exists");
            let message = active.service.close_message();
            queue_envelope(
                pending,
                stream_envelope(
                    &active,
                    StreamPacket::Close {
                        id: id.to_string(),
                        message,
                    },
                )?,
            )?;
        }
        Ok(false) => {}
        Err(error) => {
            let mut active = streams.remove(id).expect("stream exists");
            active.service.reset();
            queue_envelope(
                pending,
                stream_envelope(
                    &active,
                    StreamPacket::Cancel {
                        id: id.to_string(),
                        error: Some(StreamError {
                            message: error,
                            code: None,
                            details: None,
                            retryable: None,
                        }),
                    },
                )?,
            )?;
        }
    }
    Ok(())
}

fn drain_notifications(
    context: &EndpointContext,
    peer_host: Option<&str>,
    pending: &mut VecDeque<PendingOutput>,
) -> Result<(), String> {
    let Some(peer_host) = peer_host else {
        return Ok(());
    };
    while let Some(notification) = context.router.try_pop_notification()? {
        let method = notification
            .get("method")
            .and_then(Value::as_str)
            .ok_or_else(|| "Worker notification method is missing.".to_string())?;
        let message = notification.get("params").cloned();
        let (port, name) = match method {
            "tool.progress" => ("tool", "progress"),
            "terminal.output" => ("terminal", "output"),
            "terminal.exit" => ("terminal", "exit"),
            "devshell.command.open" => ("core", "command.open"),
            "devshell.command.close" => ("core", "command.close"),
            _ => continue,
        };
        queue_envelope(
            pending,
            Envelope {
                source: Address {
                    host: context.host.clone(),
                    port: port.to_string(),
                },
                dest: Address {
                    host: peer_host.to_string(),
                    port: port.to_string(),
                },
                packet: Packet::Event(EventPacket {
                    name: name.to_string(),
                    message,
                }),
            },
        )?;
    }
    Ok(())
}

fn queue_envelope(
    pending: &mut VecDeque<PendingOutput>,
    envelope: Envelope,
) -> Result<(), String> {
    pending.push_back(PendingOutput {
        data: encode_envelope(&envelope)?,
        offset: 0,
    });
    Ok(())
}

fn flush_output<W: Write>(
    frame: &mut FrameProtocol,
    stream_id: u32,
    pending: &mut VecDeque<PendingOutput>,
    output: &mut W,
) -> Result<(), String> {
    loop {
        let Some(front) = pending.front_mut() else {
            return Ok(());
        };
        let Some((written, data)) = frame.next_data_frame(stream_id, &front.data[front.offset..])?
        else {
            return Ok(());
        };
        write_frame(output, &data)?;
        front.offset += written;
        if front.offset == front.data.len() {
            pending.pop_front();
        }
    }
}

fn write_frame<W: Write>(output: &mut W, frame: &Frame) -> Result<(), String> {
    output
        .write_all(&encode_frame(frame)?)
        .map_err(|error| error.to_string())
}

fn spawn_channel_input<R>(mut input: R, events: Sender<EndpointEvent>)
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut buffer = vec![0u8; FRAME_MAX_DATA_SIZE];
        loop {
            match input.read(&mut buffer) {
                Ok(0) => {
                    let _ = events.send(EndpointEvent::ChannelClosed);
                    return;
                }
                Ok(read) => {
                    if events
                        .send(EndpointEvent::ChannelData(buffer[..read].to_vec()))
                        .is_err()
                    {
                        return;
                    }
                }
                Err(error) => {
                    let _ = events.send(EndpointEvent::ChannelFailed(error.to_string()));
                    return;
                }
            }
        }
    });
}

fn spawn_stream_input(
    id: String,
    mut input: StreamInput,
    commands: Receiver<StreamInputCommand>,
    events: Sender<EndpointEvent>,
) {
    thread::spawn(move || {
        while let Ok(command) = commands.recv() {
            let finish = matches!(&command, StreamInputCommand::Finish);
            let result = match command {
                StreamInputCommand::Data(data) => input.write(&data),
                StreamInputCommand::Finish => input.finish(),
            };
            if let Err(error) = result {
                let _ = events.send(EndpointEvent::StreamFailed {
                    id: id.clone(),
                    error,
                });
                return;
            }
            if finish {
                let _ = events.send(EndpointEvent::StreamInputFinished {
                    id: id.clone(),
                });
                return;
            }
        }
    });
}

fn spawn_stream_output(id: String, mut output: StreamOutput, events: Sender<EndpointEvent>) {
    thread::spawn(move || {
        let mut buffer = vec![0u8; FRAME_MAX_DATA_SIZE];
        loop {
            match output.read(&mut buffer) {
                Ok(0) => {
                    let _ = events.send(EndpointEvent::StreamOutputFinished { id });
                    return;
                }
                Ok(read) => {
                    if events
                        .send(EndpointEvent::StreamData {
                            id: id.clone(),
                            data: buffer[..read].to_vec(),
                        })
                        .is_err()
                    {
                        return;
                    }
                }
                Err(error) => {
                    let _ = events.send(EndpointEvent::StreamFailed {
                        id,
                        error: error.to_string(),
                    });
                    return;
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capability::artifact::store::ArtifactStore;
    use crate::instance::{InstanceName, build_config};
    use crate::instance::runtime::{PlatformInfo, WorkerRuntimeContext};
    use crate::instance::sandbox::SecurityMode;
    use crate::instance::storage::ExtensionResourceStore;
    use crate::tool::ToolRegistry;

    fn context(path: &std::path::Path) -> EndpointContext {
        let instance = InstanceName::parse("endpoint-fixture").unwrap();
        let artifacts = ArtifactStore::new(path.join("artifacts")).unwrap();
        let payloads = ArtifactPayloadStore::new(path.join("payloads"), artifacts).unwrap();
        let receives = ArtifactReceiveStore::new(path.join("receives")).unwrap();
        let runtime = WorkerRuntimeContext {
            instance: instance.clone(),
            platform: PlatformInfo { os: std::env::consts::OS, arch: std::env::consts::ARCH },
            security_mode: SecurityMode::Disabled, worker_sha256: None,
        };
        let router = Arc::new(RpcRouter::new(
            build_config(&instance).unwrap(), runtime, Arc::new(ToolRegistry::new()),
            Arc::clone(&payloads), Arc::clone(&receives),
            Arc::new(ExtensionResourceStore::new(path.join("resources"))),
        ));
        EndpointContext::new(instance.as_str(), router, payloads, receives)
    }

    fn address(port: &str) -> Address {
        Address { host: "endpoint-fixture-worker".to_string(), port: port.to_string() }
    }

    #[test]
    fn tcp_open_dispatch_registers_pending_stream_and_reports_async_failure() {
        let root = crate::testing::temp_dir();
        let context = context(root.path());
        let (events, receiver) = mpsc::channel();
        let mut streams = HashMap::new();
        dispatch_stream(address("network"), address("network"), StreamPacket::Open {
            id: "invalid".to_string(), name: "tcp".to_string(),
            message: Some(serde_json::json!({ "host": "", "port": 22 })),
        }, &mut streams, &events, &context).unwrap();
        assert!(matches!(&streams["invalid"].service, ByteService::Opening(_)));
        let EndpointEvent::StreamOpened { id, generation, result, input } = receiver.recv_timeout(Duration::from_secs(1)).unwrap() else {
            panic!("expected asynchronous open completion");
        };
        complete_stream_open(&id, &generation, result, input, &mut streams, &events).unwrap();
        assert!(streams.is_empty());
        assert!(matches!(receiver.recv_timeout(Duration::from_secs(1)).unwrap(),
            EndpointEvent::Outbound(Envelope {
                packet: Packet::Stream(StreamPacket::Cancel { id, error: Some(error) }), ..
            }) if id == "invalid" && error.message.contains("host must not be empty")));
    }

    #[test]
    fn pending_tcp_open_keeps_dispatch_responsive_and_preserves_input_until_cancel() {
        let root = crate::testing::temp_dir();
        let context = context(root.path());
        let (events_tx, events_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let started = std::time::Instant::now();
        // Deterministic SYN-drop fixture: no real socket or SSH service.
        let active = ActiveStream::opening(
            "slow".to_string(), address("network"), address("network"), events_tx.clone(),
            move || {
                release_rx.recv_timeout(Duration::from_secs(2)).unwrap();
                Err("fixture connect timeout".to_string())
            },
        );
        assert!(started.elapsed() < Duration::from_millis(500));
        let mut streams = HashMap::from([("slow".to_string(), active)]);
        for packet in [
            StreamPacket::Data { id: "slow".to_string(), seq: 1, message: None, bytes: Some(b"queued".to_vec()) },
            StreamPacket::Fin { id: "slow".to_string() },
        ] {
            dispatch_stream(address("network"), address("network"), packet, &mut streams, &events_tx, &context).unwrap();
        }
        dispatch_rpc(address("transport"), address("transport"), RpcPacket::Request {
            id: "ping".to_string(), method: "transport.peer.promote".to_string(), message: None,
        }, &events_tx, &context).unwrap();
        let reply = events_rx.recv_timeout(Duration::from_millis(500)).unwrap();
        assert!(matches!(reply, EndpointEvent::Outbound(Envelope { packet: Packet::Rpc(RpcPacket::Reply { id, .. }), .. }) if id == "ping"));
        dispatch_stream(address("network"), address("network"), StreamPacket::Cancel {
            id: "slow".to_string(), error: None,
        }, &mut streams, &events_tx, &context).unwrap();
        assert!(streams.is_empty());
        release_tx.send(()).unwrap();
        let EndpointEvent::StreamOpened { id, generation, result, input } = events_rx.recv_timeout(Duration::from_secs(1)).unwrap() else {
            panic!("expected open completion");
        };
        assert!(matches!(input.try_recv().unwrap(), StreamInputCommand::Data(bytes) if bytes.as_slice() == b"queued"));
        assert!(matches!(input.try_recv().unwrap(), StreamInputCommand::Finish));
        // A completion from the cancelled open cannot emit a late error or
        // resurrect the removed Stream.
        complete_stream_open(&id, &generation, result, input, &mut streams, &events_tx).unwrap();
        assert!(streams.is_empty());
        assert!(events_rx.try_recv().is_err());
    }

    #[test]
    fn late_open_completion_cannot_replace_a_new_stream_with_the_same_id() {
        let (events, receiver) = mpsc::channel();
        let old_generation = Arc::new(());
        let new_generation = Arc::new(());
        let (input, input_rx) = mpsc::channel();
        let mut streams = HashMap::from([("reused".to_string(), ActiveStream {
            service: ByteService::Opening(Arc::clone(&new_generation)), input,
            source: address("network"), dest: address("network"), recv_seq: 0, send_seq: 0, output_eof: false,
        })]);
        complete_stream_open("reused", &old_generation, Err("old timeout".to_string()), input_rx,
            &mut streams, &events).unwrap();
        assert!(matches!(&streams["reused"].service, ByteService::Opening(generation) if Arc::ptr_eq(generation, &new_generation)));
        assert!(receiver.try_recv().is_err());
    }
}
