#![cfg(unix)]
mod support;
use serde_json::{Value, json};
use std::fs;
use support::TestEnv;

fn rpc(env: &TestEnv, instance: &str, id: &str, ctx: &str, method: &str, input: Value) -> Value {
    env.rpc(instance, "tool", &json!({
        "protocol": "rpc", "type": "request", "id": id, "method": method,
        "message": { "input": input, "context": {"ctxId": ctx, "source": "mcp", "workspace": env.workspace()} }
    }))
}

fn check_no_false_coverage(command: &str, text: &str, original: &str) {
    let env = TestEnv::new();
    let instance = "command-read-adversarial";
    let path = env.workspace().join("sample.txt");
    fs::write(&path, text).unwrap();
    env.command()
        .current_dir(env.workspace())
        .args(["start", "--instance", instance])
        .assert()
        .success();
    let result = rpc(
        &env,
        instance,
        "1",
        "adversarial",
        "bash_run",
        json!({ "command": command, "timeoutMs": 5000 }),
    );
    assert_eq!(result["type"], "reply", "{result}");
    let edit = rpc(
        &env,
        instance,
        "2",
        "adversarial",
        "file_edit",
        json!({
            "changes": format!("*** Begin Edit\n*** Patch File: ./sample.txt\n@@\n-{original}\n+CHANGED\n*** End Edit")
        }),
    );
    let error = if edit["type"] == "error" {
        &edit["error"]["code"]
    } else {
        &edit["message"]["operations"][0]["error"]["code"]
    };
    assert!(
        matches!(
            error.as_str(),
            Some("file.snapshotRequired" | "file.unreadRange")
        ),
        "false coverage: command={command:?}, stdout={:?}, edit={edit}",
        result["message"]["stdout"]
    );
    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn numbered_grep_pipeline_must_not_credit_a_coincidentally_matching_source_line() {
    // grep -n adds a synthetic prefix. That text is also another source line.
    check_no_false_coverage(
        "cat sample.txt | grep -n '^target$'",
        "2:target\ntarget\n",
        "2:target",
    );
}

#[test]
fn uniq_count_pipeline_must_not_credit_a_coincidentally_matching_source_line() {
    // uniq -c adds a synthetic count prefix that looks like a different source line.
    check_no_false_coverage(
        "cat sample.txt | uniq -c",
        "      1 target\ntarget\n",
        "      1 target",
    );
}
