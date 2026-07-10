use std::io;
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::path::Path;

use crate::rpc::codec::{read_frame, read_response, write_frame, write_request_frame};
use crate::rpc::request::RpcRequest;
use crate::rpc::response::RpcResponse;

pub fn run_bridge(socket_file: &Path) -> Result<String, String> {
    let socket = UnixStream::connect(socket_file)
        .map_err(|error| format!("failed to connect {}: {error}", socket_file.display()))?;
    let socket_reader = socket
        .try_clone()
        .map_err(|error| format!("failed to clone socket {}: {error}", socket_file.display()))?;
    let socket_writer = socket;

    let forward_stdin = std::thread::spawn(move || -> Result<(), String> {
        let mut stdin = io::stdin().lock();
        let mut socket_writer = socket_writer;
        while let Some(frame) = read_frame(&mut stdin)? {
            write_frame(&mut socket_writer, &frame)?;
        }
        socket_writer
            .shutdown(Shutdown::Write)
            .map_err(|error| format!("failed to half-close rpc socket: {error}"))?;
        Ok(())
    });
    let forward_stdout = std::thread::spawn(move || -> Result<(), String> {
        let mut stdout = io::stdout().lock();
        let mut socket_reader = socket_reader;
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

pub fn send_request(socket_file: &Path, request: &RpcRequest) -> Result<RpcResponse, String> {
    let mut stream = UnixStream::connect(socket_file)
        .map_err(|error| format!("failed to connect {}: {error}", socket_file.display()))?;
    write_request_frame(&mut stream, request)?;
    read_response(&mut stream)?
        .ok_or_else(|| "daemon closed rpc connection without a response".to_string())
}
