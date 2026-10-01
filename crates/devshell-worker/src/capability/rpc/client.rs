use std::path::Path;
use std::time::Duration;

use crate::capability::rpc::codec::{read_response, write_request_frame};
use crate::capability::rpc::request::RpcRequest;
use crate::capability::rpc::response::RpcResponse;
use crate::transport::endpoint::channel::LocalIpcStream;

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
