#![cfg(unix)]
mod support;

use serde_json::{Value, json};
use std::fs;
use support::TestEnv;

fn call(env: &TestEnv, instance: &str, id: &str, ctx: &str, method: &str, params: Value) -> Value {
    env.rpc(
        instance,
        "tool",
        &json!({
            "protocol": "rpc", "type": "request", "id": id, "method": method,
            "message": {
                "input": params,
                "context": {"ctxId": ctx, "source": "mcp", "workspace": env.workspace()}
            }
        }),
    )
}

fn start(env: &TestEnv, instance: &str) {
    env.command()
        .current_dir(env.workspace())
        .args(["start", "--instance", instance])
        .assert()
        .success();
}

fn patch(
    env: &TestEnv,
    instance: &str,
    id: &str,
    ctx: &str,
    path: &str,
    old: &str,
    new: &str,
) -> Value {
    call(
        env,
        instance,
        id,
        ctx,
        "file_edit",
        json!({
            "changes": format!("*** Begin Edit\n*** Patch File: ./{path}\n@@\n-{old}\n+{new}\n*** End Edit")
        }),
    )
}

#[test]
fn twenty_concurrent_contexts_remain_isolated_and_can_patch_their_own_files() {
    let env = TestEnv::new();
    let instance = "read-concurrency-worker";
    fs::create_dir_all(env.workspace().join("concurrent")).unwrap();
    for index in 0..20 {
        fs::write(
            env.workspace().join(format!("concurrent/file_{index}.txt")),
            format!("header_{index}\ntarget_{index}\nfooter_{index}\n"),
        )
        .unwrap();
    }
    start(&env, instance);
    let responses = std::thread::scope(|scope| {
        let mut handles = Vec::new();
        for index in 0..20 {
            let env = &env;
            handles.push(scope.spawn(move || {
                let cmd = format!("rg -n 'target_{index}' concurrent/file_{index}.txt");
                call(
                    env,
                    instance,
                    &format!("read-{index}"),
                    &format!("ctx-{index}"),
                    "bash_run",
                    json!({ "command": cmd, "timeoutMs": 5000 }),
                )
            }));
        }
        handles
            .into_iter()
            .map(|handle| handle.join().expect("thread"))
            .collect::<Vec<_>>()
    });
    let mut rejected = Vec::new();
    for (index, result) in responses.iter().enumerate() {
        if result["type"] == "error" {
            assert_eq!(
                result["error"]["code"], "worker.toolConcurrencyLimit",
                "concurrent-{index}: {result}"
            );
            assert_eq!(result["error"]["retryable"], true, "{result}");
            rejected.push(index);
            continue;
        }
        assert_eq!(result["type"], "reply", "concurrent-{index}: {result}");
        assert!(
            result["message"]["stdout"]
                .as_str()
                .is_some_and(|text| text.contains(&format!("2:target_{index}")))
        );
    }
    // The Worker intentionally allows only six standard calls at once. Retry
    // rejected observations in groups of five, preserving their Context IDs.
    for chunk in rejected.chunks(5) {
        let responses = std::thread::scope(|scope| {
            let handles = chunk
                .iter()
                .map(|&index| {
                    let env = &env;
                    scope.spawn(move || {
                        let cmd = format!("rg -n 'target_{index}' concurrent/file_{index}.txt");
                        call(
                            env,
                            instance,
                            &format!("retry-{index}"),
                            &format!("ctx-{index}"),
                            "bash_run",
                            json!({"command":cmd, "timeoutMs":5000}),
                        )
                    })
                })
                .collect::<Vec<_>>();
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .collect::<Vec<_>>()
        });
        for response in responses {
            assert_eq!(response["type"], "reply", "{response}");
        }
    }
    eprintln!(
        "CONCURRENCY total=20 initial_retryable_rejections={}",
        rejected.len()
    );
    let wrong = patch(
        &env,
        instance,
        "wrong",
        "ctx-1",
        "concurrent/file_0.txt",
        "target_0",
        "bad",
    );
    assert_eq!(wrong["error"]["code"], "file.snapshotRequired", "{wrong}");
    for index in 0..20 {
        let edited = patch(
            &env,
            instance,
            &format!("edit-{index}"),
            &format!("ctx-{index}"),
            &format!("concurrent/file_{index}.txt"),
            &format!("target_{index}"),
            &format!("updated_{index}"),
        );
        assert_eq!(
            edited["message"]["operations"][0]["status"], "applied",
            "{edited}"
        );
    }
    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn shell_read_then_conflicting_external_change_never_overwrites_new_revision() {
    let env = TestEnv::new();
    let instance = "read-revision-worker";
    let path = env.workspace().join("source.txt");
    fs::write(&path, "header\noriginal\n").unwrap();
    start(&env, instance);
    let read = call(
        &env,
        instance,
        "1",
        "ctx-a",
        "bash_run",
        json!({"command":"cat source.txt", "timeoutMs":5000}),
    );
    assert_eq!(read["message"]["stdout"], "header\noriginal\n");
    fs::write(&path, "header\nexternal\n").unwrap();
    let stale = patch(
        &env,
        instance,
        "2",
        "ctx-a",
        "source.txt",
        "original",
        "OVERRIDE",
    );
    assert_ne!(
        stale["message"]["operations"][0]["status"], "applied",
        "{stale}"
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), "header\nexternal\n");

    let refreshed = call(
        &env,
        instance,
        "3",
        "ctx-a",
        "bash_run",
        json!({"command":"cat source.txt", "timeoutMs":5000}),
    );
    assert_eq!(refreshed["message"]["stdout"], "header\nexternal\n");
    let edited = patch(
        &env,
        instance,
        "4",
        "ctx-a",
        "source.txt",
        "external",
        "fixed",
    );
    assert_eq!(
        edited["message"]["operations"][0]["status"], "applied",
        "{edited}"
    );
    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn crlf_bom_unicode_path_can_be_read_via_shell() {
    let env = TestEnv::new();
    let instance = "read-unicode-worker";
    let path = env.workspace().join("源 文件.txt");
    fs::write(&path, b"\xef\xbb\xbfalpha\r\ntarget\r\nomega\r\n").unwrap();
    start(&env, instance);
    let read = call(
        &env,
        instance,
        "1",
        "ctx-a",
        "bash_run",
        json!({"command":"sed -n '2p' '源 文件.txt'", "timeoutMs":5000}),
    );
    assert_eq!(read["type"], "reply", "{read}");
    let edited = patch(
        &env,
        instance,
        "2",
        "ctx-a",
        "源 文件.txt",
        "target",
        "patched",
    );
    assert_eq!(
        edited["message"]["operations"][0]["status"], "applied",
        "{edited}"
    );
    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn binary_and_oversize_sources_do_not_get_credit() {
    let env = TestEnv::new();
    let instance = "read-binary-limit-worker";
    fs::write(env.workspace().join("binary.txt"), b"target\0\n").unwrap();
    fs::write(
        env.workspace().join("oversize.txt"),
        format!("target\n{}", "longline-of-source\n".repeat(240_000)),
    )
    .unwrap();
    start(&env, instance);
    for (i, file) in ["binary.txt", "oversize.txt"].iter().enumerate() {
        let read = call(
            &env,
            instance,
            &format!("r-{i}"),
            &format!("ctx-{i}"),
            "bash_run",
            json!({"command": format!("head -n 1 {file}"), "timeoutMs":5000}),
        );
        assert_eq!(read["type"], "reply", "{read}");
        let edited = patch(
            &env,
            instance,
            &format!("e-{i}"),
            &format!("ctx-{i}"),
            file,
            "target",
            "patched",
        );
        assert_eq!(edited["error"]["code"], "file.snapshotRequired", "{edited}");
    }
    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn tmux_task_read_is_credited_to_context_that_consumes_the_output() {
    let env = TestEnv::new();
    let instance = "read-cross-context-tmux";
    fs::write(env.workspace().join("source.txt"), "head\noutcome\n").unwrap();
    start(&env, instance);
    let started = call(
        &env,
        instance,
        "1",
        "ctx-a",
        "tmux_run",
        json!({"command":"cat source.txt", "wait":"nonblock", "consumeOutput":false}),
    );
    assert_eq!(started["type"], "reply", "{started}");
    let task = started["message"]["task"]["id"].as_str().unwrap();
    let read = call(
        &env,
        instance,
        "2",
        "ctx-b",
        "tmux_read",
        json!({"task":task, "timeMs":10000, "line":120}),
    );
    assert_eq!(read["type"], "reply", "{read}");
    assert!(
        read["message"]["output"]
            .as_array()
            .is_some_and(|lines| lines.iter().any(|line| line.as_str() == Some("outcome"))),
        "{read}"
    );
    let wrong = patch(
        &env,
        instance,
        "3",
        "ctx-a",
        "source.txt",
        "outcome",
        "wrong",
    );
    assert_eq!(wrong["error"]["code"], "file.snapshotRequired", "{wrong}");
    let right = patch(
        &env,
        instance,
        "4",
        "ctx-b",
        "source.txt",
        "outcome",
        "correct",
    );
    assert_eq!(
        right["message"]["operations"][0]["status"], "applied",
        "{right}"
    );
    env.json_command(&["stop", "--instance", instance]);
}
