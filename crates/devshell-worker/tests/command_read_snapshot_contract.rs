#![cfg(unix)]

mod support;

use serde_json::{Value, json};
use std::fs;
use support::TestEnv;

fn start(env: &TestEnv, instance: &str) {
    env.command()
        .current_dir(env.workspace())
        .args(["start", "--instance", instance])
        .assert()
        .success();
}

fn call(env: &TestEnv, instance: &str, id: &str, ctx: &str, method: &str, params: Value) -> Value {
    env.rpc(
        instance,
        "tool",
        &json!({
            "protocol": "rpc",
            "type": "request",
            "id": id,
            "method": method,
            "message": {
                "input": params,
                "context": {
                    "ctxId": ctx,
                    "source": "mcp",
                    "workspace": env.workspace()
                }
            }
        }),
    )
}

fn patch(env: &TestEnv, instance: &str, id: &str, ctx: &str, old: &str, new: &str) -> Value {
    call(
        env,
        instance,
        id,
        ctx,
        "file_edit",
        json!({
            "changes": format!("*** Begin Edit\n*** Patch File: ./sample.txt\n@@\n-{old}\n+{new}\n*** End Edit")
        }),
    )
}

#[test]
fn bash_pipeline_credits_only_observed_source_lines_in_its_context() {
    let env = TestEnv::new();
    let instance = "bash-command-read-coverage";
    fs::write(
        env.workspace().join("sample.txt"),
        "alpha\nfn one\nbeta\nfn two\nomega\n",
    )
    .unwrap();
    start(&env, instance);

    let bash = call(
        &env,
        instance,
        "1",
        "ctx-a",
        "bash_run",
        json!({
            "command": "cat sample.txt | grep 'fn ' | head -n 1",
            "timeoutMs": 5000
        }),
    );
    assert_eq!(bash["type"], "reply", "{bash}");
    assert_eq!(bash["message"]["stdout"], "fn one\n", "{bash}");

    let different_context = patch(&env, instance, "2", "ctx-b", "fn one", "other");
    assert_eq!(
        different_context["error"]["code"], "file.snapshotRequired",
        "{different_context}"
    );

    let unseen = patch(&env, instance, "3", "ctx-a", "fn two", "unseen");
    assert_eq!(
        unseen["message"]["operations"][0]["error"]["code"], "file.unreadRange",
        "{unseen}"
    );

    let edited = patch(&env, instance, "4", "ctx-a", "fn one", "fn changed");
    assert_eq!(
        edited["message"]["operations"][0]["status"], "applied",
        "{edited}"
    );
    assert_eq!(
        fs::read_to_string(env.workspace().join("sample.txt")).unwrap(),
        "alpha\nfn changed\nbeta\nfn two\nomega\n"
    );
    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn bash_sed_and_full_cat_produce_snapshots_without_extra_file_read() {
    let env = TestEnv::new();
    let instance = "bash-command-read-sed";
    fs::write(
        env.workspace().join("sample.txt"),
        "first\nsecond\nthird\nfourth\n",
    )
    .unwrap();
    start(&env, instance);

    let sed = call(
        &env,
        instance,
        "1",
        "ctx-a",
        "bash_run",
        json!({
            "command": "sed -n '2,3p' sample.txt",
            "timeoutMs": 5000
        }),
    );
    assert_eq!(sed["message"]["stdout"], "second\nthird\n", "{sed}");
    let edited = patch(&env, instance, "2", "ctx-a", "third", "THIRD");
    assert_eq!(
        edited["message"]["operations"][0]["status"], "applied",
        "{edited}"
    );

    let cat = call(
        &env,
        instance,
        "3",
        "ctx-b",
        "bash_run",
        json!({
            "command": "cat sample.txt",
            "timeoutMs": 5000
        }),
    );
    assert_eq!(cat["type"], "reply", "{cat}");
    let edited = patch(&env, instance, "4", "ctx-b", "first", "FIRST");
    assert_eq!(
        edited["message"]["operations"][0]["status"], "applied",
        "{edited}"
    );
    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn bash_rejects_unknown_commands_and_redirection_as_read_provenance() {
    let env = TestEnv::new();
    let instance = "bash-command-read-no-false-positive";
    fs::write(env.workspace().join("sample.txt"), "secret\n").unwrap();
    start(&env, instance);
    let echo = call(
        &env,
        instance,
        "1",
        "ctx-a",
        "bash_run",
        json!({
            "command": "printf 'secret\\n'",
            "timeoutMs": 5000
        }),
    );
    assert_eq!(echo["message"]["stdout"], "secret\n");
    let denied = patch(&env, instance, "2", "ctx-a", "secret", "changed");
    assert_eq!(denied["error"]["code"], "file.snapshotRequired", "{denied}");
    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn ripgrep_directory_pipeline_maps_filename_and_line_number() {
    let env = TestEnv::new();
    let instance = "bash-command-read-rg-directory";
    fs::create_dir_all(env.workspace().join("src")).unwrap();
    fs::write(
        env.workspace().join("src").join("main.rs"),
        "first\nTODO fix\nthird\n",
    )
    .unwrap();
    start(&env, instance);
    let bash = call(
        &env,
        instance,
        "1",
        "ctx-a",
        "bash_run",
        json!({
            "command": "rg -n 'TODO' src | head -n 1",
            "timeoutMs": 5000
        }),
    );
    assert_eq!(bash["type"], "reply", "{bash}");
    assert!(
        bash["message"]["stdout"]
            .as_str()
            .is_some_and(|text| text.contains("src/main.rs:2:TODO fix")),
        "{bash}"
    );
    let edited = call(
        &env,
        instance,
        "2",
        "ctx-a",
        "file_edit",
        json!({
            "changes": "*** Begin Edit\n*** Patch File: ./src/main.rs\n@@\n-TODO fix\n+TODO solved\n*** End Edit"
        }),
    );
    assert_eq!(
        edited["message"]["operations"][0]["status"], "applied",
        "{edited}"
    );
    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn relative_command_cwd_resolves_to_workspace_file_identity() {
    let env = TestEnv::new();
    let instance = "bash-command-read-cwd";
    fs::create_dir_all(env.workspace().join("subdir")).unwrap();
    fs::write(
        env.workspace().join("subdir").join("source.txt"),
        "before\nafter\n",
    )
    .unwrap();
    start(&env, instance);
    let bash = call(
        &env,
        instance,
        "1",
        "ctx-a",
        "bash_run",
        json!({
            "command": "tail -n 1 source.txt",
            "cwd": "subdir",
            "timeoutMs": 5000
        }),
    );
    assert_eq!(bash["message"]["stdout"], "after\n", "{bash}");
    let edited = call(
        &env,
        instance,
        "2",
        "ctx-a",
        "file_edit",
        json!({
            "changes": "*** Begin Edit\n*** Patch File: ./subdir/source.txt\n@@\n-after\n+AFTER\n*** End Edit"
        }),
    );
    assert_eq!(
        edited["message"]["operations"][0]["status"], "applied",
        "{edited}"
    );
    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn large_command_output_does_not_mark_unseen_text_as_read() {
    let env = TestEnv::new();
    let instance = "bash-command-read-output-budget";
    fs::write(
        env.workspace().join("sample.txt"),
        format!("secret\n{}", "filler\n".repeat(1800)),
    )
    .unwrap();
    start(&env, instance);
    let bash = call(
        &env,
        instance,
        "1",
        "ctx-a",
        "bash_run",
        json!({
            "command": "cat sample.txt",
            "timeoutMs": 5000
        }),
    );
    assert_eq!(bash["type"], "reply", "{bash}");
    let denied = patch(&env, instance, "2", "ctx-a", "secret", "changed");
    assert_eq!(denied["error"]["code"], "file.snapshotRequired", "{denied}");
    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn tmux_read_uses_the_original_task_command_for_source_attribution() {
    let env = TestEnv::new();
    let instance = "tmux-command-read-coverage";
    fs::write(
        env.workspace().join("sample.txt"),
        "tmux first\ntmux second\n",
    )
    .unwrap();
    start(&env, instance);
    let started = call(
        &env,
        instance,
        "1",
        "ctx-a",
        "tmux_run",
        json!({
            "command": "cat sample.txt",
            "wait": "nonblock",
            "consumeOutput": false
        }),
    );
    assert_eq!(started["type"], "reply", "{started}");
    let task = started["message"]["task"]["id"].as_str().expect("task ID");
    let read = call(
        &env,
        instance,
        "2",
        "ctx-a",
        "tmux_read",
        json!({
            "task": task,
            "timeMs": 10000,
            "line": 120
        }),
    );
    assert_eq!(read["type"], "reply", "{read}");
    assert!(
        read["message"]["output"]
            .as_array()
            .is_some_and(|lines| lines
                .iter()
                .any(|line| line.as_str() == Some("tmux second"))),
        "{read}"
    );
    let edited = patch(&env, instance, "3", "ctx-a", "tmux second", "tmux updated");
    assert_eq!(
        edited["message"]["operations"][0]["status"], "applied",
        "{edited}"
    );
    env.json_command(&["stop", "--instance", instance]);
}
