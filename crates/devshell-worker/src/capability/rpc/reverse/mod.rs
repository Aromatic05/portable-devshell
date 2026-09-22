mod queue;
mod replay;

use std::collections::HashSet;
use std::num::NonZeroUsize;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use lru::LruCache;

use crate::capability::rpc::codec::{MAX_FRAME_SIZE, decode_request_frame, encode_json};
use crate::capability::rpc::response::RpcResponse;
use crate::capability::rpc::router::RpcRouter;
use crate::transport::reverse::{ReversePayload, ReversePayloadFrame};

use queue::ReverseResponseQueue;
use replay::{REQUEST_CACHE_SIZE, request_cache_key};

struct ReverseDispatcher {
    router: Arc<RpcRouter>,
    completed: Mutex<LruCache<String, Vec<u8>>>,
    in_flight: Mutex<HashSet<String>>,
    responses: Arc<ReverseResponseQueue>,
}

impl ReverseDispatcher {
    fn new(router: Arc<RpcRouter>, responses: Arc<ReverseResponseQueue>) -> Self {
        Self {
            router,
            completed: Mutex::new(LruCache::new(
                NonZeroUsize::new(REQUEST_CACHE_SIZE).expect("request cache size must be non-zero"),
            )),
            in_flight: Mutex::new(HashSet::new()),
            responses,
        }
    }

    fn dispatch(self: &Arc<Self>, frame: &[u8]) -> Result<Option<ReversePayloadFrame>, String> {
        let request = match decode_request_frame(frame) {
            Ok(request) => request,
            Err(error) => {
                return encode_json(&RpcResponse::failure(error.id, error.error)).map(|frame| {
                    Some(ReversePayloadFrame {
                        opaque_id: None,
                        frame,
                    })
                });
            }
        };
        let key = request_cache_key(&request.id, frame);
        if self
            .in_flight
            .lock()
            .map_err(|_| "reverse in-flight request lock poisoned".to_string())?
            .contains(&key)
        {
            return Ok(None);
        }
        if let Some(cached) = self
            .completed
            .lock()
            .map_err(|_| "reverse request cache lock poisoned".to_string())?
            .get(&key)
            .cloned()
        {
            self.responses.remove_key(&key)?;
            return Ok(Some(ReversePayloadFrame {
                opaque_id: Some(key),
                frame: cached,
            }));
        }

        if self.router.is_control_method(&request.method) {
            let response = self.router.dispatch_control(request);
            let encoded = encode_json(&response)?;
            self.completed
                .lock()
                .map_err(|_| "reverse request cache lock poisoned".to_string())?
                .put(key.clone(), encoded.clone());
            return Ok(Some(ReversePayloadFrame {
                opaque_id: Some(key),
                frame: encoded,
            }));
        }

        {
            let mut in_flight = self
                .in_flight
                .lock()
                .map_err(|_| "reverse in-flight request lock poisoned".to_string())?;
            if !in_flight.insert(key.clone()) {
                return Ok(None);
            }
        }

        let permit = match self.router.acquire_tool_permit(&request) {
            Ok(permit) => permit,
            Err(error) => {
                self.in_flight
                    .lock()
                    .map_err(|_| "reverse in-flight request lock poisoned".to_string())?
                    .remove(&key);
                let response = RpcResponse::failure(request.id, error);
                let encoded = encode_json(&response)?;
                self.completed
                    .lock()
                    .map_err(|_| "reverse request cache lock poisoned".to_string())?
                    .put(key.clone(), encoded.clone());
                return Ok(Some(ReversePayloadFrame {
                    opaque_id: Some(key),
                    frame: encoded,
                }));
            }
        };

        let dispatcher = Arc::clone(self);
        thread::spawn(move || {
            let response = dispatcher.router.dispatch_tool(request, permit);
            let encoded =
                encode_json(&response).expect("serializing a reverse RPC response should not fail");
            if let Ok(mut completed) = dispatcher.completed.lock() {
                completed.put(key.clone(), encoded.clone());
            }
            if let Ok(mut in_flight) = dispatcher.in_flight.lock() {
                // Publish a response only after the request is no longer
                // in-flight. The terminal response cache is populated first,
                // so an exact transport replay covered by the bounded
                // terminal-response cache does not execute the logical request
                // twice, regardless of whether its outcome succeeded or failed.
                in_flight.remove(&key);
            }
            let _ = dispatcher.responses.push_back(ReversePayloadFrame {
                opaque_id: Some(key.clone()),
                frame: encoded,
            });
        });
        Ok(None)
    }
}

#[derive(Default)]
struct RpcPacketDecoder {
    buffer: Vec<u8>,
}

impl RpcPacketDecoder {
    fn push(&mut self, bytes: &[u8]) -> Result<Vec<Vec<u8>>, String> {
        self.buffer.extend_from_slice(bytes);
        let mut packets = Vec::new();
        loop {
            if self.buffer.len() < 4 {
                break;
            }
            let length = u32::from_be_bytes(self.buffer[..4].try_into().unwrap()) as usize;
            if length > MAX_FRAME_SIZE {
                return Err(format!("rpc.frameTooLarge:{length}"));
            }
            let packet_len = 4_usize
                .checked_add(length)
                .ok_or_else(|| "rpc frame length overflow".to_string())?;
            if self.buffer.len() < packet_len {
                break;
            }
            packets.push(self.buffer.drain(..packet_len).collect());
        }
        Ok(packets)
    }

    fn clear(&mut self) {
        self.buffer.clear();
    }
}

#[derive(Clone)]
pub struct ReverseRpcPayload {
    decoder: Arc<Mutex<RpcPacketDecoder>>,
    router: Arc<RpcRouter>,
    dispatcher: Arc<ReverseDispatcher>,
    responses: Arc<ReverseResponseQueue>,
}

impl ReverseRpcPayload {
    pub fn new(router: Arc<RpcRouter>) -> Self {
        let responses = Arc::new(ReverseResponseQueue::default());
        let dispatcher = Arc::new(ReverseDispatcher::new(
            Arc::clone(&router),
            Arc::clone(&responses),
        ));
        Self {
            decoder: Arc::new(Mutex::new(RpcPacketDecoder::default())),
            router,
            dispatcher,
            responses,
        }
    }
}

impl ReversePayload for ReverseRpcPayload {
    fn is_stopping(&self) -> bool {
        self.router.shutdown_requested()
    }

    fn prepare_connection(&self) -> Result<(), String> {
        self.decoder
            .lock()
            .map_err(|_| "reverse RPC decoder lock poisoned".to_string())?
            .clear();
        self.router.clear_notifications()
    }

    fn accept_inbound(&self, bytes: &[u8]) -> Result<Option<ReversePayloadFrame>, String> {
        let packets = self
            .decoder
            .lock()
            .map_err(|_| "reverse RPC decoder lock poisoned".to_string())?
            .push(bytes)?;
        for packet in packets {
            if let Some(response) = self.dispatcher.dispatch(&packet)? {
                self.responses.push_back(response)?;
            }
        }
        Ok(None)
    }

    fn queue_outbound(&self, frame: ReversePayloadFrame) -> Result<(), String> {
        self.responses.push_back(frame)
    }

    fn try_pop_outbound(&self) -> Result<Option<ReversePayloadFrame>, String> {
        if let Some(frame) = self.responses.try_pop()? {
            return Ok(Some(frame));
        }
        Ok(self
            .router
            .try_pop_notification()?
            .map(|frame| ReversePayloadFrame {
                frame,
                opaque_id: None,
            }))
    }

    fn wait_pop_outbound(&self, timeout: Duration) -> Result<Option<ReversePayloadFrame>, String> {
        if let Some(frame) = self.responses.wait_pop(timeout)? {
            return Ok(Some(frame));
        }
        Ok(self
            .router
            .try_pop_notification()?
            .map(|frame| ReversePayloadFrame {
                frame,
                opaque_id: None,
            }))
    }

    fn requeue_front(&self, frame: ReversePayloadFrame) -> Result<(), String> {
        self.responses.push_front(frame)
    }

    fn wake_outbound(&self) {
        self.responses.wake();
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::thread;
    use std::time::Duration;

    use serde_json::json;

    use super::{ReverseDispatcher, ReverseResponseQueue, request_cache_key};
    use crate::capability::artifact::payload::ArtifactPayloadStore;
    use crate::capability::artifact::receive::ArtifactReceiveStore;
    use crate::capability::artifact::store::ArtifactStore;
    use crate::capability::rpc::codec::{decode_json, encode_json};
    use crate::capability::rpc::request::RpcRequest;
    use crate::capability::rpc::response::RpcResponse;
    use crate::capability::rpc::router::RpcRouter;
    use crate::daemon::process::{PlatformInfo, WorkerRuntimeContext};
    use crate::instance::sandbox::SecurityMode;
    use crate::instance::{InstanceName, WorkerConfig};
    use crate::tool::{
        ToolCall, ToolCapability, ToolCatalogEntry, ToolError, ToolHandler, ToolName, ToolRegistry,
    };
    use crate::transport::reverse::{next_generation_value, reverse_endpoint};

    struct CountingMutationTool {
        calls: Arc<AtomicUsize>,
        fail_first: bool,
        name: ToolName,
    }

    impl ToolHandler for CountingMutationTool {
        fn name(&self) -> &ToolName {
            &self.name
        }

        fn catalog_entry(&self) -> ToolCatalogEntry {
            ToolCatalogEntry {
                group: "test".to_string(),
                name: "test_mutation".to_string(),
                description: "Count a non-idempotent mutation.".to_string(),
                input_schema: json!({ "type": "object" }),
                output_schema: json!({ "type": "object" }),
                required_capabilities: vec![ToolCapability::Execute],
            }
        }

        fn call(&self, _call: ToolCall) -> Result<serde_json::Value, ToolError> {
            let value = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
            if self.fail_first && value == 1 {
                return Err(ToolError::retryable(
                    "test.retryable",
                    "injected retryable mutation failure",
                ));
            }
            Ok(json!({ "executionCount": value }))
        }
    }

    struct CancellableWaitTool {
        name: ToolName,
        started: Arc<AtomicBool>,
    }

    impl ToolHandler for CancellableWaitTool {
        fn name(&self) -> &ToolName {
            &self.name
        }

        fn catalog_entry(&self) -> ToolCatalogEntry {
            ToolCatalogEntry {
                group: "test".to_string(),
                name: "test_wait".to_string(),
                description: "Wait until cancelled.".to_string(),
                input_schema: json!({ "type": "object" }),
                output_schema: json!({ "type": "object" }),
                required_capabilities: vec![ToolCapability::Execute],
            }
        }

        fn call(&self, call: ToolCall) -> Result<serde_json::Value, ToolError> {
            self.started.store(true, Ordering::SeqCst);
            loop {
                call.check_cancelled()?;
                thread::sleep(Duration::from_millis(5));
            }
        }
    }

    #[test]
    fn endpoint_preserves_public_base_path() {
        assert_eq!(
            reverse_endpoint("https://example.test/base", "/reverse/v1/connect", true)
                .unwrap()
                .as_str(),
            "wss://example.test/base/reverse/v1/connect"
        );
    }

    #[test]
    fn cache_key_changes_when_request_payload_changes() {
        assert_ne!(request_cache_key("1", b"a"), request_cache_key("1", b"b"));
    }

    #[test]
    fn generation_remains_monotonic_when_the_clock_moves_backwards() {
        assert_eq!(next_generation_value(150, 200, 100), 201);
        assert_eq!(next_generation_value(0, 0, 500), 500);
    }

    #[test]
    fn reverse_dispatcher_replays_completed_mutation_without_executing_it_twice() {
        let root = crate::testing::temp_dir();
        let workspace = root.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let instance = InstanceName::parse("reverse-once").unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let mut registry = ToolRegistry::new();
        registry
            .register(Arc::new(CountingMutationTool {
                calls: Arc::clone(&calls),
                fail_first: false,
                name: ToolName::parse("test_mutation").unwrap(),
            }))
            .unwrap();
        let artifacts = ArtifactStore::new(root.path().join("artifacts")).unwrap();
        let payloads = ArtifactPayloadStore::new(root.path().join("payloads"), artifacts).unwrap();
        let receives = ArtifactReceiveStore::new(root.path().join("receives")).unwrap();
        let router = Arc::new(RpcRouter::new(
            WorkerConfig {
                version: 1,
                instance: instance.as_str().to_string(),
                created_at: 1,
                reverse: None,
            },
            WorkerRuntimeContext {
                instance,
                platform: PlatformInfo {
                    os: std::env::consts::OS,
                    arch: std::env::consts::ARCH,
                },
                security_mode: SecurityMode::Disabled,
                worker_sha256: Some("0".repeat(64)),
            },
            Arc::new(registry),
            payloads,
            receives,
            Arc::new(crate::instance::storage::ExtensionResourceStore::new(
                root.path().join("resource-root"),
            )),
        ));
        let responses = Arc::new(ReverseResponseQueue::default());
        let dispatcher = Arc::new(ReverseDispatcher::new(router, Arc::clone(&responses)));
        let request: RpcRequest = serde_json::from_value(json!({
            "type": "request",
            "id": "mutation-1",
            "method": "test_mutation",
            "params": { "value": 1 },
            "context": {
                "requestId": "operation-1",
                "operationId": "operation-1",
                "ctxId": "ctx-reverse",
                "source": "control",
                "workspace": workspace
            }
        }))
        .unwrap();
        let frame = encode_json(&request).unwrap();

        assert!(dispatcher.dispatch(&frame).unwrap().is_none());
        let first = responses
            .wait_pop(Duration::from_secs(2))
            .unwrap()
            .expect("first mutation response");
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        // Simulate a response lost after the worker completed the mutation. The
        // controller replays the exact request frame after reconnect.
        let replay = dispatcher
            .dispatch(&frame)
            .unwrap()
            .expect("cached mutation response");
        assert_eq!(replay.frame, first.frame);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(responses.try_pop().unwrap().is_none());

        let changed: RpcRequest = serde_json::from_value(json!({
            "type": "request",
            "id": "mutation-1",
            "method": "test_mutation",
            "params": { "value": 2 },
            "context": {
                "requestId": "operation-1",
                "operationId": "operation-1",
                "ctxId": "ctx-reverse",
                "source": "control",
                "workspace": workspace
            }
        }))
        .unwrap();
        assert!(
            dispatcher
                .dispatch(&encode_json(&changed).unwrap())
                .unwrap()
                .is_none()
        );
        responses
            .wait_pop(Duration::from_secs(2))
            .unwrap()
            .expect("changed mutation response");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn reverse_dispatcher_replays_failed_mutation_without_executing_it_twice() {
        let root = crate::testing::temp_dir();
        let workspace = root.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let instance = InstanceName::parse("reverse-retry").unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let mut registry = ToolRegistry::new();
        registry
            .register(Arc::new(CountingMutationTool {
                calls: Arc::clone(&calls),
                fail_first: true,
                name: ToolName::parse("test_mutation").unwrap(),
            }))
            .unwrap();
        let artifacts = ArtifactStore::new(root.path().join("artifacts")).unwrap();
        let payloads = ArtifactPayloadStore::new(root.path().join("payloads"), artifacts).unwrap();
        let receives = ArtifactReceiveStore::new(root.path().join("receives")).unwrap();
        let router = Arc::new(RpcRouter::new(
            WorkerConfig {
                version: 1,
                instance: instance.as_str().to_string(),
                created_at: 1,
                reverse: None,
            },
            WorkerRuntimeContext {
                instance,
                platform: PlatformInfo {
                    os: std::env::consts::OS,
                    arch: std::env::consts::ARCH,
                },
                security_mode: SecurityMode::Disabled,
                worker_sha256: Some("0".repeat(64)),
            },
            Arc::new(registry),
            payloads,
            receives,
            Arc::new(crate::instance::storage::ExtensionResourceStore::new(
                root.path().join("resource-root"),
            )),
        ));
        let responses = Arc::new(ReverseResponseQueue::default());
        let dispatcher = Arc::new(ReverseDispatcher::new(router, Arc::clone(&responses)));
        let request: RpcRequest = serde_json::from_value(json!({
            "type": "request",
            "id": "retryable-mutation",
            "method": "test_mutation",
            "params": { "value": 1 },
            "context": {
                "requestId": "retryable-operation",
                "operationId": "retryable-operation",
                "ctxId": "ctx-reverse",
                "source": "control",
                "workspace": workspace
            }
        }))
        .unwrap();
        let frame = encode_json(&request).unwrap();

        assert!(dispatcher.dispatch(&frame).unwrap().is_none());
        let first = responses
            .wait_pop(Duration::from_secs(2))
            .unwrap()
            .expect("failed mutation response");
        let first: RpcResponse = decode_json(&first.frame).unwrap();
        assert!(!first.ok);
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        let replay = dispatcher
            .dispatch(&frame)
            .unwrap()
            .expect("cached failed mutation response");
        let replay: RpcResponse = decode_json(&replay.frame).unwrap();
        assert!(!replay.ok);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(responses.try_pop().unwrap().is_none());
    }

    #[test]
    fn reverse_dispatcher_accepts_cancel_while_a_tool_is_running() {
        let root = crate::testing::temp_dir();
        let workspace = root.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let instance = InstanceName::parse("reverse-cancel").unwrap();
        let started = Arc::new(AtomicBool::new(false));
        let mut registry = ToolRegistry::new();
        registry
            .register(Arc::new(CancellableWaitTool {
                name: ToolName::parse("test_wait").unwrap(),
                started: Arc::clone(&started),
            }))
            .unwrap();
        let artifacts = ArtifactStore::new(root.path().join("artifacts")).unwrap();
        let payloads = ArtifactPayloadStore::new(root.path().join("payloads"), artifacts).unwrap();
        let receives = ArtifactReceiveStore::new(root.path().join("receives")).unwrap();
        let router = Arc::new(RpcRouter::new(
            WorkerConfig {
                version: 1,
                instance: instance.as_str().to_string(),
                created_at: 1,
                reverse: None,
            },
            WorkerRuntimeContext {
                instance,
                platform: PlatformInfo {
                    os: std::env::consts::OS,
                    arch: std::env::consts::ARCH,
                },
                security_mode: SecurityMode::Disabled,
                worker_sha256: Some("0".repeat(64)),
            },
            Arc::new(registry),
            payloads,
            receives,
            Arc::new(crate::instance::storage::ExtensionResourceStore::new(
                root.path().join("resource-root"),
            )),
        ));
        let responses = Arc::new(ReverseResponseQueue::default());
        let dispatcher = Arc::new(ReverseDispatcher::new(router, Arc::clone(&responses)));

        let run_request: RpcRequest = serde_json::from_value(json!({
            "type": "request",
            "id": "long-tool",
            "method": "test_wait",
            "params": {},
            "context": {
                "requestId": "mcp-long-tool",
                "ctxId": "ctx-reverse",
                "source": "mcp",
                "workspace": workspace
            }
        }))
        .unwrap();
        let run = encode_json(&run_request).unwrap();
        let immediate = dispatcher.dispatch(&run).unwrap();
        if let Some(response) = immediate {
            let value: RpcResponse = decode_json(&response.frame).unwrap();
            panic!("expected asynchronous dispatch, got {value:?}");
        }
        assert!(dispatcher.dispatch(&run).unwrap().is_none());
        for _ in 0..100 {
            if started.load(Ordering::SeqCst) {
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
        assert!(started.load(Ordering::SeqCst));

        let cancel_request: RpcRequest = serde_json::from_value(json!({
            "type": "request",
            "id": "cancel-control",
            "method": "tool.call.cancel",
            "params": {
                "reason": "client timeout",
                "rpcRequestId": "long-tool",
                "ctxId": "ctx-reverse"
            }
        }))
        .unwrap();
        let cancel = encode_json(&cancel_request).unwrap();
        let cancel_response = dispatcher.dispatch(&cancel).unwrap().unwrap();
        let cancel_response: RpcResponse = decode_json(&cancel_response.frame).unwrap();
        let cancel_json = serde_json::to_value(&cancel_response).unwrap();
        assert_eq!(cancel_json["result"]["cancelled"], true, "{cancel_json}");

        let tool_response = responses
            .wait_pop(Duration::from_secs(2))
            .unwrap()
            .expect("cancelled tool response");
        let tool_response: RpcResponse = decode_json(&tool_response.frame).unwrap();
        let tool_json = serde_json::to_value(&tool_response).unwrap();
        assert_eq!(tool_json["id"], "long-tool", "{tool_json}");
        assert_eq!(tool_json["error"]["code"], "tool.cancelled", "{tool_json}");
        assert!(responses.try_pop().unwrap().is_none());
    }
}
