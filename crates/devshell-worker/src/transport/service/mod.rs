mod exec;
mod tcp;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream};
use std::process::{ChildStdin, ChildStdout};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::thread;
use std::time::Duration;

use exec::ExecService;
use tcp::TcpService;

use crate::transport::frame::{
    FRAME_MAX_DATA_SIZE, Frame, FrameDecoder, FrameEvent, FrameProtocol, FrameRole,
    RESET_SERVICE_FAILED, RESET_UNSUPPORTED_SERVICE, encode_frame,
};

const SERVICE_RECEIVE_WINDOW: u32 = 256 * 1024;
const EVENT_QUEUE_CAPACITY: usize = 64;
const SERVICE_QUEUE_CAPACITY: usize = 1;
const SERVICE_POLL_INTERVAL: Duration = Duration::from_millis(20);

pub enum ServiceConnection {
    Tcp(TcpService),
    Exec(ExecService),
}

impl ServiceConnection {
    pub fn supports(service: &str) -> bool {
        matches!(service, "network.tcp" | "process.exec")
    }

    pub fn open(service: &str, metadata: &[u8]) -> Result<Self, String> {
        match service {
            "network.tcp" => TcpService::open(metadata).map(Self::Tcp),
            "process.exec" => ExecService::open(metadata).map(Self::Exec),
            _ => Err(format!("unsupported transport Service {service}")),
        }
    }

    #[cfg(test)]
    pub fn write(&mut self, data: &[u8]) -> Result<(), String> {
        match self {
            Self::Tcp(service) => service.write(data),
            Self::Exec(service) => service.write(data),
        }
    }

    #[cfg(test)]
    pub fn finish_input(&mut self) -> Result<(), String> {
        match self {
            Self::Tcp(service) => service.finish_input(),
            Self::Exec(service) => service.finish_input(),
        }
    }

    #[cfg(test)]
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

    fn take_input(&mut self) -> Result<ServiceInput, String> {
        match self {
            Self::Tcp(service) => service.clone_stream().map(ServiceInput::Tcp),
            Self::Exec(service) => service
                .take_stdin()
                .map(|stdin| ServiceInput::Exec(Some(stdin))),
        }
    }

    fn take_output(&mut self) -> Result<ServiceOutput, String> {
        match self {
            Self::Tcp(service) => service.clone_stream().map(ServiceOutput::Tcp),
            Self::Exec(service) => service.take_stdout().map(ServiceOutput::Exec),
        }
    }

    fn output_complete(&mut self) -> Result<bool, String> {
        match self {
            Self::Tcp(_) => Ok(true),
            Self::Exec(service) => service.poll_status(),
        }
    }
}

enum ServiceInput {
    Tcp(TcpStream),
    Exec(Option<ChildStdin>),
}

impl ServiceInput {
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
        }
    }
}

enum ServiceOutput {
    Tcp(TcpStream),
    Exec(ChildStdout),
}

impl ServiceOutput {
    fn read(&mut self, buffer: &mut [u8]) -> Result<usize, String> {
        match self {
            Self::Tcp(stream) => stream
                .read(buffer)
                .map_err(|error| format!("network.tcp read failed: {error}")),
            Self::Exec(stdout) => stdout
                .read(buffer)
                .map_err(|error| format!("process.exec stdout read failed: {error}")),
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
    InputConsumed { stream_id: u32, byte_len: u32 },
    InputFinished { stream_id: u32 },
    ServiceData { stream_id: u32, data: Vec<u8> },
    OutputFinished { stream_id: u32 },
    ServiceFailed { stream_id: u32, error: String },
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
    fn open(
        stream_id: u32,
        service: &str,
        metadata: &[u8],
        events: SyncSender<ServerEvent>,
    ) -> Result<Self, String> {
        let mut connection = ServiceConnection::open(service, metadata)?;
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

pub fn serve_stdio() -> Result<(), String> {
    serve(std::io::stdin(), std::io::stdout())
}

fn serve<R, W>(input: R, mut output: W) -> Result<(), String>
where
    R: Read + Send + 'static,
    W: Write,
{
    let (events_tx, events_rx) = mpsc::sync_channel(EVENT_QUEUE_CAPACITY);
    spawn_channel_input(input, events_tx.clone());

    let mut decoder = FrameDecoder::default();
    let mut protocol = FrameProtocol::new(FrameRole::Acceptor);
    let mut services = HashMap::<u32, ActiveService>::new();

    loop {
        match events_rx.recv_timeout(SERVICE_POLL_INTERVAL) {
            Ok(ServerEvent::ChannelData(data)) => {
                for frame in decoder.push(&data)? {
                    accept_frame(&mut protocol, &mut services, &events_tx, frame, &mut output)?;
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
    events: &SyncSender<ServerEvent>,
    frame: Frame,
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
            if !ServiceConnection::supports(&service) {
                let reset = protocol.reject_open(
                    stream_id,
                    RESET_UNSUPPORTED_SERVICE,
                    format!("Unsupported transport Service {service}."),
                )?;
                write_frame(output, &reset)?;
                return Ok(());
            }
            match ActiveService::open(stream_id, &service, &metadata, events.clone()) {
                Ok(active) => {
                    services.insert(stream_id, active);
                    let window = protocol.accept_open(stream_id, SERVICE_RECEIVE_WINDOW)?;
                    write_frame(output, &window)?;
                }
                Err(error) => {
                    let reset = protocol.reject_open(stream_id, RESET_SERVICE_FAILED, error)?;
                    write_frame(output, &reset)?;
                }
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
