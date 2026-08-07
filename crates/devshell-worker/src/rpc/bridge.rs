use std::io;
use std::path::Path;
use std::time::Duration;

use crate::rpc::codec::{read_frame, read_response, write_frame, write_request_frame};
use crate::rpc::request::RpcRequest;
use crate::rpc::response::RpcResponse;
use crate::socket::LocalIpcStream;

#[cfg(unix)]
pub fn run_bridge(socket_file: &Path) -> Result<String, String> {
    let socket = LocalIpcStream::connect(socket_file)
        .map_err(|error| format!("failed to connect {}: {error}", socket_file.display()))?;
    let mut socket_reader = socket
        .try_clone()
        .map_err(|error| format!("failed to clone socket {}: {error}", socket_file.display()))?;
    let mut socket_writer = socket;
    subscribe_notifications(&mut socket_writer, &mut socket_reader)?;

    let forward_stdin = std::thread::spawn(move || -> Result<(), String> {
        let mut stdin = io::stdin().lock();
        while let Some(frame) = read_frame(&mut stdin)? {
            write_frame(&mut socket_writer, &frame)?;
        }
        socket_writer
            .shutdown_write()
            .map_err(|error| format!("failed to half-close rpc socket: {error}"))?;
        Ok(())
    });
    let forward_stdout = std::thread::spawn(move || -> Result<(), String> {
        let mut stdout = io::stdout().lock();
        while let Some(frame) = read_frame(&mut socket_reader)? {
            write_frame(&mut stdout, &frame)?;
        }
        Ok(())
    });

    forward_stdin
        .join()
        .map_err(|_| "stdin bridge thread panicked".to_string())?
        .map_err(|error| format!("stdin bridge failed: {error}"))?;
    forward_stdout
        .join()
        .map_err(|_| "stdout bridge thread panicked".to_string())?
        .map_err(|error| format!("stdout bridge failed: {error}"))?;

    Ok(String::new())
}

#[cfg(windows)]
pub fn run_bridge(socket_file: &Path) -> Result<String, String> {
    use std::sync::mpsc;

    diagnostic("per-request bridge started");
    let socket_file = socket_file.to_path_buf();
    let (response_sender, response_receiver) = mpsc::channel::<Result<Vec<u8>, String>>();
    let notification_sender = response_sender.clone();
    let notification_socket = socket_file.clone();
    std::thread::spawn(move || {
        let result = (|| -> Result<(), String> {
            let mut stream = LocalIpcStream::connect(&notification_socket).map_err(|error| {
                format!(
                    "failed to connect {}: {error}",
                    notification_socket.display()
                )
            })?;
            let mut reader = stream
                .try_clone()
                .map_err(|error| format!("failed to clone notification rpc connection: {error}"))?;
            subscribe_notifications(&mut stream, &mut reader)?;
            while let Some(frame) = read_frame(&mut reader)? {
                if notification_sender.send(Ok(frame)).is_err() {
                    return Ok(());
                }
            }
            Ok(())
        })();
        if let Err(error) = result {
            let _ = notification_sender.send(Err(error));
        }
    });
    let forward_stdin = std::thread::spawn(move || -> Result<(), String> {
        let mut stdin = io::stdin().lock();
        while let Some(frame) = read_frame(&mut stdin)? {
            diagnostic(&format!("stdin frame read: {} bytes", frame.len()));
            let response_sender = response_sender.clone();
            let socket_file = socket_file.clone();
            std::thread::spawn(move || {
                let result = round_trip(&socket_file, &frame);
                let _ = response_sender.send(result);
            });
        }
        diagnostic("stdin reached eof");
        drop(response_sender);
        Ok(())
    });

    let mut stdout = io::stdout().lock();
    while let Ok(response) = response_receiver.recv() {
        let frame = response?;
        diagnostic(&format!("daemon frame received: {} bytes", frame.len()));
        write_frame(&mut stdout, &frame)?;
        diagnostic("daemon frame written to stdout");
    }

    forward_stdin
        .join()
        .map_err(|_| "stdin bridge thread panicked".to_string())?
        .map_err(|error| format!("stdin bridge failed: {error}"))?;
    Ok(String::new())
}

#[cfg(windows)]
fn round_trip(socket_file: &Path, frame: &[u8]) -> Result<Vec<u8>, String> {
    diagnostic("request connecting to daemon");
    let mut stream = LocalIpcStream::connect(socket_file)
        .map_err(|error| format!("failed to connect {}: {error}", socket_file.display()))?;
    diagnostic("request connected to daemon");
    write_frame(&mut stream, frame)?;
    diagnostic("request written to daemon");
    read_frame(&mut stream)?
        .ok_or_else(|| "daemon closed rpc connection without a response".to_string())
}

#[cfg(windows)]
fn diagnostic(message: &str) {
    if std::env::var_os("DEVSHELL_WORKER_DIAGNOSTIC_RPC").is_some() {
        eprintln!("[rpc-bridge] {message}");
    }
}

fn subscribe_notifications(
    writer: &mut LocalIpcStream,
    reader: &mut LocalIpcStream,
) -> Result<(), String> {
    write_request_frame(
        writer,
        &RpcRequest::request(
            "bridge-notifications",
            "worker.notifications.subscribe",
            serde_json::json!({}),
        ),
    )?;
    let response = read_response(reader)?
        .ok_or_else(|| "daemon closed notification subscription without a response".to_string())?;
    if !response.ok {
        return Err("daemon rejected notification subscription".to_string());
    }
    Ok(())
}

pub fn send_request(socket_file: &Path, request: &RpcRequest) -> Result<RpcResponse, String> {
    let mut stream = LocalIpcStream::connect(socket_file)
        .map_err(|error| format!("failed to connect {}: {error}", socket_file.display()))?;
    write_request_frame(&mut stream, request)?;
    read_response(&mut stream)?
        .ok_or_else(|| "daemon closed rpc connection without a response".to_string())
}

pub fn send_request_with_timeout(
    socket_file: &Path,
    request: &RpcRequest,
    timeout: Duration,
) -> Result<RpcResponse, String> {
    let mut stream = LocalIpcStream::connect_with_timeout(socket_file, timeout)
        .map_err(|error| format!("failed to connect {}: {error}", socket_file.display()))?;
    stream
        .set_request_timeout(timeout)
        .map_err(|error| format!("failed to configure RPC timeout: {error}"))?;
    write_request_frame(&mut stream, request)?;
    stream
        .wait_for_response(timeout)
        .map_err(|error| format!("daemon RPC request failed: {error}"))?;
    read_response(&mut stream)?
        .ok_or_else(|| "daemon closed rpc connection without a response".to_string())
}
