#![cfg(target_os = "linux")]

mod support;

use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::process::Stdio;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine as _;
use endpoint::{TransportEndpointReader, TransportEndpointWriter};
use serde_json::{Value, json};
use support::TestEnv;

#[path = "support/endpoint.rs"]
mod endpoint;

fn start(env: &TestEnv, instance: &str) {
    env.command()
        .env("SHELL", "/bin/sh")
        .current_dir(env.workspace())
        .args(["start", "--instance", instance])
        .assert()
        .success();
}

fn request(env: &TestEnv, instance: &str, id: &str, method: &str, input: Value) -> Value {
    json!({"protocol":"rpc","type":"request","id":id,"method":method,
        "message":{"input":input,"context":{"workspace":env.workspace(),"ctxId":instance,"source":"mcp"}}})
}

fn call(env: &TestEnv, instance: &str, id: &str, method: &str, input: Value) -> Value {
    env.rpc(instance, "tool", &request(env, instance, id, method, input))
}

fn terminal(env: &TestEnv, instance: &str, id: &str, method: &str, message: Value) -> Value {
    env.rpc(
        instance,
        "terminal",
        &json!({"protocol":"rpc","type":"request","id":id,
        "method":method,"message":message}),
    )
}

fn open_terminal(env: &TestEnv, instance: &str, command: &str) -> Value {
    terminal(
        env,
        instance,
        "open",
        "terminal.open",
        json!({
            "workspace":env.workspace(),"cols":100,"rows":40,"command":command
        }),
    )
}

fn attach(env: &TestEnv, instance: &str, session: &Value, from_seq: u64) -> Value {
    terminal(
        env,
        instance,
        "attach",
        "terminal.attach",
        json!({
            "terminalId":session["terminalId"],"generation":session["generation"],"fromSeq":from_seq
        }),
    )
}

fn decode_replay(reply: &Value) -> (Vec<u8>, Vec<u64>) {
    let mut bytes = Vec::new();
    let mut seqs = Vec::new();
    for frame in reply["message"]["replay"].as_array().unwrap() {
        seqs.push(frame["seq"].as_u64().unwrap());
        bytes.extend(
            base64::engine::general_purpose::STANDARD
                .decode(frame["dataBase64"].as_str().unwrap())
                .unwrap(),
        );
    }
    (bytes, seqs)
}

#[test]
fn simultaneous_terminals_keep_output_and_generation_isolated() {
    let env = TestEnv::new();
    let instance = "round6-terminal-isolation";
    start(&env, instance);
    let first = open_terminal(&env, instance, "printf 'FIRST-SESSION\\n'; sleep 10");
    let second = open_terminal(&env, instance, "printf 'SECOND-SESSION\\n'; sleep 10");
    assert_eq!(first["type"], "reply", "{first}");
    assert_eq!(second["type"], "reply", "{second}");
    assert_ne!(
        first["message"]["terminalId"],
        second["message"]["terminalId"]
    );
    let mut saw_first = false;
    let mut saw_second = false;
    let deadline = Instant::now() + Duration::from_secs(5);
    while !(saw_first && saw_second) && Instant::now() < deadline {
        for (session, marker, seen) in [
            (
                &first["message"],
                b"FIRST-SESSION".as_slice(),
                &mut saw_first,
            ),
            (
                &second["message"],
                b"SECOND-SESSION".as_slice(),
                &mut saw_second,
            ),
        ] {
            let reply = attach(&env, instance, session, 0);
            assert_eq!(reply["type"], "reply", "{reply}");
            *seen |= decode_replay(&reply)
                .0
                .windows(marker.len())
                .any(|w| w == marker);
        }
        thread::sleep(Duration::from_millis(20));
    }
    assert!(saw_first, "first terminal output was not replayed");
    assert!(saw_second, "second terminal output was not replayed");
}

#[test]
fn terminal_replay_overflow_reports_gap_with_consistent_bounds() {
    let env = TestEnv::new();
    let instance = "round6-terminal-overflow";
    start(&env, instance);
    let session = open_terminal(&env, instance, "head -c 5000000 /dev/zero; sleep 10");
    assert_eq!(session["type"], "reply", "{session}");
    let deadline = Instant::now() + Duration::from_secs(10);
    let gap = loop {
        let reply = attach(&env, instance, &session["message"], 0);
        if reply["type"] == "error" && reply["error"]["code"] == "stream.gap" {
            break reply;
        }
        assert!(
            Instant::now() < deadline,
            "replay did not overflow: {reply}"
        );
        thread::sleep(Duration::from_millis(30));
    };
    let details = &gap["error"]["details"];
    assert_eq!(details["requestedFromSeq"], 0, "{gap}");
    assert!(details["oldestAvailableSeq"].as_u64().unwrap() > 1, "{gap}");
    assert!(
        details["latestSeq"].as_u64().unwrap() >= details["oldestAvailableSeq"].as_u64().unwrap(),
        "{gap}"
    );
}

#[test]
fn terminal_max_sequence_cursor_is_empty_and_does_not_wrap() {
    let env = TestEnv::new();
    let instance = "round6-terminal-maxseq";
    start(&env, instance);
    let session = open_terminal(&env, instance, "printf 'CURSOR-MARKER\\n'; sleep 10");
    assert_eq!(session["type"], "reply", "{session}");
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        let reply = attach(&env, instance, &session["message"], 0);
        assert_eq!(reply["type"], "reply", "{reply}");
        if decode_replay(&reply)
            .0
            .windows(13)
            .any(|w| w == b"CURSOR-MARKER")
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "terminal marker missing: {reply}"
        );
        thread::sleep(Duration::from_millis(20));
    }
    let max = attach(&env, instance, &session["message"], u64::MAX);
    assert_eq!(max["type"], "reply", "{max}");
    assert!(
        max["message"]["replay"].as_array().unwrap().is_empty(),
        "{max}"
    );
}

#[test]
fn tmux_output_remains_readable_after_task_pane_is_closed() {
    let env = TestEnv::new();
    let instance = "round6-tmux-output-close";
    start(&env, instance);
    let run = call(
        &env,
        instance,
        "run",
        "tmux_run",
        json!({
            "command":"printf 'BEFORE-CLOSE\n'; touch close-ready; sleep 20",
            "wait":"nonblock", "timeMs":0
        }),
    );
    assert_eq!(run["type"], "reply", "{run}");
    let task = run["message"]["task"]["id"].as_str().unwrap();
    let deadline = Instant::now() + Duration::from_secs(4);
    while !env.workspace().join("close-ready").exists() {
        assert!(
            Instant::now() < deadline,
            "tmux task never wrote its marker"
        );
        thread::sleep(Duration::from_millis(10));
    }
    let closed = call(
        &env,
        instance,
        "close",
        "tmux_manage",
        json!({"command":"close","task":task,"force":true}),
    );
    assert_eq!(closed["type"], "reply", "{closed}");
    let read = call(
        &env,
        instance,
        "read",
        "tmux_read",
        json!({"task":task,"line":50,"timeMs":0}),
    );
    assert_eq!(read["type"], "reply", "{read}");
    assert_ne!(read["message"]["task"]["status"], "running", "{read}");
    // tmux_run can consume the first stdout chunk. tmux_read yields only
    // unread frames; the union is the transcript visible to the caller.
    let output = run["message"]["output"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(read["message"]["output"].as_array().into_iter().flatten());
    assert!(
        output.into_iter().any(|line| line == "BEFORE-CLOSE"),
        "task output lost across run+close+read: run={run} read={read}"
    );
}

#[test]
fn concurrent_disjoint_file_edit_batches_both_publish() {
    let env = TestEnv::new();
    let instance = "round6-edit-concurrent";
    fs::write(env.workspace().join("left.txt"), "left-old\n").unwrap();
    fs::write(env.workspace().join("right.txt"), "right-old\n").unwrap();
    start(&env, instance);
    for (ctx, path) in [("left-context", "left.txt"), ("right-context", "right.txt")] {
        let read = call(
            &env,
            instance,
            "read",
            "file_read",
            json!({"files":[{"path":path,"view":"content"}]}),
        );
        assert_eq!(read["type"], "reply", "{read}");
        let _ = ctx;
    }
    thread::scope(|scope| {
        let left = scope.spawn(|| call(&env, instance, "left-edit", "file_edit", json!({"changes":"*** Begin Edit\n*** Patch File: ./left.txt\n@@\n-left-old\n+LEFT-NEW\n*** End Edit"})));
        let right = scope.spawn(|| call(&env, instance, "right-edit", "file_edit", json!({"changes":"*** Begin Edit\n*** Patch File: ./right.txt\n@@\n-right-old\n+RIGHT-NEW\n*** End Edit"})));
        let left = left.join().unwrap();
        let right = right.join().unwrap();
        assert_eq!(left["type"], "reply", "{left}");
        assert_eq!(right["type"], "reply", "{right}");
        assert_eq!(
            left["message"]["operations"][0]["status"], "applied",
            "{left}"
        );
        assert_eq!(
            right["message"]["operations"][0]["status"], "applied",
            "{right}"
        );
    });
    assert_eq!(
        fs::read_to_string(env.workspace().join("left.txt")).unwrap(),
        "LEFT-NEW\n"
    );
    assert_eq!(
        fs::read_to_string(env.workspace().join("right.txt")).unwrap(),
        "RIGHT-NEW\n"
    );
}

#[test]
fn file_edit_rejects_symlink_target_without_mutating_external_file() {
    let env = TestEnv::new();
    let instance = "round6-edit-symlink";
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("target.txt"), "outside-original\n").unwrap();
    symlink(
        outside.path().join("target.txt"),
        env.workspace().join("linked.txt"),
    )
    .unwrap();
    start(&env, instance);
    let result = call(
        &env,
        instance,
        "edit",
        "file_edit",
        json!({
            "changes":"*** Begin Edit\n*** Patch File: ./linked.txt\n@@\n-outside-original\n+changed\n*** End Edit"
        }),
    );
    assert_eq!(
        result["type"], "error",
        "symlink should fail at Worker path authority: {result}"
    );
    assert_eq!(
        result["error"]["code"], "file.pathEscapesWorkspace",
        "{result}"
    );
    assert_eq!(
        fs::read_to_string(outside.path().join("target.txt")).unwrap(),
        "outside-original\n"
    );
}

#[test]
fn file_edit_permission_failure_preserves_contents_and_mode() {
    let env = TestEnv::new();
    let instance = "round6-edit-permission";
    let directory = env.workspace().join("readonly-dir");
    fs::create_dir(&directory).unwrap();
    let path = directory.join("readonly.txt");
    fs::write(&path, "unchanged\n").unwrap();
    // chmod 0444 of the file is NOT enough: POSIX can atomically replace
    // a read-only inode when its parent directory permits rename.
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o555)).unwrap();
    start(&env, instance);
    let read = call(
        &env,
        instance,
        "read",
        "file_read",
        json!({"files":[{"path":"readonly-dir/readonly.txt","view":"content"}]}),
    );
    assert_eq!(read["type"], "reply", "{read}");
    let result = call(
        &env,
        instance,
        "edit",
        "file_edit",
        json!({
            "changes":"*** Begin Edit\n*** Patch File: ./readonly-dir/readonly.txt\n@@\n-unchanged\n+mutated\n*** End Edit"
        }),
    );
    assert!(
        result["type"] == "error" || result["message"]["operations"][0]["status"] != "applied",
        "read-only parent unexpectedly permitted file replacement: {result}"
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), "unchanged\n");
    assert_eq!(
        fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
        0o555
    );
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o755)).unwrap();
}

#[test]
fn daemon_stop_start_reopens_ipc_and_keeps_workspace_files() {
    let env = TestEnv::new();
    let instance = "round6-restart";
    fs::write(env.workspace().join("survivor.txt"), "persisted\n").unwrap();
    start(&env, instance);
    let before = call(
        &env,
        instance,
        "before",
        "bash_run",
        json!({"command":"printf before","timeoutMs":3000}),
    );
    assert_eq!(before["type"], "reply", "{before}");
    assert_eq!(before["message"]["stdout"], "before", "{before}");
    env.command()
        .args(["stop", "--instance", instance])
        .assert()
        .success();
    assert!(
        !env.socket_file(instance).exists(),
        "worker socket remained after stop"
    );
    start(&env, instance);
    let after = call(
        &env,
        instance,
        "after",
        "bash_run",
        json!({"command":"cat survivor.txt","timeoutMs":3000}),
    );
    assert_eq!(after["type"], "reply", "{after}");
    assert_eq!(after["message"]["stdout"], "persisted\n", "{after}");
}

#[test]
fn concurrent_real_ipc_tool_calls_complete_with_distinct_responses() {
    let env = TestEnv::new();
    let instance = "round6-tools-concurrent";
    start(&env, instance);
    thread::scope(|scope| {
        let first = scope.spawn(|| {
            call(
                &env,
                instance,
                "tool-a",
                "bash_run",
                json!({"command":"sleep 0.15; printf alpha","timeoutMs":3000}),
            )
        });
        let second = scope.spawn(|| {
            call(
                &env,
                instance,
                "tool-b",
                "bash_run",
                json!({"command":"printf beta","timeoutMs":3000}),
            )
        });
        let first = first.join().unwrap();
        let second = second.join().unwrap();
        assert_eq!(first["type"], "reply", "{first}");
        assert_eq!(second["type"], "reply", "{second}");
        assert_eq!(first["message"]["stdout"], "alpha", "{first}");
        assert_eq!(second["message"]["stdout"], "beta", "{second}");
    });
}

#[test]
fn cancellation_settles_within_bound_and_next_call_remains_usable() {
    let env = TestEnv::new();
    let instance = "round6-cancel-bound";
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
    writer
        .send(
            "tool",
            &request(
                &env,
                instance,
                "cancelled",
                "bash_run",
                json!({"command":"sleep 30","timeoutMs":35000}),
            ),
        )
        .unwrap();
    let start_deadline = Instant::now() + Duration::from_secs(3);
    writer
        .send(
            "tool",
            &json!({"protocol":"rpc","type":"request","id":"cancel","method":"tool.call.cancel",
        "message":{"rpcRequestId":"cancelled","ctxId":instance,"reason":"round6"}}),
        )
        .unwrap();
    let mut replies = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(4);
    while replies.len() < 2 {
        let packet = receive
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("cancel and command responses must settle within four seconds");
        if matches!(packet["type"].as_str(), Some("reply" | "error")) {
            replies.push(packet);
        }
    }
    assert!(
        Instant::now() < start_deadline,
        "cancel response exceeded its bound: {replies:?}"
    );
    let cancelled = replies
        .iter()
        .find(|packet| packet["id"] == "cancelled")
        .unwrap();
    assert_eq!(cancelled["type"], "error", "{cancelled}");
    assert_eq!(cancelled["error"]["code"], "tool.cancelled", "{cancelled}");
    let ack = replies
        .iter()
        .find(|packet| packet["id"] == "cancel")
        .unwrap();
    assert_eq!(ack["message"]["cancelled"], true, "{ack}");
    drop(writer);
    assert!(child.wait().unwrap().success());
    reading.join().unwrap();
    let recovered = call(
        &env,
        instance,
        "recovered",
        "bash_run",
        json!({"command":"printf recovered","timeoutMs":3000}),
    );
    assert_eq!(recovered["type"], "reply", "{recovered}");
    assert_eq!(recovered["message"]["stdout"], "recovered", "{recovered}");
}
