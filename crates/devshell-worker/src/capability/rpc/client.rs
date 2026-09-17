use std::path::Path;
use std::time::Duration;

use crate::capability::rpc::codec::{read_response, write_request_frame};
use crate::capability::rpc::request::RpcRequest;
use crate::capability::rpc::response::RpcResponse;
use crate::transport::socket::LocalIpcStream;

pub(crate) fn subscribe_notifications(
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
