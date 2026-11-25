//! One ordered raw output subscription; only the first frame restores state.
use super::super::resource::ManagedProcess;
use crate::capability::rpc::{codec, error::RpcError, response::RpcResponse};
use crate::transport::endpoint::channel::LocalIpcStream;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;

struct ControlLease {
    process: Arc<ManagedProcess>,
    controller: Option<String>,
}

impl Drop for ControlLease {
    fn drop(&mut self) {
        if let Some(controller) = self.controller.as_deref() {
            self.process.release_control(controller);
        }
    }
}

pub(super) fn serve(
    mut channel: LocalIpcStream,
    id: &str,
    process: Arc<ManagedProcess>,
    takeover: bool,
) -> Result<(), String> {
    channel
        .set_request_timeout(Duration::from_secs(3))
        .map_err(|error| error.to_string())?;
    let (controller, screen) = match process.begin_attach(takeover) {
        Ok(value) => value,
        Err(error) => {
            return codec::write_response(&mut channel, &RpcResponse::failure(id.to_owned(), error));
        }
    };
    let lease = ControlLease {
        process: Arc::clone(&process),
        controller,
    };
    let mut cursor = screen.seq;
    codec::write_response(
        &mut channel,
        &RpcResponse::success(
            id.to_owned(),
            json!({
                "screen": screen, "controller": lease.controller, "process": process.descriptor()
            }),
        ),
    )?;
    loop {
        let page = match process.read(cursor, Duration::from_secs(1)) {
            Ok(value) => value,
            Err(error) => {
                return codec::write_response(
                    &mut channel,
                    &RpcResponse::failure(id.to_owned(), error),
                );
            }
        };
        if page.output.gap {
            return codec::write_response(
                &mut channel,
                &RpcResponse::failure(
                    id.to_owned(),
                    RpcError::new(
                        "stream.gap",
                        "terminal output overran the subscriber; reattach to restore state",
                    ),
                ),
            );
        }
        if let Some(frame) = page.output.frames.last() {
            cursor = frame.seq;
        }
        let finished = page.process.state != "running" && cursor >= page.output.latest_seq;
        codec::write_response(
            &mut channel,
            &RpcResponse::success(
                id.to_owned(),
                serde_json::to_value(page).map_err(|error| error.to_string())?,
            ),
        )?;
        if finished {
            return Ok(());
        }
    }
}
