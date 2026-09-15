use std::sync::Arc;

use serde::{Serialize, de::DeserializeOwned};

use crate::capability::rpc::error::RpcError;
use crate::capability::rpc::request::RpcRequest;
use crate::tool::ToolCancellation;

pub trait ControlHandler: Send + Sync {
    fn handle(&self, request: &RpcRequest) -> Result<serde_json::Value, RpcError>;

    fn handle_with_cancellation(
        &self,
        request: &RpcRequest,
        _cancellation: &ToolCancellation,
    ) -> Result<serde_json::Value, RpcError> {
        self.handle(request)
    }
}

struct ClosureControlHandler<F>(F);

impl<F> ControlHandler for ClosureControlHandler<F>
where
    F: Fn(&RpcRequest) -> Result<serde_json::Value, RpcError> + Send + Sync,
{
    fn handle(&self, request: &RpcRequest) -> Result<serde_json::Value, RpcError> {
        (self.0)(request)
    }
}

pub fn control_handler<F>(handle: F) -> Arc<dyn ControlHandler>
where
    F: Fn(&RpcRequest) -> Result<serde_json::Value, RpcError> + Send + Sync + 'static,
{
    Arc::new(ClosureControlHandler(handle))
}

struct CancellableClosureControlHandler<F>(F);

impl<F> ControlHandler for CancellableClosureControlHandler<F>
where
    F: Fn(&RpcRequest, &ToolCancellation) -> Result<serde_json::Value, RpcError> + Send + Sync,
{
    fn handle(&self, request: &RpcRequest) -> Result<serde_json::Value, RpcError> {
        (self.0)(request, &ToolCancellation::default())
    }

    fn handle_with_cancellation(
        &self,
        request: &RpcRequest,
        cancellation: &ToolCancellation,
    ) -> Result<serde_json::Value, RpcError> {
        (self.0)(request, cancellation)
    }
}

pub fn cancellable_control_handler<F>(handle: F) -> Arc<dyn ControlHandler>
where
    F: Fn(&RpcRequest, &ToolCancellation) -> Result<serde_json::Value, RpcError>
        + Send
        + Sync
        + 'static,
{
    Arc::new(CancellableClosureControlHandler(handle))
}

pub fn parse_params<T: DeserializeOwned>(request: &RpcRequest) -> Result<T, RpcError> {
    serde_json::from_value(request.params.clone())
        .map_err(|error| RpcError::new("rpc.invalidParams", error.to_string()))
}

pub fn serialize(value: impl Serialize) -> Result<serde_json::Value, RpcError> {
    serde_json::to_value(value)
        .map_err(|error| RpcError::new("rpc.serializeFailed", error.to_string()))
}
