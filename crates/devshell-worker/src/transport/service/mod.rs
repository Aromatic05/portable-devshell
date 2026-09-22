mod artifact;
mod exec;
mod tcp;

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, ChildStdout};
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::thread;
use std::time::Duration;

use artifact::{PayloadOutput, PayloadService, ReceiveInput, ReceiveService};
use exec::ExecService;
use tcp::TcpService;

use crate::capability::artifact::payload::ArtifactPayloadStore;
use crate::capability::artifact::receive::ArtifactReceiveStore;
use crate::capability::rpc::client::subscribe_notifications;
use crate::transport::frame::{
    FRAME_MAX_DATA_SIZE, Frame, FrameDecoder, FrameEvent, FrameProtocol, FrameRole,
    RESET_SERVICE_FAILED, RESET_UNSUPPORTED_SERVICE, encode_frame,
};
use crate::transport::socket::LocalIpcStream;

const SERVICE_RECEIVE_WINDOW: u32 = 256 * 1024;
const EVENT_QUEUE_CAPACITY: usize = 64;
const SERVICE_QUEUE_CAPACITY: usize = 1;
const MAX_CONCURRENT_SERVICE_OPENINGS: usize = 32;
const SERVICE_POLL_INTERVAL: Duration = Duration::from_millis(20);

#[derive(Clone, Default)]
pub(crate) struct ServiceContext {
    artifact_payloads: Option<Arc<ArtifactPayloadStore>>,
    artifact_receives: Option<Arc<ArtifactReceiveStore>>,
    rpc_socket: Option<PathBuf>,
}

impl ServiceContext {
    pub(crate) fn daemon(
        rpc_socket: PathBuf,
        artifact_payloads: Arc<ArtifactPayloadStore>,
        artifact_receives: Arc<ArtifactReceiveStore>,
    ) -> Self {
        Self {
            artifact_payloads: Some(artifact_payloads),
            artifact_receives: Some(artifact_receives),
            rpc_socket: Some(rpc_socket),
        }
    }

    #[cfg(test)]
    fn with_artifacts(
        artifact_payloads: Arc<ArtifactPayloadStore>,
        artifact_receives: Arc<ArtifactReceiveStore>,
    ) -> Self {
        Self {
            artifact_payloads: Some(artifact_payloads),
            artifact_receives: Some(artifact_receives),
            rpc_socket: None,
        }
    }
}

enum ServiceConnection {
    ArtifactPayload(PayloadService),
    ArtifactReceive(ReceiveService),
    Tcp(TcpService),
    Exec(ExecService),
    Rpc(RpcService),
}

impl ServiceConnection {
    fn open(
        service: &str,
        metadata: &[u8],
        context: &ServiceContext,
    ) -> Result<Option<Self>, String> {
        #[cfg(test)]
        if service == "test.delayed-unsupported" {
            thread::sleep(Duration::from_millis(500));
            return Ok(None);
        }
        match service {
            "artifact.payload" => PayloadService::open(
                metadata,
                Arc::clone(
                    context
                        .artifact_payloads
                        .as_ref()
                        .ok_or_else(|| "artifact.payload is unavailable.".to_string())?,
                ),
            )
            .map(Self::ArtifactPayload)
            .map(Some),
            "artifact.receive" => ReceiveService::open(
                metadata,
                Arc::clone(
                    context
                        .artifact_receives
                        .as_ref()
                        .ok_or_else(|| "artifact.receive is unavailable.".to_string())?,
                ),
            )
            .map(Self::ArtifactReceive)
            .map(Some),
            "network.tcp" => TcpService::open(metadata).map(Self::Tcp).map(Some),
            "process.exec" => ExecService::open(metadata).map(Self::Exec).map(Some),
            "worker.rpc" => RpcService::open(metadata, context.rpc_socket.as_deref())
                .map(Self::Rpc)
                .map(Some),
            _ => Ok(None),
        }
    }

    fn reset(&mut self) {
        match self {
            Self::ArtifactPayload(service) => service.reset(),
            Self::ArtifactReceive(service) => service.reset(),
            Self::Tcp(service) => service.reset(),
            Self::Exec(service) => service.reset(),
            Self::Rpc(service) => service.reset(),
        }
    }

    fn take_input(&mut self) -> Result<ServiceInput, String> {
        match self {
            Self::ArtifactPayload(_) => Ok(ServiceInput::Closed),
            Self::ArtifactReceive(service) => {
                service.take_input().map(ServiceInput::ArtifactReceive)
            }
            Self::Tcp(service) => service.clone_stream().map(ServiceInput::Tcp),
            Self::Exec(service) => service
                .take_stdin()
                .map(|stdin| ServiceInput::Exec(Some(stdin))),
            Self::Rpc(service) => service
                .take_input()
                .map(|input| ServiceInput::Rpc(Some(input))),
        }
    }

    fn take_output(&mut self) -> Result<ServiceOutput, String> {
        match self {
            Self::ArtifactPayload(service) => {
                service.take_output().map(ServiceOutput::ArtifactPayload)
            }
            Self::ArtifactReceive(_) => Ok(ServiceOutput::Closed),
            Self::Tcp(service) => service.clone_stream().map(ServiceOutput::Tcp),
            Self::Exec(service) => service.take_stdout().map(ServiceOutput::Exec),
            Self::Rpc(service) => service.take_output().map(ServiceOutput::Rpc),
        }
    }

    fn output_complete(&mut self) -> Result<bool, String> {
        match self {
            Self::ArtifactPayload(_) => Ok(true),
            Self::ArtifactReceive(service) => Ok(service.output_complete()),
            Self::Tcp(_) => Ok(true),
            Self::Exec(service) => service.poll_status(),
            Self::Rpc(_) => Ok(true),
        }
    }
}

pub struct RpcService {
    input: Option<LocalIpcStream>,
    output: Option<LocalIpcStream>,
}

impl RpcService {
    fn open(metadata: &[u8], rpc_socket: Option<&Path>) -> Result<Self, String> {
        if !metadata.is_empty() {
            return Err("worker.rpc metadata must be empty.".to_string());
        }
        let rpc_socket = rpc_socket.ok_or_else(|| "worker.rpc is unavailable.".to_string())?;
        let mut input = LocalIpcStream::connect(rpc_socket)
            .map_err(|error| format!("failed to connect {}: {error}", rpc_socket.display()))?;
        let mut output = input
            .try_clone()
            .map_err(|error| format!("failed to clone {}: {error}", rpc_socket.display()))?;
        subscribe_notifications(&mut input, &mut output)?;
        Ok(Self {
            input: Some(input),
            output: Some(output),
        })
    }

    fn take_input(&mut self) -> Result<LocalIpcStream, String> {
        self.input
            .take()
            .ok_or_else(|| "worker.rpc input is already attached.".to_string())
    }

    fn take_output(&mut self) -> Result<LocalIpcStream, String> {
        self.output
            .take()
            .ok_or_else(|| "worker.rpc output is already attached.".to_string())
    }

    fn reset(&mut self) {
        if let Some(input) = self.input.as_ref() {
            let _ = input.shutdown_both();
        }
        if let Some(output) = self.output.as_ref() {
            let _ = output.shutdown_both();
        }
        self.input.take();
        self.output.take();
    }
}

enum ServiceInput {
    ArtifactReceive(ReceiveInput),
    Closed,
    Tcp(TcpStream),
    Exec(Option<ChildStdin>),
    Rpc(Option<LocalIpcStream>),
}

impl ServiceInput {
    fn write(&mut self, data: &[u8]) -> Result<(), String> {
        match self {
            Self::ArtifactReceive(input) => input.write(data),
            Self::Closed => Err("Service does not accept input DATA.".to_string()),
            Self::Tcp(stream) => stream
                .write_all(data)
                .map_err(|error| format!("network.tcp write failed: {error}")),
            Self::Exec(stdin) => stdin
                .as_mut()
                .ok_or_else(|| "process.exec stdin is closed.".to_string())?
                .write_all(data)
                .map_err(|error| format!("process.exec stdin write failed: {error}")),
            Self::Rpc(input) => input
                .as_mut()
                .ok_or_else(|| "worker.rpc input is closed.".to_string())?
                .write_all(data)
                .map_err(|error| format!("worker.rpc write failed: {error}")),
        }
    }

    fn finish(&mut self) -> Result<(), String> {
        match self {
            Self::ArtifactReceive(input) => input.finish(),
            Self::Closed => Ok(()),
            Self::Tcp(stream) => stream
                .shutdown(Shutdown::Write)
                .map_err(|error| format!("network.tcp half-close failed: {error}")),
            Self::Exec(stdin) => {
                stdin.take();
                Ok(())
            }
            Self::Rpc(input) => {
                if let Some(stream) = input.take() {
                    stream
                        .shutdown_write()
                        .map_err(|error| format!("worker.rpc half-close failed: {error}"))?;
                }
                Ok(())
            }
        }
    }
}

enum ServiceOutput {
    ArtifactPayload(PayloadOutput),
    Closed,
    Tcp(TcpStream),
    Exec(ChildStdout),
    Rpc(LocalIpcStream),
}

impl ServiceOutput {
    fn read(&mut self, buffer: &mut [u8]) -> Result<usize, String> {
        match self {
            Self::ArtifactPayload(output) => output
                .read(buffer)
                .map_err(|error| format!("artifact.payload read failed: {error}")),
            Self::Closed => Ok(0),
            Self::Tcp(stream) => stream
                .read(buffer)
                .map_err(|error| format!("network.tcp read failed: {error}")),
            Self::Exec(stdout) => stdout
                .read(buffer)
                .map_err(|error| format!("process.exec stdout read failed: {error}")),
            Self::Rpc(output) => output
                .read(buffer)
                .map_err(|error| format!("worker.rpc read failed: {error}")),
        }
    }
}

enum ServiceInputCommand {
    Data(Vec<u8>),
    Finish,
}

enum ServerEvent {
    ChannelData(Vec<u8>),
    ChannelClosed,
    ChannelFailed(String),
    ServiceOpened {
        service: String,
        stream_id: u32,
        result: Result<Option<ServiceConnection>, String>,
    },
    InputConsumed {
        stream_id: u32,
        byte_len: u32,
    },
    InputFinished {
        stream_id: u32,
    },
    ServiceData {
        stream_id: u32,
        data: Vec<u8>,
    },
    OutputFinished {
        stream_id: u32,
    },
    ServiceFailed {
        stream_id: u32,
        error: String,
    },
}

struct PendingOutput {
    data: Vec<u8>,
    offset: usize,
}

struct ActiveService {
    connection: ServiceConnection,
    input: SyncSender<ServiceInputCommand>,
    output_ack: SyncSender<()>,
    input_busy: bool,
    input_finish_sent: bool,
    input_finished: bool,
    remote_fin: bool,
    output_eof: bool,
    local_fin_sent: bool,
    pending_output: Option<PendingOutput>,
}

impl ActiveService {
    fn attach(
        stream_id: u32,
        mut connection: ServiceConnection,
        events: SyncSender<ServerEvent>,
    ) -> Result<Self, String> {
        let input = connection.take_input()?;
        let output = connection.take_output()?;
        let (input_tx, input_rx) = mpsc::sync_channel(SERVICE_QUEUE_CAPACITY);
        let (output_ack_tx, output_ack_rx) = mpsc::sync_channel(SERVICE_QUEUE_CAPACITY);
        spawn_service_input(stream_id, input, input_rx, events.clone());
        spawn_service_output(stream_id, output, output_ack_rx, events);
        Ok(Self {
            connection,
            input: input_tx,
            output_ack: output_ack_tx,
            input_busy: false,
            input_finish_sent: false,
            input_finished: false,
            remote_fin: false,
            output_eof: false,
            local_fin_sent: false,
            pending_output: None,
        })
    }

    fn reset(&mut self) {
        self.connection.reset();
    }
}

pub fn serve_ipc(stream: LocalIpcStream, context: ServiceContext) -> Result<(), String> {
    let input = stream
        .try_clone()
        .map_err(|error| format!("failed to clone transport IPC stream: {error}"))?;
    serve(input, stream, context)
}

fn serve<R, W>(input: R, mut output: W, context: ServiceContext) -> Result<(), String>
where
    R: Read + Send + 'static,
    W: Write,
{
    let (events_tx, events_rx) = mpsc::sync_channel(EVENT_QUEUE_CAPACITY);
    spawn_channel_input(input, events_tx.clone());

    let mut decoder = FrameDecoder::default();
    let mut protocol = FrameProtocol::new(FrameRole::Acceptor);
    let mut services = HashMap::<u32, ActiveService>::new();
    let mut opening_services = HashSet::<u32>::new();

    loop {
        match events_rx.recv_timeout(SERVICE_POLL_INTERVAL) {
            Ok(ServerEvent::ChannelData(data)) => {
                for frame in decoder.push(&data)? {
                    accept_frame(
                        &mut protocol,
                        &mut services,
                        &mut opening_services,
                        &events_tx,
                        frame,
                        &context,
                        &mut output,
                    )?;
                }
            }
            Ok(ServerEvent::ChannelClosed) => {
                if !decoder.is_empty() {
                    return Err("Channel closed with an incomplete Frame.".to_string());
                }
                reset_all(&mut services);
                return Ok(());
            }
            Ok(ServerEvent::ChannelFailed(error)) => {
                reset_all(&mut services);
                return Err(error);
            }
            Ok(ServerEvent::ServiceOpened {
                service,
                stream_id,
                result,
            }) => {
                opening_services.remove(&stream_id);
                if !protocol.stream_open(stream_id) {
                    if let Ok(Some(mut connection)) = result {
                        connection.reset();
                    }
                    continue;
                }
                match result {
                    Ok(Some(connection)) => {
                        match ActiveService::attach(stream_id, connection, events_tx.clone()) {
                            Ok(active) => {
                                services.insert(stream_id, active);
                                let window =
                                    protocol.accept_open(stream_id, SERVICE_RECEIVE_WINDOW)?;
                                write_frame(&mut output, &window)?;
                            }
                            Err(error) => {
                                let reset =
                                    protocol.reject_open(stream_id, RESET_SERVICE_FAILED, error)?;
                                write_frame(&mut output, &reset)?;
                            }
                        }
                    }
                    Ok(None) => {
                        let reset = protocol.reject_open(
                            stream_id,
                            RESET_UNSUPPORTED_SERVICE,
                            format!("Unsupported transport Service {service}."),
                        )?;
                        write_frame(&mut output, &reset)?;
                    }
                    Err(error) => {
                        let reset = protocol.reject_open(stream_id, RESET_SERVICE_FAILED, error)?;
                        write_frame(&mut output, &reset)?;
                    }
                }
            }
            Ok(ServerEvent::InputConsumed {
                stream_id,
                byte_len,
            }) => {
                if let Some(service) = services.get_mut(&stream_id) {
                    service.input_busy = false;
                    if let Some(window) = protocol.consume(stream_id, byte_len)? {
                        write_frame(&mut output, &window)?;
                    }
                    dispatch_input(&mut protocol, &mut services, stream_id)?;
                    cleanup_closed(&protocol, &mut services, stream_id);
                }
            }
            Ok(ServerEvent::InputFinished { stream_id }) => {
                if let Some(service) = services.get_mut(&stream_id) {
                    service.input_finished = true;
                }
            }
            Ok(ServerEvent::ServiceData { stream_id, data }) => {
                let duplicate = services
                    .get(&stream_id)
                    .is_some_and(|service| service.pending_output.is_some());
                if duplicate {
                    reset_local(
                        &mut protocol,
                        &mut services,
                        stream_id,
                        RESET_SERVICE_FAILED,
                        "Service produced output before the previous chunk was consumed.",
                        &mut output,
                    )?;
                    continue;
                }
                if let Some(service) = services.get_mut(&stream_id) {
                    service.pending_output = Some(PendingOutput { data, offset: 0 });
                    if let Err(error) =
                        flush_output(&mut protocol, &mut services, stream_id, &mut output)
                    {
                        reset_local(
                            &mut protocol,
                            &mut services,
                            stream_id,
                            RESET_SERVICE_FAILED,
                            &error,
                            &mut output,
                        )?;
                    }
                }
            }
            Ok(ServerEvent::OutputFinished { stream_id }) => {
                if let Some(service) = services.get_mut(&stream_id) {
                    service.output_eof = true;
                }
                finish_output_if_ready(&mut protocol, &mut services, stream_id, &mut output)?;
            }
            Ok(ServerEvent::ServiceFailed { stream_id, error }) => {
                if services.contains_key(&stream_id) {
                    reset_local(
                        &mut protocol,
                        &mut services,
                        stream_id,
                        RESET_SERVICE_FAILED,
                        &error,
                        &mut output,
                    )?;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                reset_all(&mut services);
                return Err("Transport service event loop disconnected.".to_string());
            }
        }

        let pending = services
            .iter()
            .filter_map(|(stream_id, service)| {
                (service.output_eof && !service.local_fin_sent).then_some(*stream_id)
            })
            .collect::<Vec<_>>();
        for stream_id in pending {
            finish_output_if_ready(&mut protocol, &mut services, stream_id, &mut output)?;
        }
    }
}

fn spawn_channel_input<R>(mut input: R, events: SyncSender<ServerEvent>)
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut buffer = vec![0u8; FRAME_MAX_DATA_SIZE];
        loop {
            match input.read(&mut buffer) {
                Ok(0) => {
                    let _ = events.send(ServerEvent::ChannelClosed);
                    return;
                }
                Ok(read) => {
                    if events
                        .send(ServerEvent::ChannelData(buffer[..read].to_vec()))
                        .is_err()
                    {
                        return;
                    }
                }
                Err(error) => {
                    let _ = events.send(ServerEvent::ChannelFailed(error.to_string()));
                    return;
                }
            }
        }
    });
}

fn spawn_service_open(
    stream_id: u32,
    service: String,
    metadata: Vec<u8>,
    context: ServiceContext,
    events: SyncSender<ServerEvent>,
) {
    thread::spawn(move || {
        let result = ServiceConnection::open(&service, &metadata, &context);
        let _ = events.send(ServerEvent::ServiceOpened {
            service,
            stream_id,
            result,
        });
    });
}

fn spawn_service_input(
    stream_id: u32,
    mut input: ServiceInput,
    commands: Receiver<ServiceInputCommand>,
    events: SyncSender<ServerEvent>,
) {
    thread::spawn(move || {
        while let Ok(command) = commands.recv() {
            match command {
                ServiceInputCommand::Data(data) => {
                    let byte_len = match u32::try_from(data.len()) {
                        Ok(value) => value,
                        Err(_) => {
                            let _ = events.send(ServerEvent::ServiceFailed {
                                stream_id,
                                error: "Service input exceeds u32 length.".to_string(),
                            });
                            return;
                        }
                    };
                    if let Err(error) = input.write(&data) {
                        let _ = events.send(ServerEvent::ServiceFailed { stream_id, error });
                        return;
                    }
                    if events
                        .send(ServerEvent::InputConsumed {
                            stream_id,
                            byte_len,
                        })
                        .is_err()
                    {
                        return;
                    }
                }
                ServiceInputCommand::Finish => {
                    match input.finish() {
                        Ok(()) => {
                            let _ = events.send(ServerEvent::InputFinished { stream_id });
                        }
                        Err(error) => {
                            let _ = events.send(ServerEvent::ServiceFailed { stream_id, error });
                        }
                    }
                    return;
                }
            }
        }
    });
}

fn spawn_service_output(
    stream_id: u32,
    mut output: ServiceOutput,
    acknowledgements: Receiver<()>,
    events: SyncSender<ServerEvent>,
) {
    thread::spawn(move || {
        let mut buffer = vec![0u8; FRAME_MAX_DATA_SIZE];
        loop {
            match output.read(&mut buffer) {
                Ok(0) => {
                    let _ = events.send(ServerEvent::OutputFinished { stream_id });
                    return;
                }
                Ok(read) => {
                    if events
                        .send(ServerEvent::ServiceData {
                            stream_id,
                            data: buffer[..read].to_vec(),
                        })
                        .is_err()
                    {
                        return;
                    }
                    if acknowledgements.recv().is_err() {
                        return;
                    }
                }
                Err(error) => {
                    let _ = events.send(ServerEvent::ServiceFailed { stream_id, error });
                    return;
                }
            }
        }
    });
}

fn accept_frame<W: Write>(
    protocol: &mut FrameProtocol,
    services: &mut HashMap<u32, ActiveService>,
    opening_services: &mut HashSet<u32>,
    events: &SyncSender<ServerEvent>,
    frame: Frame,
    context: &ServiceContext,
    output: &mut W,
) -> Result<(), String> {
    let stream_id = frame.stream_id();
    let is_window = matches!(&frame, Frame::Window { .. });
    let event = protocol.accept_frame(frame)?;
    match event {
        Some(FrameEvent::Open {
            stream_id,
            service,
            metadata,
        }) => {
            if opening_services.len() >= MAX_CONCURRENT_SERVICE_OPENINGS {
                let reset = protocol.reject_open(
                    stream_id,
                    RESET_SERVICE_FAILED,
                    "Transport Service opening limit reached.".to_string(),
                )?;
                write_frame(output, &reset)?;
            } else {
                opening_services.insert(stream_id);
                spawn_service_open(
                    stream_id,
                    service,
                    metadata,
                    context.clone(),
                    events.clone(),
                );
            }
        }
        Some(FrameEvent::Data { stream_id }) => {
            dispatch_input(protocol, services, stream_id)?;
        }
        Some(FrameEvent::Fin { stream_id }) => {
            if let Some(service) = services.get_mut(&stream_id) {
                service.remote_fin = true;
            }
            dispatch_input(protocol, services, stream_id)?;
            cleanup_closed(protocol, services, stream_id);
        }
        Some(FrameEvent::Reset { stream_id, .. }) => {
            if let Some(mut service) = services.remove(&stream_id) {
                service.reset();
            }
        }
        None if is_window => {
            if let Err(error) = flush_output(protocol, services, stream_id, output) {
                reset_local(
                    protocol,
                    services,
                    stream_id,
                    RESET_SERVICE_FAILED,
                    &error,
                    output,
                )?;
            }
        }
        None => {}
    }
    Ok(())
}

fn dispatch_input(
    protocol: &mut FrameProtocol,
    services: &mut HashMap<u32, ActiveService>,
    stream_id: u32,
) -> Result<(), String> {
    let Some(service) = services.get_mut(&stream_id) else {
        return Ok(());
    };
    if service.input_busy || service.input_finish_sent {
        return Ok(());
    }
    if let Some(data) = protocol.read_data(stream_id)? {
        service.input_busy = true;
        if service.input.send(ServiceInputCommand::Data(data)).is_err() {
            service.input_busy = false;
            return Err("Service input worker is unavailable.".to_string());
        }
        return Ok(());
    }
    if service.remote_fin {
        service.input_finish_sent = true;
        if service.input.send(ServiceInputCommand::Finish).is_err() {
            return Err("Service input worker is unavailable.".to_string());
        }
    }
    Ok(())
}

fn flush_output<W: Write>(
    protocol: &mut FrameProtocol,
    services: &mut HashMap<u32, ActiveService>,
    stream_id: u32,
    output: &mut W,
) -> Result<(), String> {
    let Some(service) = services.get_mut(&stream_id) else {
        return Ok(());
    };
    loop {
        let Some(pending) = service.pending_output.as_mut() else {
            return Ok(());
        };
        let Some((used, frame)) =
            protocol.next_data_frame(stream_id, &pending.data[pending.offset..])?
        else {
            return Ok(());
        };
        write_frame(output, &frame)?;
        pending.offset += used;
        if pending.offset < pending.data.len() {
            continue;
        }
        service.pending_output = None;
        service
            .output_ack
            .send(())
            .map_err(|_| "Service output worker is unavailable.".to_string())?;
    }
}

fn finish_output_if_ready<W: Write>(
    protocol: &mut FrameProtocol,
    services: &mut HashMap<u32, ActiveService>,
    stream_id: u32,
    output: &mut W,
) -> Result<(), String> {
    let state = {
        let Some(service) = services.get_mut(&stream_id) else {
            return Ok(());
        };
        if !service.output_eof || service.local_fin_sent {
            return Ok(());
        }
        service.connection.output_complete()
    };
    match state {
        Ok(false) => Ok(()),
        Ok(true) => {
            let fin = protocol.finish(stream_id)?;
            write_frame(output, &fin)?;
            if let Some(service) = services.get_mut(&stream_id) {
                service.local_fin_sent = true;
            }
            cleanup_closed(protocol, services, stream_id);
            Ok(())
        }
        Err(error) => reset_local(
            protocol,
            services,
            stream_id,
            RESET_SERVICE_FAILED,
            &error,
            output,
        ),
    }
}

fn reset_local<W: Write>(
    protocol: &mut FrameProtocol,
    services: &mut HashMap<u32, ActiveService>,
    stream_id: u32,
    code: u16,
    message: &str,
    output: &mut W,
) -> Result<(), String> {
    if let Some(mut service) = services.remove(&stream_id) {
        service.reset();
    }
    if protocol.stream_open(stream_id) {
        let reset = protocol.reset(stream_id, code, message.to_string())?;
        write_frame(output, &reset)?;
    }
    Ok(())
}

fn cleanup_closed(
    protocol: &FrameProtocol,
    services: &mut HashMap<u32, ActiveService>,
    stream_id: u32,
) {
    if !protocol.stream_open(stream_id) {
        services.remove(&stream_id);
    }
}

fn reset_all(services: &mut HashMap<u32, ActiveService>) {
    for service in services.values_mut() {
        service.reset();
    }
    services.clear();
}

fn write_frame<W: Write>(output: &mut W, frame: &Frame) -> Result<(), String> {
    let encoded = encode_frame(frame)?;
    output
        .write_all(&encoded)
        .map_err(|error| format!("Transport Channel write failed: {error}"))?;
    output
        .flush()
        .map_err(|error| format!("Transport Channel flush failed: {error}"))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::{Read, Write};
    use std::net::{Shutdown, TcpListener};
    use std::sync::{Arc, mpsc};
    use std::thread;
    use std::time::Duration;

    use serde_json::json;

    use super::*;
    use crate::capability::artifact::payload::ArtifactPayloadStore;
    use crate::capability::artifact::receive::{ArtifactReceiveBeginInput, ArtifactReceiveStore};
    use crate::capability::artifact::store::ArtifactStore;
    use crate::capability::artifact::unix_time_millis;
    use crate::instance::sandbox::policy::DisabledSecurityPolicy;
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

    #[test]
    fn artifact_payload_service_streams_raw_bytes_with_total_length_header() {
        let root = tempfile::tempdir().expect("tempdir");
        let workspace = root.path().join("workspace");
        fs::create_dir(&workspace).expect("workspace");
        let payload_bytes = b"0123456789artifact";
        fs::write(workspace.join("source.bin"), payload_bytes).expect("source");

        let artifacts = ArtifactStore::new(root.path().join("artifacts")).expect("artifacts");
        let payloads =
            ArtifactPayloadStore::new(root.path().join("payloads"), Arc::clone(&artifacts))
                .expect("payloads");
        let receives = ArtifactReceiveStore::new(root.path().join("receives")).expect("receives");
        let opened = payloads
            .open_path(
                &workspace,
                "./source.bin",
                &DisabledSecurityPolicy,
                unix_time_millis() + 60_000,
            )
            .expect("open payload");
        let context = ServiceContext::with_artifacts(Arc::clone(&payloads), receives);
        let metadata = serde_json::to_vec(&json!({
            "payloadId": opened.payload_id,
            "offsetBytes": 2,
            "maxBytes": 7,
        }))
        .expect("metadata");

        let response = run_frame_service_with_context("artifact.payload", metadata, b"", &context)
            .expect("payload stream");

        assert!(response.len() >= 8);
        assert_eq!(
            u64::from_be_bytes(response[..8].try_into().expect("header")),
            payload_bytes.len() as u64,
        );
        assert_eq!(&response[8..], &payload_bytes[2..9]);
    }

    #[test]
    fn artifact_receive_service_accepts_raw_bytes_before_rpc_finish() {
        let root = tempfile::tempdir().expect("tempdir");
        let source_workspace = root.path().join("source");
        let target_workspace = root.path().join("target");
        fs::create_dir(&source_workspace).expect("source workspace");
        fs::create_dir(&target_workspace).expect("target workspace");
        let payload_bytes = b"raw artifact receive bytes";
        fs::write(source_workspace.join("source.bin"), payload_bytes).expect("source");

        let artifacts = ArtifactStore::new(root.path().join("artifacts")).expect("artifacts");
        let payloads =
            ArtifactPayloadStore::new(root.path().join("payloads"), Arc::clone(&artifacts))
                .expect("payloads");
        let receives = ArtifactReceiveStore::new(root.path().join("receives")).expect("receives");
        let opened = payloads
            .open_path(
                &source_workspace,
                "./source.bin",
                &DisabledSecurityPolicy,
                unix_time_millis() + 60_000,
            )
            .expect("open payload");
        let receive = receives
            .begin(
                &target_workspace,
                &DisabledSecurityPolicy,
                ArtifactReceiveBeginInput {
                    descriptor: opened.descriptor,
                    overwrite: false,
                    target_path: "./target.bin".to_string(),
                },
            )
            .expect("begin receive");
        let context = ServiceContext::with_artifacts(payloads, Arc::clone(&receives));
        let metadata = serde_json::to_vec(&json!({
            "receiveId": receive.receive_id,
            "offsetBytes": receive.next_offset_bytes,
        }))
        .expect("metadata");

        let response =
            run_frame_service_with_context("artifact.receive", metadata, payload_bytes, &context)
                .expect("receive stream");
        assert!(response.is_empty());

        receives
            .finish(&receive.receive_id)
            .expect("finish receive");
        assert_eq!(
            fs::read(target_workspace.join("target.bin")).expect("target"),
            payload_bytes,
        );
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
        let mut connection =
            ServiceConnection::open(&service, &metadata, &ServiceContext::default())
                .expect("spawn rsync")
                .expect("process.exec is supported");
        let mut service_input = connection.take_input().expect("attach rsync input");
        let mut service_output = connection.take_output().expect("attach rsync output");
        let window = worker
            .accept_open(opened_id, 64 * 1024)
            .expect("accept process.exec");
        client.accept_frame(window).expect("grant client credit");

        // Older rsync versions, including the macOS system rsync, may wait for
        // the peer protocol version before flushing their own greeting. Send a
        // compatible peer greeting first instead of assuming output-first
        // handshake ordering.
        service_input
            .write(&29u32.to_le_bytes())
            .expect("write rsync peer greeting");

        // Keep a real external process smoke from hanging the whole platform
        // contract if an rsync implementation changes its handshake again.
        let (greeting_tx, greeting_rx) = mpsc::channel();
        let greeting_reader = thread::spawn(move || {
            let mut greeting = [0u8; 4];
            let result = (|| -> Result<[u8; 4], String> {
                let mut offset = 0;
                while offset < greeting.len() {
                    let read = service_output.read(&mut greeting[offset..])?;
                    if read == 0 {
                        return Err("rsync closed before protocol greeting".to_string());
                    }
                    offset += read;
                }
                Ok(greeting)
            })();
            let _ = greeting_tx.send(result);
        });
        let greeting = match greeting_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(greeting)) => greeting,
            Ok(Err(error)) => panic!("{error}"),
            Err(error) => {
                connection.reset();
                let _ = greeting_reader.join();
                panic!("timed out waiting for rsync protocol greeting: {error}");
            }
        };
        greeting_reader.join().expect("rsync greeting reader");
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
        let context = ServiceContext::default();
        assert!(
            ServiceConnection::open("unknown", b"{}", &context)
                .unwrap()
                .is_none()
        );
        assert!(
            ServiceConnection::open("network.tcp", br#"{"host":"127.0.0.1"}"#, &context).is_err()
        );
        assert!(
            ServiceConnection::open("process.exec", br#"{"executable":""}"#, &context).is_err()
        );
        assert!(ServiceConnection::open("worker.rpc", b"", &context).is_err());
    }

    #[test]
    fn slow_service_open_does_not_block_sibling_open() {
        let mut protocol = FrameProtocol::new(FrameRole::Acceptor);
        let mut services = HashMap::<u32, ActiveService>::new();
        let mut opening_services = HashSet::<u32>::new();
        let (events_tx, events_rx) = mpsc::sync_channel(EVENT_QUEUE_CAPACITY);
        let context = ServiceContext::default();
        let mut output = Vec::new();

        accept_frame(
            &mut protocol,
            &mut services,
            &mut opening_services,
            &events_tx,
            Frame::Open {
                stream_id: 1,
                receive_window: 8,
                service: "test.delayed-unsupported".to_string(),
                metadata: Vec::new(),
            },
            &context,
            &mut output,
        )
        .expect("queue delayed open");
        accept_frame(
            &mut protocol,
            &mut services,
            &mut opening_services,
            &events_tx,
            Frame::Open {
                stream_id: 2,
                receive_window: 8,
                service: "unknown".to_string(),
                metadata: Vec::new(),
            },
            &context,
            &mut output,
        )
        .expect("queue sibling open");

        let first = events_rx
            .recv_timeout(Duration::from_millis(250))
            .expect("sibling open should complete while delayed open is blocked");
        assert!(matches!(
            first,
            ServerEvent::ServiceOpened { stream_id: 2, .. }
        ));
        let second = events_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("delayed open completion");
        assert!(matches!(
            second,
            ServerEvent::ServiceOpened { stream_id: 1, .. }
        ));
    }

    fn run_frame_service(
        service_name: &str,
        metadata: Vec<u8>,
        request: &[u8],
    ) -> Result<Vec<u8>, String> {
        run_frame_service_with_context(service_name, metadata, request, &ServiceContext::default())
    }

    fn run_frame_service_with_context(
        service_name: &str,
        metadata: Vec<u8>,
        request: &[u8],
        context: &ServiceContext,
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
        let mut connection = ServiceConnection::open(&service, &metadata, context)?
            .ok_or_else(|| format!("Unsupported transport Service {service}."))?;
        let mut service_input = connection.take_input()?;
        let mut service_output = connection.take_output()?;
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
            service_input.write(&data)?;
            if let Some(window) = window {
                client.accept_frame(window)?;
            }
        }

        let fin = client.finish(stream_id)?;
        worker.accept_frame(fin)?;
        service_input.finish()?;

        let mut response = Vec::new();
        let mut buffer = [0u8; 4096];
        loop {
            let read = service_output.read(&mut buffer)?;
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
