#![cfg(unix)]

#[allow(dead_code)]
#[path = "support/process.rs"]
mod process_fixture;
mod support;

use std::fs::File;
use std::io::{ErrorKind, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::thread;
use std::time::{Duration, Instant};

use process_fixture::WorkerFixture;
use serde_json::{Value, json};

const INSTANCE: &str = "process-cancel-fake";
const CALL_ID: &str = "process-call";

struct FakeHost {
    listener: UnixListener,
    _owner: File,
    worker: WorkerFixture,
}

impl FakeHost {
    fn start() -> Self {
        let worker = WorkerFixture::start(INSTANCE);
        let owner = File::create(worker.env.instance_root(INSTANCE).join("state/process-host.lock"))
            .unwrap();
        owner.lock().unwrap();
        let listener = UnixListener::bind(worker.env.socket_file(INSTANCE).with_file_name("process.sock"))
            .unwrap();
        listener.set_nonblocking(true).unwrap();
        Self { listener, _owner: owner, worker }
    }

    fn call(&self, method: &str, input: Value, exchange: impl FnOnce()) -> Value {
        thread::scope(|scope| {
            let result = scope.spawn(|| self.worker.env.rpc(INSTANCE, "tool", &json!({
                "protocol": "rpc", "type": "request", "id": CALL_ID, "method": method,
                "message": {"input": input, "context": {
                    "ctxId": INSTANCE, "workspace": self.worker.env.protocol_workspace(),
                }},
            })));
            exchange();
            result.join().unwrap()
        })
    }

    fn cancel(&self) {
        let ack = self.worker.env.rpc(INSTANCE, "tool", &json!({
            "protocol": "rpc", "type": "request", "id": "cancel", "method": "tool.call.cancel",
            "message": {"rpcRequestId": CALL_ID, "ctxId": INSTANCE},
        }));
        assert_eq!(ack["message"]["cancelled"], true, "{ack}");
    }

    fn expect(&self, method: &str) -> HostRequest {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let mut stream = match self.listener.accept() {
                Ok((stream, _)) => stream,
                Err(error) if error.kind() == ErrorKind::WouldBlock => {
                    assert!(Instant::now() < deadline, "missing {method} request");
                    thread::sleep(Duration::from_millis(2));
                    continue;
                }
                Err(error) => panic!("accept {method}: {error}"),
            };
            stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            let mut length = [0; 4];
            stream.read_exact(&mut length).unwrap();
            let mut body = vec![0; u32::from_be_bytes(length) as usize];
            stream.read_exact(&mut body).unwrap();
            let request = HostRequest { stream, request: serde_json::from_slice(&body).unwrap() };
            // The Worker's control watcher also probes the fake Host.
            match request.request["method"].as_str().unwrap() {
                "process.handshake" => {
                    let identity = json!({"securityMode": "disabled", "execution": null});
                    request.reply(json!({
                        "version": 2, "pid": std::process::id(), "instance": INSTANCE, "generation": "fake",
                        "executionIdentity": blake3::hash(&serde_json::to_vec(&identity).unwrap()).to_hex().as_str(),
                    }));
                }
                "process.v1.list" => request.reply(json!([])),
                actual => {
                    assert_eq!(actual, method, "{}", request.request);
                    return request;
                }
            }
        }
    }

    fn task_request(&self, method: &str, id: &Value) -> HostRequest {
        let request = self.expect(method);
        assert_eq!(&request.request["params"]["id"], id);
        request
    }

    fn descriptor(&self, id: &Value, state: &str, bytes: usize) -> Value {
        json!({
            "id": id, "workspace": self.worker.env.protocol_workspace(), "state": state,
            "latestSeq": u64::from(bytes > 0), "shellGeneration": 1,
            "capture": {
                "stdout": {"storedBytes": bytes, "sourceBytes": bytes, "truncated": false},
                "stderr": {"storedBytes": 0, "sourceBytes": 0, "truncated": false},
            },
        })
    }
}

struct HostRequest {
    stream: UnixStream,
    request: Value,
}

impl HostRequest {
    fn reply(self, result: Value) {
        self.respond(json!({"ok": true, "result": result}));
    }

    fn respond(mut self, mut response: Value) {
        response["type"] = json!("response");
        response["id"] = self.request["id"].clone();
        let body = serde_json::to_vec(&response).unwrap();
        self.stream.write_all(&(body.len() as u32).to_be_bytes()).unwrap();
        self.stream.write_all(&body).unwrap();
    }
}

#[test]
fn cancelled_terminal_create_closes_the_spawned_terminal_before_returning() {
    let host = FakeHost::start();
    let mut id = Value::Null;
    let response = host.call("task_manage", json!({"command": "create"}), || {
        let spawn = host.expect("process.v1.spawn");
        // The Host allocated the terminal, but the worker has not seen the descriptor.
        id = spawn.request["params"]["id"].clone();
        assert!(id.is_string(), "{id}");
        host.cancel();
        spawn.reply(host.descriptor(&id, "running", 0));
        host.task_request("process.v1.kill", &id).reply(json!({"accepted": true}));
        host.task_request("process.v1.read", &id)
            .reply(json!({"process": host.descriptor(&id, "exited", 0), "frames": []}));
    });
    assert_eq!(response["error"]["code"], "tool.cancelled", "{response}");
    assert_eq!(response["error"]["details"], json!({"taskId": id, "killRequested": true, "state": "exited"}));
}

#[test]
fn bash_cancellation_during_final_capture_kills_before_losing_the_first_handle() {
    let host = FakeHost::start();
    let mut id = Value::Null;
    let response = host.call("bash_run", json!({"command": "printf x; sleep 60", "waitMs": 0}), || {
        let spawn = host.expect("process.v1.spawn");
        id = spawn.request["params"]["id"].clone();
        spawn.reply(host.descriptor(&id, "running", 1));
        let capture = host.task_request("process.v1.capture", &id);
        host.cancel();
        capture.reply(json!({"dataBase64": "eA=="}));
        host.task_request("process.v1.kill", &id).reply(json!({"accepted": true}));
        host.task_request("process.v1.read", &id)
            .reply(json!({"process": host.descriptor(&id, "running", 1), "frames": []}));
        host.task_request("process.v1.read", &id)
            .reply(json!({"process": host.descriptor(&id, "exited", 1), "frames": []}));
    });
    assert_eq!(response["error"]["code"], "tool.cancelled", "{response}");
    assert_eq!(response["error"]["details"], json!({"taskId": id, "killRequested": true, "state": "exited"}));
}

#[test]
fn cancelled_task_wait_returns_the_unadvanced_cursor_without_killing() {
    let host = FakeHost::start();
    let id = json!("process-observed");
    let first = host.call("task_input", json!({"task": id, "waitMs": 0}), || {
        host.task_request("process.v1.describe", &id).reply(host.descriptor(&id, "running", 0));
    });
    assert_eq!(first["type"], "reply", "{first}");
    let cursor = first["message"]["cursor"].as_str().unwrap();
    let response = host.call("task_input", json!({"task": id, "cursor": cursor, "untilExit": true, "waitMs": 10000}), || {
        host.task_request("process.v1.describe", &id).reply(host.descriptor(&id, "running", 0));
        let waiting = host.task_request("process.v1.read", &id);
        host.cancel();
        waiting.reply(json!({"process": host.descriptor(&id, "running", 1), "frames": []}));
    });
    assert_eq!(response["error"]["code"], "tool.cancelled", "{response}");
    assert_eq!(response["error"]["details"]["taskId"], id, "{response}");
    assert_eq!(response["error"]["details"]["cursor"], cursor, "{response}");
    let resumed = host.call("task_input", json!({"task": id, "cursor": cursor, "waitMs": 0}), || {
        host.task_request("process.v1.describe", &id).reply(host.descriptor(&id, "running", 1));
        let capture = host.task_request("process.v1.capture", &id);
        assert_eq!(capture.request["params"]["offset"], 0);
        capture.reply(json!({"dataBase64": "eA=="}));
    });
    assert_eq!(resumed["message"]["termination"], "running", "{resumed}");
    assert_eq!(resumed["message"]["stdout"], "x", "{resumed}");
}

#[test]
fn cancelled_close_distinguishes_an_accepted_kill_from_observed_exit() {
    let host = FakeHost::start();
    let id = json!("process-closing");
    let response = host.call("task_manage", json!({"command": "close", "task": id}), || {
        host.task_request("process.v1.describe", &id).reply(host.descriptor(&id, "running", 0));
        let kill = host.task_request("process.v1.kill", &id);
        host.cancel();
        kill.reply(json!({"accepted": true}));
    });
    assert_eq!(response["error"]["code"], "tool.cancelled", "{response}");
    assert_eq!(response["error"]["details"], json!({"taskId": id, "killRequested": true, "state": "running"}));
}

#[test]
fn cancelled_create_with_lost_spawn_reply_and_rejected_kill_keeps_a_recoverable_id() {
    let host = FakeHost::start();
    let mut id = Value::Null;
    let response = host.call("task_manage", json!({"command": "create"}), || {
        let spawn = host.expect("process.v1.spawn");
        id = spawn.request["params"]["id"].clone();
        assert!(id.is_string(), "{id}");
        host.cancel();
        // The Host created the task, but the spawn reply never arrives.
        drop(spawn);
        host.task_request("process.v1.kill", &id).reply(json!({"accepted": false}));
    });
    assert_eq!(response["error"]["code"], "tool.cancelled", "{response}");
    let details = &response["error"]["details"];
    assert_eq!(details["taskId"], id, "{response}");
    assert_eq!(details["cleanupError"]["code"], "process.killFailed", "{response}");
    assert!(details.get("killRequested").is_none(), "{response}");
    assert!(details.get("state").is_none(), "{response}");

    let resumed = host.call("task_input", json!({"task": details["taskId"], "waitMs": 0}), || {
        host.task_request("process.v1.describe", &id).reply(host.descriptor(&id, "running", 0));
    });
    assert_eq!(resumed["message"]["task"]["id"], id, "{resumed}");
    assert_eq!(resumed["message"]["termination"], "running", "{resumed}");
}

#[test]
fn cancelled_task_input_without_cursor_can_resume_at_the_pre_input_tail() {
    let host = FakeHost::start();
    let id = json!("process-input");
    let response = host.call("task_input", json!({"task": id, "input": "hello\n"}), || {
        host.task_request("process.v1.describe", &id).reply(host.descriptor(&id, "running", 1));
        let input = host.task_request("process.v1.input", &id);
        assert_eq!(input.request["params"]["dataBase64"], "aGVsbG8K");
        host.cancel();
        input.reply(json!({"accepted": true}));
    });
    assert_eq!(response["error"]["code"], "tool.cancelled", "{response}");
    let details = &response["error"]["details"];
    assert_eq!(details["taskId"], id, "{response}");
    let cursor = details["cursor"].as_str().unwrap();
    let resumed = host.call("task_input", json!({"task": id, "cursor": cursor, "waitMs": 0}), || {
        host.task_request("process.v1.describe", &id).reply(host.descriptor(&id, "running", 2));
        let capture = host.task_request("process.v1.capture", &id);
        assert_eq!(capture.request["params"]["offset"], 1);
        capture.reply(json!({"dataBase64": "eQ=="}));
    });
    assert_eq!(resumed["message"]["termination"], "running", "{resumed}");
    assert_eq!(resumed["message"]["stdout"], "y", "{resumed}");
}
