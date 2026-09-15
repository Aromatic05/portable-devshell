use std::path::Path;
use std::sync::Arc;

use serde::Deserialize;

use crate::capability::rpc::error::RpcError;
use crate::capability::rpc::router::{ControlHandler, control_handler, parse_params, serialize};
use crate::instance::workspace::alert::{AlertConfig, AlertError, AlertService};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AlertsReadInput {
    config: Option<AlertConfig>,
    workspace: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AlertsConfigureInput {
    config: Option<AlertConfig>,
}

pub fn read_handler(service: Arc<AlertService>) -> Arc<dyn ControlHandler> {
    control_handler(move |request| {
        let input: AlertsReadInput = parse_params(request)?;
        let advice = service
            .read(Path::new(&input.workspace), input.config)
            .map_err(rpc_error)?;
        serialize(serde_json::json!({ "advice": advice }))
    })
}

pub fn touch_handler(service: Arc<AlertService>) -> Arc<dyn ControlHandler> {
    control_handler(move |request| {
        let input: AlertsReadInput = parse_params(request)?;
        service
            .touch(Path::new(&input.workspace), input.config)
            .map_err(rpc_error)?;
        serialize(serde_json::json!({}))
    })
}

pub fn configure_handler(service: Arc<AlertService>) -> Arc<dyn ControlHandler> {
    control_handler(move |request| {
        let input: AlertsConfigureInput = parse_params(request)?;
        service.configure(input.config).map_err(rpc_error)?;
        serialize(serde_json::json!({}))
    })
}

fn rpc_error(error: AlertError) -> RpcError {
    RpcError::new(error.code, error.message)
}
