#![cfg(target_os = "linux")]

#[path = "support/endpoint.rs"]
mod endpoint;
mod support;

use std::fs;
use std::os::unix::fs::symlink;
use std::process::Stdio;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
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

fn tool(env: &TestEnv, instance: &str, id: &str, method: &str, input: Value) -> Value {
    json!({
        "protocol": "rpc", "type": "request", "id": id, "method": method,
        "message": {
            "input": input,
            "context": { "workspace": env.workspace(), "ctxId": instance, "source": "mcp" }
        }
    })
}

fn tool_for_context(env: &TestEnv, ctx_id: &str, id: &str, method: &str, input: Value) -> Value {
    json!({
        "protocol": "rpc", "type": "request", "id": id, "method": method,
        "message": {
            "input": input,
            "context": { "workspace": env.workspace(), "ctxId": ctx_id, "source": "mcp" }
        }
    })
}

// The nested shell records its PID and its sleep child's PID before signalling readiness.
// Keeping both alive makes a surviving descendant observable without a delayed file write.
fn process_tree_command(env: &TestEnv) -> &'static str {
    fs::write(env.workspace().join("tree.sh"), concat!(
        "printf '%s\\n' \"$$\" > shell.pid\n",
        "bash -c 'sleep 60 & child=$!; printf \"%s %s\\n\" \"$$\" \"$child\" > descendants.pending; mv descendants.pending descendants.pid; wait' &\n",
        "wait\n"
    )).unwrap();
    "bash ./tree.sh"
}

fn tree_pids(env: &TestEnv) -> Vec<u32> {
    let mut pids = fs::read_to_string(env.workspace().join("shell.pid")).unwrap();
    pids.push_str(&fs::read_to_string(env.workspace().join("descendants.pid")).unwrap());
    let pids: Vec<u32> = pids
        .split_whitespace()
        .map(|pid| pid.parse().unwrap())
        .collect();
    assert_eq!(pids.len(), 3);
    assert!(pids.iter().all(|pid| *pid > 1));
    pids
}

fn process_running(pid: u32) -> bool {
    match fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => {
            let state = stat.rsplit_once(") ").unwrap().1.as_bytes()[0];
            // A killed orphan may await PID 1 reaping; it cannot execute or hold pipes open.
            !matches!(state, b'Z' | b'X')
        }
        Err(error) => {
            assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
            false
        }
    }
}

fn assert_tree_stopped(pids: &[u32]) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while pids.iter().copied().any(process_running) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
    for pid in pids {
        assert!(
            !process_running(*pid),
            "bash descendant PID {pid} survived termination"
        );
    }
}

fn assert_bash_recovers(env: &TestEnv, instance: &str) {
    let response = env.rpc(
        instance,
        "tool",
        &tool(
            env,
            instance,
            "recovery",
            "bash_run",
            json!({ "command": "printf recovered", "timeoutMs": 5000 }),
        ),
    );
    assert_eq!(response["type"], "reply", "{response}");
    assert_eq!(response["message"]["exitCode"], 0, "{response}");
    assert_eq!(response["message"]["stdout"], "recovered", "{response}");
}

#[test]
fn bash_timeout_kills_recorded_child_and_grandchild_pids_and_recovers() {
    let env = TestEnv::new();
    let instance = "beta-timeout-tree";
    let command = process_tree_command(&env);
    start(&env, instance);
    let response = env.rpc(
        instance,
        "tool",
        &tool(
            &env,
            instance,
            "timeout",
            "bash_run",
            json!({ "command": command, "timeoutMs": 1500 }),
        ),
    );
    assert_eq!(response["type"], "reply", "{response}");
    assert_eq!(response["message"]["termination"], "timeout", "{response}");
    assert_tree_stopped(&tree_pids(&env));
    assert_bash_recovers(&env, instance);
}

#[test]
fn bash_cancel_kills_recorded_child_and_grandchild_pids_and_recovers() {
    let env = TestEnv::new();
    let instance = "beta-cancel-tree";
    let command = process_tree_command(&env);
    start(&env, instance);
    let mut bridge = env
        .std_command()
        .args(["transport", "--instance", instance])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut writer = TransportEndpointWriter::new(bridge.stdin.take().unwrap(), instance).unwrap();
    let mut reader = TransportEndpointReader::new(bridge.stdout.take().unwrap());
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
            &tool(
                &env,
                instance,
                "running",
                "bash_run",
                json!({ "command": command, "timeoutMs": 15000 }),
            ),
        )
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let ready = env.workspace().join("descendants.pid");
    while !ready.exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    let pids = tree_pids(&env);
    for pid in &pids {
        assert!(
            process_running(*pid),
            "PID {pid} was not running before cancellation"
        );
    }
    writer
        .send(
            "tool",
            &json!({
                "protocol": "rpc", "type": "request", "id": "cancel", "method": "tool.call.cancel",
                "message": { "rpcRequestId": "running", "ctxId": instance, "reason": "beta test" }
            }),
        )
        .unwrap();
    let mut replies = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(5);
    while replies.len() < 2 {
        let packet = receive
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("cancel and tool responses must arrive before the bash timeout");
        if matches!(packet["type"].as_str(), Some("reply" | "error")) {
            replies.push(packet);
        }
    }
    let cancel = replies
        .iter()
        .find(|packet| packet["id"] == "cancel")
        .unwrap();
    assert_eq!(cancel["type"], "reply", "{cancel}");
    assert_eq!(cancel["message"]["cancelled"], true, "{cancel}");
    let running = replies
        .iter()
        .find(|packet| packet["id"] == "running")
        .unwrap();
    assert_eq!(running["type"], "error", "{running}");
    assert_eq!(running["error"]["code"], "tool.cancelled", "{running}");
    assert_tree_stopped(&pids);
    drop(writer);
    assert!(bridge.wait().unwrap().success());
    reading.join().unwrap();
    assert_bash_recovers(&env, instance);
}

#[test]
fn file_edit_rejects_parent_symlink_swap_after_context_read_and_recovers() {
    let env = TestEnv::new();
    let instance = "beta-edit-symlink-swap";
    let directory = env.workspace().join("document");
    let saved = env.workspace().join("saved-document");
    let outside = env.home().join("outside");
    fs::create_dir(&directory).unwrap();
    fs::create_dir(&outside).unwrap();
    // Identical bytes ensure revision checks alone cannot prevent the escaped write.
    fs::write(directory.join("file.txt"), "original\n").unwrap();
    fs::write(outside.join("file.txt"), "original\n").unwrap();
    env.workspace_mode_command()
        .current_dir(env.workspace())
        .args(["start", "--instance", instance])
        .assert()
        .success();
    let read = env.rpc(
        instance,
        "tool",
        &tool(
            &env,
            instance,
            "read",
            "file_read",
            json!({ "files": [{ "path": "./document/file.txt", "view": "content" }] }),
        ),
    );
    assert_eq!(read["type"], "reply", "{read}");
    assert_eq!(
        read["message"]["files"][0]["content"], "1:original",
        "{read}"
    );
    fs::rename(&directory, &saved).unwrap();
    symlink(&outside, &directory).unwrap();
    let input = json!({ "changes": "*** Begin Edit\n*** Patch File: ./document/file.txt\n@@\n-original\n+edited\n*** End Edit" });
    let rejected = env.rpc(
        instance,
        "tool",
        &tool(&env, instance, "swap", "file_edit", input.clone()),
    );
    assert_eq!(rejected["type"], "error", "{rejected}");
    assert!(
        matches!(
            rejected["error"]["code"].as_str(),
            Some("file.pathEscapesWorkspace" | "file.writeFailed")
        ),
        "symlink swap must be rejected without writing outside the workspace: {rejected}"
    );
    assert_eq!(
        fs::read_to_string(outside.join("file.txt")).unwrap(),
        "original\n"
    );
    assert_eq!(
        fs::read_to_string(saved.join("file.txt")).unwrap(),
        "original\n"
    );
    fs::remove_file(&directory).unwrap();
    fs::rename(&saved, &directory).unwrap();
    let recovered = env.rpc(
        instance,
        "tool",
        &tool(&env, instance, "restored", "file_edit", input),
    );
    assert_eq!(recovered["type"], "reply", "{recovered}");
    assert_eq!(
        recovered["message"]["operations"][0]["status"], "applied",
        "{recovered}"
    );
    assert_eq!(
        fs::read_to_string(directory.join("file.txt")).unwrap(),
        "edited\n"
    );
    assert_eq!(
        fs::read_to_string(outside.join("file.txt")).unwrap(),
        "original\n"
    );
}

fn terminal(env: &TestEnv, instance: &str, method: &str, message: Value) -> Value {
    env.rpc(
        instance,
        "terminal",
        &json!({
            "protocol": "rpc", "type": "request", "id": method, "method": method, "message": message
        }),
    )
}

fn replay_until(
    env: &TestEnv,
    instance: &str,
    session: &Value,
    from: u64,
    marker: &[u8],
) -> (u64, Vec<u8>) {
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut cursor = from;
    let mut bytes = Vec::new();
    loop {
        // Every RPC creates and closes a real transport: the PTY must survive each disconnect.
        let attached = terminal(
            env,
            instance,
            "terminal.attach",
            json!({
                "terminalId": session["terminalId"], "generation": session["generation"], "fromSeq": cursor
            }),
        );
        assert_eq!(attached["type"], "reply", "{attached}");
        assert_eq!(attached["message"]["session"]["state"], "running");
        for frame in attached["message"]["replay"].as_array().unwrap() {
            assert_eq!(frame["seq"].as_u64().unwrap(), cursor + 1);
            cursor += 1;
            bytes.extend(
                BASE64
                    .decode(frame["dataBase64"].as_str().unwrap())
                    .unwrap(),
            );
        }
        assert_eq!(attached["message"]["session"]["latestSeq"], cursor);
        if bytes.windows(marker.len()).any(|window| window == marker) {
            return (cursor, bytes);
        }
        assert!(
            Instant::now() < deadline,
            "PTY marker missing after {} bytes at seq {cursor}",
            bytes.len()
        );
        thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn terminal_high_output_resumes_after_transport_disconnect_without_duplicate_sequences() {
    let env = TestEnv::new();
    let instance = "beta-pty-resume";
    fs::write(
        env.workspace().join("output.sh"),
        concat!(
            "head -c 262144 /dev/zero | tr '\\000' x\n",
            "printf 'FIRST-DONE\\n'\n",
            "while test ! -f release; do sleep 0.02; done\n",
            "head -c 262144 /dev/zero | tr '\\000' y\n",
            "printf 'SECOND-DONE\\n'\n",
            "while test ! -f finish; do sleep 0.02; done\n"
        ),
    )
    .unwrap();
    start(&env, instance);
    let opened = terminal(
        &env,
        instance,
        "terminal.open",
        json!({
            "workspace": env.workspace(), "cols": 80, "rows": 24,
            "command": "stty -echo; sh ./output.sh"
        }),
    );
    assert_eq!(opened["type"], "reply", "{opened}");
    let session = &opened["message"];
    let (cursor, first) = replay_until(&env, instance, session, 0, b"FIRST-DONE\r\n");
    assert_eq!(first.iter().filter(|byte| **byte == b'x').count(), 262144);
    // No transport is connected while the second burst is produced.
    fs::write(env.workspace().join("release"), b"release").unwrap();
    let (latest, second) = replay_until(&env, instance, session, cursor, b"SECOND-DONE\r\n");
    let mut expected = vec![b'y'; 262144];
    expected.extend_from_slice(b"SECOND-DONE\r\n");
    assert_eq!(second.len(), expected.len());
    assert!(
        second == expected,
        "resumed PTY output was corrupted or duplicated"
    );
    assert!(latest > cursor);
    let empty = terminal(
        &env,
        instance,
        "terminal.attach",
        json!({
            "terminalId": session["terminalId"], "generation": session["generation"], "fromSeq": latest
        }),
    );
    assert_eq!(empty["type"], "reply", "{empty}");
    assert_eq!(empty["message"]["replay"], json!([]));
    let killed = terminal(
        &env,
        instance,
        "terminal.kill",
        json!({
            "terminalId": session["terminalId"], "generation": session["generation"],
            "version": session["version"], "clientSeq": 1
        }),
    );
    assert_eq!(killed["type"], "reply", "{killed}");
}

#[test]
fn bash_call_environment_overrides_and_unsets_are_applied_in_order() {
    let env = TestEnv::new();
    let instance = "beta-env-order";
    start(&env, instance);
    let response = env.rpc(
        instance,
        "tool",
        &tool(
            &env,
            instance,
            "env",
            "bash_run",
            json!({
                "command": "printf '%s|%s' \"$BETA_MATRIX_VALUE\" \"${BETA_MATRIX_REMOVE-unset}\"",
                "timeoutMs": 5000,
                "env": { "BETA_MATRIX_VALUE": "request-value", "BETA_MATRIX_REMOVE": null }
            }),
        ),
    );
    assert_eq!(response["type"], "reply", "{response}");
    assert_eq!(
        response["message"]["stdout"], "request-value|unset",
        "{response}"
    );
}

#[test]
fn bash_nonzero_exit_preserves_both_streams_and_exit_status() {
    let env = TestEnv::new();
    let instance = "beta-nonzero-streams";
    start(&env, instance);
    let response = env.rpc(
        instance,
        "tool",
        &tool(
            &env,
            instance,
            "nonzero",
            "bash_run",
            json!({
                "command": "printf out; printf err >&2; exit 37", "timeoutMs": 5000
            }),
        ),
    );
    assert_eq!(response["type"], "reply", "{response}");
    assert_eq!(response["message"]["exitCode"], 37, "{response}");
    assert_eq!(response["message"]["stdout"], "out", "{response}");
    assert_eq!(response["message"]["stderr"], "err", "{response}");
    assert_eq!(response["message"]["termination"], "exited", "{response}");
    assert_bash_recovers(&env, instance);
}

#[test]
fn bash_invalid_zero_timeout_is_rejected_before_process_launch() {
    let env = TestEnv::new();
    let instance = "beta-zero-timeout";
    start(&env, instance);
    let marker = env.workspace().join("must-not-run");
    let response = env.rpc(
        instance,
        "tool",
        &tool(
            &env,
            instance,
            "invalid",
            "bash_run",
            json!({
                "command": format!("touch {}", marker.display()), "timeoutMs": 0
            }),
        ),
    );
    assert_eq!(response["type"], "error", "{response}");
    assert_eq!(
        response["error"]["code"], "tool.invalidArguments",
        "{response}"
    );
    assert!(!marker.exists());
    assert_bash_recovers(&env, instance);
}

#[test]
fn bash_cancellation_is_scoped_to_both_context_and_request_id() {
    let env = TestEnv::new();
    let instance = "beta-cancel-identity";
    let command = process_tree_command(&env);
    start(&env, instance);
    let mut bridge = env
        .std_command()
        .args(["transport", "--instance", instance])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut writer = TransportEndpointWriter::new(bridge.stdin.take().unwrap(), instance).unwrap();
    let mut reader = TransportEndpointReader::new(bridge.stdout.take().unwrap());
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
            &tool_for_context(
                &env,
                "target-ctx",
                "same-id",
                "bash_run",
                json!({ "command": command, "timeoutMs": 15000 }),
            ),
        )
        .unwrap();
    let ready = env.workspace().join("descendants.pid");
    let deadline = Instant::now() + Duration::from_secs(5);
    while !ready.exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    let pids = tree_pids(&env);
    writer.send("tool", &json!({
        "protocol": "rpc", "type": "request", "id": "wrong-context", "method": "tool.call.cancel",
        "message": { "rpcRequestId": "same-id", "ctxId": "other-ctx" }
    })).unwrap();
    let wrong = loop {
        let packet = receive.recv_timeout(Duration::from_secs(3)).unwrap();
        if packet["id"] == "wrong-context" {
            break packet;
        }
    };
    assert_eq!(wrong["message"]["cancelled"], false, "{wrong}");
    assert!(
        pids.iter().all(|pid| process_running(*pid)),
        "wrong context cancelled the call"
    );
    writer.send("tool", &json!({
        "protocol": "rpc", "type": "request", "id": "right-context", "method": "tool.call.cancel",
        "message": { "rpcRequestId": "same-id", "ctxId": "target-ctx" }
    })).unwrap();
    let mut replies = vec![wrong];
    let deadline = Instant::now() + Duration::from_secs(5);
    while !replies.iter().any(|packet| packet["id"] == "right-context")
        || !replies.iter().any(|packet| packet["id"] == "same-id")
    {
        replies.push(
            receive
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap(),
        );
    }
    let cancel = replies
        .iter()
        .find(|packet| packet["id"] == "right-context")
        .unwrap();
    assert_eq!(cancel["message"]["cancelled"], true, "{cancel}");
    let tool_reply = replies
        .iter()
        .find(|packet| packet["id"] == "same-id")
        .unwrap();
    assert_eq!(
        tool_reply["error"]["code"], "tool.cancelled",
        "{tool_reply}"
    );
    assert_tree_stopped(&pids);
    drop(writer);
    assert!(bridge.wait().unwrap().success());
    reading.join().unwrap();
    assert_bash_recovers(&env, instance);
}

#[test]
fn file_edit_rejects_external_revision_change_and_accepts_a_fresh_read() {
    let env = TestEnv::new();
    let instance = "beta-file-revision";
    let path = env.workspace().join("revision.txt");
    fs::write(&path, "original\n").unwrap();
    start(&env, instance);
    let read = env.rpc(
        instance,
        "tool",
        &tool_for_context(
            &env,
            "revision-ctx",
            "read",
            "file_read",
            json!({ "files": [{ "path": "revision.txt", "view": "content" }] }),
        ),
    );
    assert_eq!(read["type"], "reply", "{read}");
    fs::write(&path, "external\n").unwrap();
    let stale_input = json!({ "changes": "*** Begin Edit\n*** Patch File: revision.txt\n@@\n-original\n+worker\n*** End Edit" });
    let stale = env.rpc(
        instance,
        "tool",
        &tool_for_context(&env, "revision-ctx", "stale", "file_edit", stale_input),
    );
    assert_eq!(stale["type"], "reply", "{stale}");
    assert_eq!(
        stale["message"]["operations"][0]["status"], "failed",
        "{stale}"
    );
    assert_eq!(
        stale["message"]["operations"][0]["error"]["code"], "file.revisionMismatch",
        "{stale}"
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), "external\n");
    let reread = env.rpc(
        instance,
        "tool",
        &tool_for_context(
            &env,
            "revision-ctx",
            "reread",
            "file_read",
            json!({ "files": [{ "path": "revision.txt", "view": "content" }] }),
        ),
    );
    assert_eq!(reread["type"], "reply", "{reread}");
    let fresh_input = json!({ "changes": "*** Begin Edit\n*** Patch File: revision.txt\n@@\n-external\n+worker\n*** End Edit" });
    let fresh = env.rpc(
        instance,
        "tool",
        &tool_for_context(&env, "revision-ctx", "fresh", "file_edit", fresh_input),
    );
    assert_eq!(fresh["type"], "reply", "{fresh}");
    assert_eq!(fs::read_to_string(&path).unwrap(), "worker\n");
}

#[test]
fn terminal_attach_rejects_stale_generation_and_future_cursor_is_empty() {
    let env = TestEnv::new();
    let instance = "beta-terminal-identity";
    start(&env, instance);
    let opened = terminal(
        &env,
        instance,
        "terminal.open",
        json!({
            "workspace": env.workspace(), "cols": 80, "rows": 24, "command": "stty -echo; printf 'ready\\n'; while :; do read x; done"
        }),
    );
    assert_eq!(opened["type"], "reply", "{opened}");
    let session = &opened["message"];
    let stale = terminal(
        &env,
        instance,
        "terminal.attach",
        json!({
            "terminalId": session["terminalId"], "generation": session["generation"].as_u64().unwrap() + 1, "fromSeq": 0
        }),
    );
    assert_eq!(stale["type"], "error", "{stale}");
    assert_eq!(stale["error"]["code"], "instance.conflict", "{stale}");
    let future = terminal(
        &env,
        instance,
        "terminal.attach",
        json!({
            "terminalId": session["terminalId"], "generation": session["generation"], "fromSeq": u64::MAX - 1
        }),
    );
    assert_eq!(future["type"], "reply", "{future}");
    assert_eq!(future["message"]["replay"], json!([]), "{future}");
    // A maximum future cursor should never crash the Worker.
    let maximum = terminal(
        &env,
        instance,
        "terminal.attach",
        json!({
            "terminalId": session["terminalId"], "generation": session["generation"], "fromSeq": u64::MAX
        }),
    );
    assert_eq!(maximum["type"], "reply", "{maximum}");
    assert_eq!(maximum["message"]["replay"], json!([]), "{maximum}");
    let killed = terminal(
        &env,
        instance,
        "terminal.kill",
        json!({
            "terminalId": session["terminalId"], "generation": session["generation"],
            "version": session["version"], "clientSeq": 1
        }),
    );
    assert_eq!(killed["type"], "reply", "{killed}");
}

#[test]
fn terminal_commands_reject_stale_version_without_advancing_sequence() {
    let env = TestEnv::new();
    let instance = "beta-terminal-version";
    start(&env, instance);
    let opened = terminal(
        &env,
        instance,
        "terminal.open",
        json!({
            "workspace": env.workspace(), "cols": 80, "rows": 24, "command": "stty -echo; while :; do read x; done"
        }),
    );
    assert_eq!(opened["type"], "reply", "{opened}");
    let session = &opened["message"];
    let input = terminal(
        &env,
        instance,
        "terminal.write",
        json!({
            "terminalId": session["terminalId"], "generation": session["generation"],
            "version": session["version"].as_u64().unwrap() + 1, "clientSeq": 1,
            "data": BASE64.encode(b"marker\n")
        }),
    );
    assert_eq!(input["type"], "error", "{input}");
    assert_eq!(input["error"]["code"], "instance.conflict", "{input}");
    let valid = terminal(
        &env,
        instance,
        "terminal.write",
        json!({
            "terminalId": session["terminalId"], "generation": session["generation"],
            "version": session["version"], "clientSeq": 1, "data": BASE64.encode(b"printf ok\r")
        }),
    );
    assert_eq!(valid["type"], "reply", "{valid}");
    let killed = terminal(
        &env,
        instance,
        "terminal.kill",
        json!({
            "terminalId": session["terminalId"], "generation": session["generation"],
            "version": session["version"], "clientSeq": 2
        }),
    );
    assert_eq!(killed["type"], "reply", "{killed}");
}

#[test]
fn terminal_workspace_rejects_symlinked_cwd_outside_workspace() {
    let env = TestEnv::new();
    let instance = "beta-terminal-cwd-boundary";
    let outside = env.home().join("outside-cwd");
    fs::create_dir(&outside).unwrap();
    symlink(&outside, env.workspace().join("escape")).unwrap();
    env.workspace_mode_command()
        .current_dir(env.workspace())
        .args(["start", "--instance", instance])
        .assert()
        .success();
    let opened = terminal(
        &env,
        instance,
        "terminal.open",
        json!({
            "workspace": env.workspace(), "cwd": "escape", "cols": 80, "rows": 24
        }),
    );
    assert_eq!(opened["type"], "error", "{opened}");
    assert_eq!(
        opened["error"]["code"], "file.pathEscapesWorkspace",
        "{opened}"
    );
}
