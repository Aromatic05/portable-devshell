use super::super::protocol::*;
use super::Host;
use super::registry::lock_error;
use crate::capability::rpc::{codec, error::RpcError, request::RpcRequest, response::RpcResponse};
use crate::capability::terminal::{
    TerminalAttachInput, TerminalCommandInput, TerminalResizeInput, TerminalWriteInput,
};
use crate::transport::endpoint::channel::LocalIpcStream;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::sync::atomic::Ordering;
use std::time::Duration;

impl Host {
    fn dispatch(&self, request: &RpcRequest) -> Result<Value, RpcError> {
        match request.method.as_str() {
            "process.handshake" => serialize(&self.handshake),
            "process.v1.spawn" => self.spawn(parse(request)?),
            "process.v1.list" => {
                let registry = self.registry.lock().map_err(lock_error)?;
                serialize(
                    registry
                        .order
                        .iter()
                        .map(|id| registry.processes[id].descriptor())
                        .collect::<Vec<_>>(),
                )
            }
            "process.v1.read" => {
                let input: ReadInput = parse(request)?;
                if input.wait_ms > MAX_WAIT_MS {
                    return Err(invalid("waitMs exceeds the host read window"));
                }
                serialize(
                    self.require(&input.id)?
                        .read(input.from_seq, Duration::from_millis(input.wait_ms))?,
                )
            }
            "process.v1.capture" => {
                let input: CaptureInput = parse(request)?;
                serialize(self.require(&input.id)?.capture(
                    input.channel,
                    input.offset,
                    input.limit,
                )?)
            }
            "process.v1.input" => {
                let input: WriteInput = parse(request)?;
                let data = STANDARD
                    .decode(&input.data_base64)
                    .map_err(|error| invalid(error.to_string()))?;
                if data.len() > MAX_INPUT_BYTES {
                    return Err(invalid("input exceeds the input limit"));
                }
                self.require(&input.id)?
                    .input(&data, input.controller.as_deref())?;
                Ok(json!({ "accepted": true }))
            }
            "process.v1.terminalAttach" => {
                let input = parse::<TerminalRequest<TerminalAttachInput>>(request)?.terminal;
                serialize(self.require(&input.terminal_id)?.terminal_attach(input)?)
            }
            "process.v1.terminalWrite" => {
                let input = parse::<TerminalRequest<TerminalWriteInput>>(request)?.terminal;
                let data = STANDARD
                    .decode(&input.data)
                    .map_err(|error| invalid(error.to_string()))?;
                if data.len() > MAX_INPUT_BYTES {
                    return Err(invalid("input exceeds the input limit"));
                }
                self.require(&input.identity.terminal_id)?
                    .terminal_write(input.identity, &data)
            }
            "process.v1.terminalResize" => {
                let input = parse::<TerminalRequest<TerminalResizeInput>>(request)?.terminal;
                validate_dimensions(input.cols, input.rows)?;
                self.require(&input.identity.terminal_id)?.terminal_resize(
                    input.identity,
                    input.cols,
                    input.rows,
                )
            }
            "process.v1.terminalKill" => {
                let input = parse::<TerminalRequest<TerminalCommandInput>>(request)?.terminal;
                serialize(self.require(&input.terminal_id)?.terminal_kill(input)?)
            }
            "process.v1.inspect" => {
                let input: Target = parse(request)?;
                serialize(self.require(&input.id)?.inspect()?)
            }
            "process.v1.resize" => {
                let input: ResizeInput = parse(request)?;
                validate_dimensions(input.cols, input.rows)?;
                self.require(&input.id)?.resize(
                    input.cols,
                    input.rows,
                    input.controller.as_deref(),
                )?;
                Ok(json!({ "resized": true }))
            }
            "process.v1.renewControl" => {
                let input: ReleaseInput = parse(request)?;
                self.require(&input.id)?.renew_control(&input.controller)?;
                Ok(json!({"renewed": true}))
            }
            "process.v1.releaseControl" => {
                let input: ReleaseInput = parse(request)?;
                self.require(&input.id)?.release_control(&input.controller);
                Ok(json!({"released": true}))
            }
            "process.v1.describe" => {
                let input: Target = parse(request)?;
                serialize(self.require(&input.id)?.descriptor())
            }
            "process.v1.closeInput" => {
                let input: Target = parse(request)?;
                self.require(&input.id)?.close_input()?;
                Ok(json!({"closed": true}))
            }
            "process.v1.kill" => {
                let input: Target = parse(request)?;
                self.require(&input.id)?.kill()?;
                Ok(json!({ "accepted": true }))
            }
            "process.v1.retire" => {
                self.retire()?;
                Ok(json!({ "retired": true }))
            }
            _ => Err(RpcError::new("rpc.methodNotFound", &request.method)),
        }
    }

    pub(super) fn handle(&self, mut channel: LocalIpcStream) -> Result<(), String> {
        let Some(frame) = codec::read_frame(&mut channel)? else {
            return Ok(());
        };
        let request = match codec::decode_request_frame(&frame) {
            Ok(request) => request,
            Err(error) => {
                return codec::write_response(
                    &mut channel,
                    &RpcResponse::failure(error.id, error.error),
                );
            }
        };
        let mut request = request;
        let result = if request.method == "process.handshake" {
            self.dispatch(&request)
        } else if request
            .params
            .as_object_mut()
            .and_then(|params| params.remove("generation"))
            .as_ref()
            .and_then(Value::as_str)
            == Some(self.handshake.generation.as_str())
        {
            if request.method == "process.v1.subscribe" {
                let result = parse::<SubscribeInput>(&request).and_then(|input| {
                    self.require(&input.id)
                        .map(|process| (process, input.takeover, input.from_seq, input.remote))
                });
                match result {
                    Ok((process, takeover, from_seq, remote)) => {
                        return super::stream::serve(
                            channel,
                            &request.id,
                            process,
                            takeover,
                            from_seq,
                            remote,
                        );
                    }
                    Err(error) => {
                        return codec::write_response(
                            &mut channel,
                            &RpcResponse::failure(request.id, error),
                        );
                    }
                }
            }
            self.dispatch(&request)
        } else {
            Err(RpcError::new(
                "process.staleGeneration",
                "Process Host generation does not match; reconnect",
            ))
        };
        let retired = request.method == "process.v1.retire" && result.is_ok();
        let response = match result {
            Ok(value) => RpcResponse::success(request.id, value),
            Err(error) => RpcResponse::failure(request.id, error),
        };
        let written = codec::write_response(&mut channel, &response);
        // Even if the requester disconnects after retirement, the host must
        // complete the lifecycle operation instead of remaining inaccessible.
        if retired {
            self.stopped.store(true, Ordering::Release);
        }
        written
    }
}
