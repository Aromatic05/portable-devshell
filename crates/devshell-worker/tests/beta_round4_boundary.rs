#![cfg(target_os = "linux")]

mod support;

use serde_json::{Value, json};
use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};
use support::TestEnv;

fn start(env: &TestEnv, instance: &str, workspace_mode: bool) {
    if workspace_mode {
        env.workspace_mode_command()
            .current_dir(env.workspace())
            .args(["start", "--instance", instance])
            .assert()
            .success();
    } else {
        env.command()
            .current_dir(env.workspace())
            .args(["start", "--instance", instance])
            .assert()
            .success();
    }
}

fn call(env: &TestEnv, instance: &str, id: &str, ctx: &str, method: &str, input: Value) -> Value {
    env.rpc(instance, "tool", &json!({
        "protocol":"rpc", "type":"request", "id":id, "method":method,
        "message":{"input":input,"context":{"workspace":env.workspace(),"ctxId":ctx,"source":"mcp"}}
    }))
}

#[test]
fn workspace_policy_rejects_absolute_file_read_even_when_target_exists() {
    let env = TestEnv::new();
    let instance = "r4-absolute-read";
    let outside = env.home().join("private.txt");
    fs::write(&outside, "secret\n").unwrap();
    start(&env, instance, true);
    let response = call(
        &env,
        instance,
        "read",
        "ctx",
        "file_read",
        json!({"files":[{"path":outside}]}),
    );
    assert_eq!(response["type"], "error", "{response}");
    assert_eq!(response["error"]["code"], "security.denied", "{response}");
}

#[test]
fn workspace_policy_rejects_absolute_file_edit_without_touching_target() {
    let env = TestEnv::new();
    let instance = "r4-absolute-write";
    let outside = env.home().join("private.txt");
    fs::write(&outside, "protected\n").unwrap();
    start(&env, instance, true);
    let response = call(
        &env,
        instance,
        "write",
        "ctx",
        "file_edit",
        json!({
            "changes": format!("*** Begin Edit\n*** Rewrite File: {}\nstolen\n*** End Edit", outside.display())
        }),
    );
    assert_eq!(response["type"], "error", "{response}");
    assert_eq!(response["error"]["code"], "security.denied", "{response}");
    assert_eq!(fs::read_to_string(outside).unwrap(), "protected\n");
}

#[test]
fn workspace_policy_rejects_read_through_symlinked_workspace_entry() {
    let env = TestEnv::new();
    let instance = "r4-symlink-read";
    let outside = env.home().join("outside.txt");
    fs::write(&outside, "outside\n").unwrap();
    symlink(&outside, env.workspace().join("linked.txt")).unwrap();
    start(&env, instance, true);
    let response = call(
        &env,
        instance,
        "read",
        "ctx",
        "file_read",
        json!({"files":[{"path":"./linked.txt","view":"content"}]}),
    );
    assert_eq!(response["type"], "error", "{response}");
    assert_eq!(
        response["error"]["code"], "file.pathEscapesWorkspace",
        "{response}"
    );
    assert_eq!(fs::read_to_string(outside).unwrap(), "outside\n");
}

#[test]
fn workspace_mode_bash_process_executes_with_workspace_as_cwd() {
    let env = TestEnv::new();
    let instance = "r4-process-cwd";
    start(&env, instance, true);
    let response = call(
        &env,
        instance,
        "pwd",
        "ctx",
        "bash_run",
        json!({"command":"pwd","timeoutMs":5000}),
    );
    assert_eq!(response["type"], "reply", "{response}");
    assert_eq!(response["message"]["exitCode"], 0, "{response}");
    assert_eq!(
        response["message"]["stdout"].as_str().unwrap().trim(),
        env.workspace().to_str().unwrap()
    );
}

#[test]
fn file_edit_keeps_existing_mode_and_replaces_bytes_only_after_success() {
    let env = TestEnv::new();
    let instance = "r4-edit-mode";
    let path = env.workspace().join("mode.txt");
    fs::write(&path, "before\n").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
    start(&env, instance, false);
    let read = call(
        &env,
        instance,
        "read",
        "ctx",
        "file_read",
        json!({"files":[{"path":"./mode.txt","view":"content"}]}),
    );
    assert_eq!(read["type"], "reply", "{read}");
    let edit = call(
        &env,
        instance,
        "edit",
        "ctx",
        "file_edit",
        json!({"changes":"*** Begin Edit\n*** Rewrite File: ./mode.txt\nafter\n*** End Edit"}),
    );
    assert_eq!(edit["type"], "reply", "{edit}");
    assert_eq!(
        edit["message"]["operations"][0]["status"], "applied",
        "{edit}"
    );
    assert_eq!(fs::read(&path).unwrap(), b"after\n");
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o640
    );
    assert_eq!(
        fs::read_dir(env.workspace())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().contains("mode.txt"))
            .count(),
        1
    );
}

#[test]
fn same_context_concurrent_bash_calls_keep_request_output_isolated() {
    let env = TestEnv::new();
    let instance = "r4-concurrent-calls";
    start(&env, instance, false);
    let (ra, rb) = std::thread::scope(|scope| {
        let a = scope.spawn(|| {
            call(
                &env,
                instance,
                "a",
                "shared",
                "bash_run",
                json!({"command":"printf AA","timeoutMs":5000}),
            )
        });
        let b = scope.spawn(|| {
            call(
                &env,
                instance,
                "b",
                "shared",
                "bash_run",
                json!({"command":"printf BB","timeoutMs":5000}),
            )
        });
        (a.join().unwrap(), b.join().unwrap())
    });
    assert_eq!(ra["id"], "a", "{ra}");
    assert_eq!(ra["message"]["stdout"], "AA", "{ra}");
    assert_eq!(rb["id"], "b", "{rb}");
    assert_eq!(rb["message"]["stdout"], "BB", "{rb}");
}
