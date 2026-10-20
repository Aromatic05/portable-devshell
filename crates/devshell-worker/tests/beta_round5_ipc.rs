#![cfg(target_os = "linux")]

#[path = "support/endpoint.rs"]
mod endpoint;
mod support;

use std::fs;
use std::process::Stdio;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use endpoint::{TransportEndpointReader, TransportEndpointWriter};
use serde_json::{Value, json};
use support::TestEnv;

fn start(env: &TestEnv, instance: &str) {
    env.command()
        .env("SHELL", "/bin/sh")
        .current_dir(env.workspace())
        .args(["start", "--instance", instance])
        .assert()
        .success();
}

fn request(env: &TestEnv, instance: &str, id: &str, method: &str, input: Value) -> Value {
    json!({
        "protocol": "rpc", "type": "request", "id": id, "method": method,
        "message": { "input": input, "context": {
            "workspace": env.workspace(), "ctxId": instance, "source": "mcp"
        }}
    })
}

fn call(env: &TestEnv, instance: &str, id: &str, method: &str, input: Value) -> Value {
    env.rpc(instance, "tool", &request(env, instance, id, method, input))
}

fn tmux_call(env: &TestEnv, instance: &str, id: &str, method: &str, input: Value) -> Value {
    let method = if method == "tmux_close" {
        "tmux_manage"
    } else {
        method
    };
    let input = if method == "tmux_manage" {
        let mut input = input;
        input["command"] = json!("close");
        input
    } else {
        input
    };
    call(env, instance, id, method, input)
}

#[test]
fn terminal_attach_replays_only_new_sequences_after_writer_reconnect() {
    let env = TestEnv::new();
    let instance = "round5-terminal-reconnect";
    fs::write(
        env.workspace().join("writer.sh"),
        concat!(
            "stty -echo\n",
            "printf 'BEFORE\\n'\n",
            "while test ! -f continue; do sleep 0.02; done\n",
            "printf 'AFTER\\n'\n",
            "while test ! -f finish; do sleep 0.02; done\n",
        ),
    )
    .unwrap();
    start(&env, instance);
    let opened = env.rpc(
        instance,
        "terminal",
        &json!({
            "protocol":"rpc", "type":"request", "id":"open", "method":"terminal.open",
            "message":{"workspace":env.workspace(),"cols":80,"rows":24,"command":"sh ./writer.sh"}
        }),
    );
    assert_eq!(opened["type"], "reply", "{opened}");
    let session = &opened["message"];
    let terminal_id = session["terminalId"].clone();
    let generation = session["generation"].clone();
    let mut cursor = 0;
    let mut first = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(4);
    while !first.windows(8).any(|window| window == b"BEFORE\r\n") {
        let attached = env.rpc(
            instance,
            "terminal",
            &json!({
                "protocol":"rpc", "type":"request", "id":"attach", "method":"terminal.attach",
                "message":{"terminalId":terminal_id,"generation":generation,"fromSeq":cursor}
            }),
        );
        assert_eq!(attached["type"], "reply", "{attached}");
        for frame in attached["message"]["replay"].as_array().unwrap() {
            assert_eq!(frame["seq"].as_u64().unwrap(), cursor + 1, "{attached}");
            cursor += 1;
            use base64::Engine as _;
            first.extend(
                base64::engine::general_purpose::STANDARD
                    .decode(frame["dataBase64"].as_str().unwrap())
                    .unwrap(),
            );
        }
        assert!(
            Instant::now() < deadline,
            "terminal output timed out: {attached}"
        );
        thread::sleep(Duration::from_millis(20));
    }
    assert!(first.windows(8).any(|window| window == b"BEFORE\r\n"));
    fs::write(env.workspace().join("continue"), b"go").unwrap();
    let mut after = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(4);
    while !after.windows(7).any(|window| window == b"AFTER\r\n") {
        let attached = env.rpc(
            instance,
            "terminal",
            &json!({
                "protocol":"rpc", "type":"request", "id":"attach2", "method":"terminal.attach",
                "message":{"terminalId":terminal_id,"generation":generation,"fromSeq":cursor}
            }),
        );
        assert_eq!(attached["type"], "reply", "{attached}");
        for frame in attached["message"]["replay"].as_array().unwrap() {
            assert_eq!(frame["seq"].as_u64().unwrap(), cursor + 1, "{attached}");
            cursor += 1;
            use base64::Engine as _;
            after.extend(
                base64::engine::general_purpose::STANDARD
                    .decode(frame["dataBase64"].as_str().unwrap())
                    .unwrap(),
            );
        }
        assert!(
            Instant::now() < deadline,
            "reconnected output timed out: {attached}"
        );
        thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(after, b"AFTER\r\n");
    fs::write(env.workspace().join("finish"), b"done").unwrap();
    let killed = env.rpc(instance, "terminal", &json!({
        "protocol":"rpc", "type":"request", "id":"kill", "method":"terminal.kill",
        "message":{"terminalId":terminal_id,"generation":generation,"version":session["version"],"clientSeq":1}
    }));
    assert_eq!(killed["type"], "reply", "{killed}");
}

#[test]
fn tmux_read_reports_exit_status_after_task_pane_closes() {
    let env = TestEnv::new();
    let instance = "round5-tmux-exit";
    start(&env, instance);
    let run = call(
        &env,
        instance,
        "run",
        "tmux_run",
        json!({
            "command":"printf 'PANE-CLOSED\\n'; sleep 0.2; exit 23", "wait":"nonblock", "timeMs":0
        }),
    );
    assert_eq!(run["type"], "reply", "{run}");
    let task = run["message"]["task"]["id"].as_str().unwrap();
    // tmux_run may synchronously consume the first completed stdout burst.
    let mut output = run["message"]["output"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let deadline = Instant::now() + Duration::from_secs(4);
    let read = loop {
        let read = call(
            &env,
            instance,
            "read",
            "tmux_read",
            json!({"task":task,"line":30,"timeMs":100}),
        );
        assert_eq!(read["type"], "reply", "{read}");
        if let Some(lines) = read["message"]["output"].as_array() {
            output.extend(lines.iter().cloned());
        }
        if read["message"]["task"]["status"] != "running" {
            break read;
        }
        assert!(Instant::now() < deadline, "task pane never closed: {read}");
    };
    assert_eq!(read["message"]["task"]["status"], "23", "{read}");
    assert!(
        output.iter().any(|line| line == "PANE-CLOSED"),
        "incremental tmux_read lost terminal output: {output:?} final response: {read}"
    );
}

#[test]
fn tmux_block_wait_returns_completed_output_and_status() {
    let env = TestEnv::new();
    let instance = "round5-tmux-block";
    start(&env, instance);
    let result = call(
        &env,
        instance,
        "block",
        "tmux_run",
        json!({
            "command":"sleep 0.1; printf 'BLOCK-RESULT\\n'; exit 0", "wait":"block", "timeMs":3000, "line":30
        }),
    );
    assert_eq!(result["type"], "reply", "{result}");
    assert_eq!(result["message"]["task"]["status"], "0", "{result}");
    assert!(
        result["message"]["output"]
            .as_array()
            .unwrap()
            .iter()
            .any(|line| line == "BLOCK-RESULT"),
        "{result}"
    );
}

#[test]
fn tmux_close_preserves_terminated_status_for_later_read() {
    let env = TestEnv::new();
    let instance = "round5-tmux-close";
    start(&env, instance);
    let started = call(
        &env,
        instance,
        "run",
        "tmux_run",
        json!({"command":"sleep 20","wait":"nonblock","timeMs":0}),
    );
    assert_eq!(started["type"], "reply", "{started}");
    let task = started["message"]["task"]["id"].as_str().unwrap();
    let closed = tmux_call(
        &env,
        instance,
        "close",
        "tmux_close",
        json!({"task":task,"force":true}),
    );
    assert_eq!(closed["type"], "reply", "{closed}");
    assert_eq!(closed["message"]["closedTaskId"], task, "{closed}");
    let read = call(
        &env,
        instance,
        "later-read",
        "tmux_read",
        json!({"task":task,"timeMs":0}),
    );
    assert_eq!(read["type"], "reply", "{read}");
    assert_eq!(read["message"]["task"]["status"], "terminated", "{read}");
}

#[test]
fn bash_cancellation_isolated_from_concurrent_request() {
    let env = TestEnv::new();
    let instance = "round5-bash-concurrent";
    start(&env, instance);
    let mut child = env
        .std_command()
        .args(["transport", "--instance", instance])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut writer = TransportEndpointWriter::new(child.stdin.take().unwrap(), instance).unwrap();
    let mut reader = TransportEndpointReader::new(child.stdout.take().unwrap());
    reader.wait_ready().unwrap();
    let (send, receive) = mpsc::channel();
    let reading = thread::spawn(move || {
        while let Ok(packet) = reader.read_packet() {
            if send.send(packet).is_err() {
                break;
            }
        }
    });
    let long = request(
        &env,
        instance,
        "long",
        "bash_run",
        json!({"command":"sleep 20","timeoutMs":25000}),
    );
    let short = request(
        &env,
        instance,
        "short",
        "bash_run",
        json!({"command":"printf survives","timeoutMs":5000}),
    );
    writer.send("tool", &long).unwrap();
    writer.send("tool", &short).unwrap();
    writer
        .send(
            "tool",
            &json!({
                "protocol":"rpc","type":"request","id":"cancel-long","method":"tool.call.cancel",
                "message":{"rpcRequestId":"long","ctxId":instance,"reason":"test"}
            }),
        )
        .unwrap();
    let mut replies = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(5);
    while replies.len() < 3 {
        let packet = receive
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("cancelled and surviving RPC responses must settle");
        if matches!(packet["type"].as_str(), Some("reply" | "error")) {
            replies.push(packet);
        }
    }
    let cancelled = replies
        .iter()
        .find(|packet| packet["id"] == "long")
        .unwrap();
    assert_eq!(cancelled["type"], "error", "{cancelled}");
    assert_eq!(cancelled["error"]["code"], "tool.cancelled", "{cancelled}");
    let survived = replies
        .iter()
        .find(|packet| packet["id"] == "short")
        .unwrap();
    assert_eq!(survived["type"], "reply", "{survived}");
    assert_eq!(survived["message"]["stdout"], "survives", "{survived}");
    let cancel_ack = replies
        .iter()
        .find(|packet| packet["id"] == "cancel-long")
        .unwrap();
    assert_eq!(cancel_ack["message"]["cancelled"], true, "{cancel_ack}");
    drop(writer);
    assert!(child.wait().unwrap().success());
    reading.join().unwrap();
}

#[test]
fn file_edit_failed_batch_publishes_nothing_and_corrected_retry_publishes_atomically() {
    let env = TestEnv::new();
    let instance = "round5-edit-retry";
    fs::write(env.workspace().join("a.txt"), "alpha\n").unwrap();
    fs::write(env.workspace().join("b.txt"), "bravo\n").unwrap();
    start(&env, instance);
    let read = call(
        &env,
        instance,
        "read",
        "file_read",
        json!({"files":[
            {"path":"./a.txt","view":"content"},{"path":"./b.txt","view":"content"}
        ]}),
    );
    assert_eq!(read["type"], "reply", "{read}");
    let bad = call(
        &env,
        instance,
        "bad",
        "file_edit",
        json!({"changes":
            "*** Begin Edit\n*** Patch File: ./a.txt\n@@\n-alpha\n+ALPHA\n*** Patch File: ./b.txt\n@@\n-no-such-line\n+BRAVO\n*** End Edit"
        }),
    );
    assert_eq!(bad["type"], "reply", "{bad}");
    assert_eq!(
        bad["message"]["operations"][0]["status"], "notExecuted",
        "{bad}"
    );
    assert_eq!(bad["message"]["operations"][1]["status"], "failed", "{bad}");
    assert_eq!(
        fs::read_to_string(env.workspace().join("a.txt")).unwrap(),
        "alpha\n"
    );
    assert_eq!(
        fs::read_to_string(env.workspace().join("b.txt")).unwrap(),
        "bravo\n"
    );
    let retry = call(
        &env,
        instance,
        "retry",
        "file_edit",
        json!({"changes":
            "*** Begin Edit\n*** Patch File: ./a.txt\n@@\n-alpha\n+ALPHA\n*** Patch File: ./b.txt\n@@\n-bravo\n+BRAVO\n*** End Edit"
        }),
    );
    assert_eq!(retry["type"], "reply", "{retry}");
    assert!(
        retry["message"]["operations"]
            .as_array()
            .unwrap()
            .iter()
            .all(|operation| operation["status"] == "applied"),
        "{retry}"
    );
    assert_eq!(
        fs::read_to_string(env.workspace().join("a.txt")).unwrap(),
        "ALPHA\n"
    );
    assert_eq!(
        fs::read_to_string(env.workspace().join("b.txt")).unwrap(),
        "BRAVO\n"
    );
}
