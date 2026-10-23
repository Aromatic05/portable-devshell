#![cfg(unix)]
mod support;

use serde_json::{Value, json};
use std::fs;
use support::TestEnv;

fn call(env: &TestEnv, id: &str, method: &str, params: Value) -> Value {
    env.rpc(
        "read-window-4k",
        "tool",
        &json!({
            "protocol": "rpc",
            "type": "request",
            "id": id,
            "method": method,
            "message": {
                "input": params,
                "context": {"ctxId": "4k-window", "source": "mcp", "workspace": env.workspace()}
            }
        }),
    )
}

#[test]
fn visible_ten_kilobyte_shell_read_should_establish_coverage() {
    let env = TestEnv::new();
    let file = env.workspace().join("window.txt");
    let rows = (0..160)
        .map(|index| format!("line_{index:04}_{}", "code".repeat(14)))
        .collect::<Vec<_>>();
    fs::write(&file, rows.join("\n") + "\n").unwrap();
    env.command()
        .current_dir(env.workspace())
        .args(["start", "--instance", "read-window-4k"])
        .assert()
        .success();

    let read = call(
        &env,
        "1",
        "bash_run",
        json!({
            "command": "cat window.txt", "timeoutMs": 5000
        }),
    );
    assert_eq!(read["type"], "reply", "{read}");
    let output = read["message"]["stdout"].as_str().unwrap();
    assert!(
        output.len() > 8 * 1024 && output.len() < 11 * 1024,
        "source must exercise 8 KiB observer vs ~12 KiB protocol budget, size={}",
        output.len()
    );
    eprintln!(
        "WINDOW_BUDGET payload_stdout={} json_message_bytes={} stderr_bytes={}",
        output.len(),
        serde_json::to_vec(&read["message"]).unwrap().len(),
        read["message"]["stderr"].as_str().unwrap().len()
    );
    assert_eq!(read["message"]["stdoutTruncated"], false, "{read}");
    let edit = call(
        &env,
        "2",
        "file_edit",
        json!({
            "changes": format!("*** Begin Edit\n*** Patch File: ./window.txt\n@@\n-{}\n+CHANGED\n*** End Edit", rows[80])
        }),
    );
    assert_eq!(
        edit["message"]["operations"][0]["status"], "applied",
        "{edit}"
    );
    env.json_command(&["stop", "--instance", "read-window-4k"]);
}

#[test]
fn visible_ten_kilobyte_grep_result_should_credit_numbered_lines() {
    let env = TestEnv::new();
    let file = env.workspace().join("numbered.txt");
    let rows = (0..150)
        .map(|index| format!("key_{index:04}_{}", "data".repeat(15)))
        .collect::<Vec<_>>();
    fs::write(&file, rows.join("\n") + "\n").unwrap();
    env.command()
        .current_dir(env.workspace())
        .args(["start", "--instance", "read-window-4k"])
        .assert()
        .success();

    let read = call(
        &env,
        "1",
        "bash_run",
        json!({
            "command": "rg -n 'key_' numbered.txt", "timeoutMs": 5000
        }),
    );
    assert_eq!(read["type"], "reply", "{read}");
    let output = read["message"]["stdout"].as_str().unwrap();
    assert!(
        output.len() > 8 * 1024 && output.len() < 11 * 1024,
        "size={}",
        output.len()
    );
    eprintln!(
        "WINDOW_BUDGET payload_stdout={} json_message_bytes={} stderr_bytes={}",
        output.len(),
        serde_json::to_vec(&read["message"]).unwrap().len(),
        read["message"]["stderr"].as_str().unwrap().len()
    );
    assert_eq!(read["message"]["stdoutTruncated"], false, "{read}");
    let edit = call(
        &env,
        "2",
        "file_edit",
        json!({
            "changes": format!("*** Begin Edit\n*** Patch File: ./numbered.txt\n@@\n-{}\n+CHANGED\n*** End Edit", rows[75])
        }),
    );
    assert_eq!(
        edit["message"]["operations"][0]["status"], "applied",
        "{edit}"
    );
    env.json_command(&["stop", "--instance", "read-window-4k"]);
}

#[test]
fn sequential_four_k_window_reads_merge_without_crediting_unseen_lines() {
    let env = TestEnv::new();
    let file = env.workspace().join("paged.txt");
    let rows = (0..320)
        .map(|index| format!("page_{index:04}_{}", "part".repeat(14)))
        .collect::<Vec<_>>();
    fs::write(&file, rows.join("\n") + "\n").unwrap();
    env.command()
        .current_dir(env.workspace())
        .args(["start", "--instance", "read-window-4k"])
        .assert()
        .success();

    let first = call(
        &env,
        "1",
        "bash_run",
        json!({
            "command": "sed -n '1,150p' paged.txt", "timeoutMs": 5000
        }),
    );
    assert_eq!(first["type"], "reply", "{first}");
    assert!(first["message"]["stdout"].as_str().unwrap().len() > 8 * 1024);
    let unseen = call(
        &env,
        "2",
        "file_edit",
        json!({
            "changes": format!("*** Begin Edit\n*** Patch File: ./paged.txt\n@@\n-{}\n+WRONG\n*** End Edit", rows[220])
        }),
    );
    assert_eq!(
        unseen["message"]["operations"][0]["error"]["code"], "file.unreadRange",
        "{unseen}"
    );

    let second = call(
        &env,
        "3",
        "bash_run",
        json!({
            "command": "sed -n '151,300p' paged.txt", "timeoutMs": 5000
        }),
    );
    assert_eq!(second["type"], "reply", "{second}");
    assert!(second["message"]["stdout"].as_str().unwrap().len() > 8 * 1024);
    let still_unseen = call(
        &env,
        "4",
        "file_edit",
        json!({
            "changes": format!("*** Begin Edit\n*** Patch File: ./paged.txt\n@@\n-{}\n+WRONG\n*** End Edit", rows[310])
        }),
    );
    assert_eq!(
        still_unseen["message"]["operations"][0]["error"]["code"], "file.unreadRange",
        "{still_unseen}"
    );

    let edit = call(
        &env,
        "5",
        "file_edit",
        json!({
            "changes": format!("*** Begin Edit\n*** Patch File: ./paged.txt\n@@\n-{}\n+CHANGED\n*** End Edit", rows[220])
        }),
    );
    assert_eq!(
        edit["message"]["operations"][0]["status"], "applied",
        "{edit}"
    );
    env.json_command(&["stop", "--instance", "read-window-4k"]);
}

#[test]
fn over_four_k_output_budget_does_not_credit_full_unseen_source() {
    let env = TestEnv::new();
    let file = env.workspace().join("oversized.txt");
    let rows = (0..205)
        .map(|index| format!("line_{index:04}_{}", "code".repeat(14)))
        .collect::<Vec<_>>();
    fs::write(&file, rows.join("\n") + "\n").unwrap();
    env.command()
        .current_dir(env.workspace())
        .args(["start", "--instance", "read-window-4k"])
        .assert()
        .success();
    let read = call(
        &env,
        "1",
        "bash_run",
        json!({
            "command": "cat oversized.txt", "timeoutMs": 5000
        }),
    );
    assert_eq!(read["type"], "reply", "{read}");
    assert!(read["message"]["stdout"].as_str().unwrap().len() > 12_000);
    let edit = call(
        &env,
        "2",
        "file_edit",
        json!({
            "changes": format!("*** Begin Edit\n*** Patch File: ./oversized.txt\n@@\n-{}\n+WRONG\n*** End Edit", rows[100])
        }),
    );
    assert_eq!(edit["error"]["code"], "file.snapshotRequired", "{edit}");
    env.json_command(&["stop", "--instance", "read-window-4k"]);
}
