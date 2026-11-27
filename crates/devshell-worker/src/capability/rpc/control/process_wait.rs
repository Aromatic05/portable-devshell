use std::sync::Arc;
use std::time::Duration;

use serde_json::json;

use crate::capability::process::client::ProcessHostClient;
use crate::capability::rpc::error::RpcError;
use crate::capability::rpc::router::{ControlHandler, control_handler};
use crate::instance::{InstanceName, storage::InstancePaths};
use crate::transport::endpoint::channel::EndpointPaths;

pub(super) fn handler(instance: InstanceName, method: &'static str) -> Arc<dyn ControlHandler> {
    control_handler(move |request| {
        let error = |message| RpcError::new("process.hostFailed", message);
        let paths = InstancePaths::resolve(&instance).map_err(error)?;
        let endpoints = EndpointPaths::resolve(&instance).map_err(error)?;
        match ProcessHostClient::connect(&instance, &paths, &endpoints).map_err(error)? {
            Some(client) => client.call_rpc(method, request.params.clone(), Duration::from_secs(5)),
            None => Ok(if method == "process.v1.confirmWait" {
                json!({"retained": false})
            } else {
                json!({"reconciled": true})
            }),
        }
    })
}
