use std::io::{self, Read, Write};
use std::sync::mpsc;
use std::thread;

use crate::instance::InstanceName;
use crate::transport::endpoint::channel::{LocalIpcStream, EndpointPaths};

pub mod endpoint;
pub mod envelope;
pub mod frame;
pub mod packet;
pub mod reverse;
pub mod wire;

pub fn run(instance: &str) -> Result<String, String> {
    let instance = InstanceName::parse(instance)?;
    let socket_paths = EndpointPaths::resolve(&instance)?;
    let stream = LocalIpcStream::connect(&socket_paths.transport_socket_file).map_err(|error| {
        format!(
            "failed to connect transport endpoint {}: {error}",
            socket_paths.transport_socket_file.display()
        )
    })?;
    bridge_stdio(stream)?;
    Ok(String::new())
}

fn bridge_stdio(stream: LocalIpcStream) -> Result<(), String> {
    let mut input_stream = stream
        .try_clone()
        .map_err(|error| format!("failed to clone transport endpoint: {error}"))?;
    let mut output_stream = stream;
    let (finished_tx, finished_rx) = mpsc::channel::<Result<(), String>>();

    let input_finished = finished_tx.clone();
    thread::spawn(move || {
        let mut stdin = io::stdin().lock();
        let result = io::copy(&mut stdin, &mut output_stream)
            .map(|_| ())
            .map_err(|error| format!("transport stdin bridge failed: {error}"));
        let _ = input_finished.send(result);
    });

    thread::spawn(move || {
        let mut stdout = io::stdout().lock();
        let result = (|| -> Result<(), String> {
            let mut buffer = [0_u8; 64 * 1024];
            loop {
                let read = input_stream
                    .read(&mut buffer)
                    .map_err(|error| format!("transport stdout bridge failed: {error}"))?;
                if read == 0 {
                    return Ok(());
                }
                stdout
                    .write_all(&buffer[..read])
                    .map_err(|error| format!("transport stdout bridge failed: {error}"))?;
                stdout
                    .flush()
                    .map_err(|error| format!("transport stdout flush failed: {error}"))?;
            }
        })();
        let _ = finished_tx.send(result);
    });

    finished_rx
        .recv()
        .map_err(|_| "transport stdio bridge stopped unexpectedly".to_string())?
}
