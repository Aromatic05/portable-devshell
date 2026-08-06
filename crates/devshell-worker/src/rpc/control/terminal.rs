use std::sync::Arc;

use serde_json::json;

use crate::rpc::router::{ControlHandler, control_handler, parse_params, serialize};
use crate::terminal::{
    TerminalAttachInput, TerminalCommandInput, TerminalManager, TerminalOpenInput,
    TerminalResizeInput, TerminalWriteInput,
};

pub fn open(manager: TerminalManager) -> Arc<dyn ControlHandler> {
    control_handler(move |request| {
        serialize(manager.open(parse_params::<TerminalOpenInput>(request)?)?)
    })
}

pub fn attach(manager: TerminalManager) -> Arc<dyn ControlHandler> {
    control_handler(move |request| {
        serialize(manager.attach(parse_params::<TerminalAttachInput>(request)?)?)
    })
}

pub fn write(manager: TerminalManager) -> Arc<dyn ControlHandler> {
    control_handler(move |request| manager.write(parse_params::<TerminalWriteInput>(request)?))
}

pub fn resize(manager: TerminalManager) -> Arc<dyn ControlHandler> {
    control_handler(move |request| manager.resize(parse_params::<TerminalResizeInput>(request)?))
}

pub fn kill(manager: TerminalManager) -> Arc<dyn ControlHandler> {
    control_handler(move |request| {
        serialize(manager.kill(parse_params::<TerminalCommandInput>(request)?)?)
    })
}

pub fn list(manager: TerminalManager) -> Arc<dyn ControlHandler> {
    control_handler(move |_| serialize(manager.list()?))
}

pub fn capabilities() -> serde_json::Value {
    json!({
        "supported": cfg!(any(unix, windows)),
        "maxSessions": 16,
        "resize": cfg!(any(unix, windows)),
        "replay": cfg!(any(unix, windows)),
        "binaryFrames": false,
    })
}
