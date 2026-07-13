use std::io;
use std::path::Path;

use crate::rpc::codec::{read_frame, read_response, write_frame, write_request_frame};
use crate::rpc::request::RpcRequest;
use crate::rpc::response::RpcResponse;
use crate::socket::LocalIpcStream;

pub fn run_bridge(socket_file: &Path) -> Result<String, String> {
    diagnostic("connecting to daemon");
    let socket = LocalIpcStream::connect(socket_file)
        .map_err(|error| format!("failed to connect {}: {error}", socket_file.display()))?;
    diagnostic("connected to daemon");
    let socket_reader = socket
        .try_clone()
        .map_err(|error| format!("failed to clone socket {}: {error}", socket_file.display()))?;
    diagnostic("cloned daemon connection");
    let socket_writer = socket;

    let forward_stdin = std::thread::spawn(move || -> Result<(), String> {
        diagnostic("stdin forwarder started");
        let mut stdin = io::stdin().lock();
        let mut socket_writer = socket_writer;
        while let Some(frame) = read_frame(&mut stdin)? {
            diagnostic(&format!("stdin frame read: {} bytes", frame.len()));
            write_frame(&mut socket_writer, &frame)?;
            diagnostic("stdin frame written to daemon");
        }
        diagnostic("stdin reached eof");
        socket_writer
            .shutdown_write()
            .map_err(|error| format!("failed to half-close rpc socket: {error}"))?;
        Ok(())
    });
    let forward_stdout = std::thread::spawn(move || -> Result<(), String> {
        diagnostic("stdout forwarder started");
        let mut stdout = io::stdout().lock();
        let mut socket_reader = socket_reader;
        while let Some(frame) = read_frame(&mut socket_reader)? {
            diagnostic(&format!("daemon frame read: {} bytes", frame.len()));
            write_frame(&mut stdout, &frame)?;
            diagnostic("daemon frame written to stdout");
        }
        diagnostic("daemon connection reached eof");
        Ok(())
    });

    forward_stdin
        .join()
        .map_err(|_| "stdin bridge thread panicked".to_string())?
        .map_err(|error| format!("stdin bridge failed: {error}"))?;
    #[cfg(unix)]
    forward_stdout
        .join()
        .map_err(|_| "stdout bridge thread panicked".to_string())?
        .map_err(|error| format!("stdout bridge failed: {error}"))?;
    #[cfg(windows)]
    drop(forward_stdout);

    Ok(String::new())
}

fn diagnostic(message: &str) {
    if std::env::var_os("DEVSHELL_WORKER_DIAGNOSTIC_RPC").is_some() {
        eprintln!("[rpc-bridge] {message}");
    }
}

pub fn send_request(socket_file: &Path, request: &RpcRequest) -> Result<RpcResponse, String> {
    let mut stream = LocalIpcStream::connect(socket_file)
        .map_err(|error| format!("failed to connect {}: {error}", socket_file.display()))?;
    write_request_frame(&mut stream, request)?;
    read_response(&mut stream)?
        .ok_or_else(|| "daemon closed rpc connection without a response".to_string())
}
