#![cfg(windows)]

mod support;

use std::fs;
use std::thread;
use std::time::Duration;

use serde_json::{Value, json};
use support::TestEnv;

fn start(env: &TestEnv, instance: &str) {
    env.command()
        .current_dir(env.workspace())
        .args(["start", "--instance", instance])
        .assert()
        .success();
}

fn call(
    env: &TestEnv,
    instance: &str,
    id: &str,
    method: &str,
    params: Value,
    request_id: &str,
) -> Value {
    env.rpc(
        instance,
        &json!({
            "type": "request",
            "id": id,
            "method": method,
            "params": params,
            "context": {
                "ctxId": "ctx-windows-panes",
                "requestId": request_id,
                "source": "mcp",
                "workspace": env.workspace(),
            }
        }),
    )
}

#[test]
fn persistent_pane_survives_worker_restart_on_windows() {
    let env = TestEnv::new();
    let instance = "windows-pane-persistence";
    start(&env, instance);

    let created = call(
        &env,
        instance,
        "create",
        "tmux_manage",
        json!({ "command": "create", "name": "shell" }),
        "create-shell",
    );
    assert_eq!(created["ok"], true, "{created}");
    assert_eq!(created["result"]["pane"]["name"], "shell", "{created}");

    let input = call(
        &env,
        instance,
        "input",
        "tmux_input",
        json!({
            "pane": "shell",
            "input": "Write-Output 'PSMUX_WINDOWS_OK_中文'^M"
        }),
        "write-shell",
    );
    assert_eq!(input["ok"], true, "{input}");

    thread::sleep(Duration::from_millis(500));
    let inspected = call(
        &env,
        instance,
        "inspect-before",
        "tmux_inspect",
        json!({ "pane": "shell", "start": -40, "end": 0 }),
        "inspect-before-restart",
    );
    assert_eq!(inspected["ok"], true, "{inspected}");
    let before_lines = inspected["result"]["panes"][0]["lines"]
        .as_array()
        .expect("pane lines");
    assert!(
        before_lines
            .iter()
            .filter_map(Value::as_str)
            .any(|line| line.contains("PSMUX_WINDOWS_OK_中文")),
        "{inspected}"
    );

    let stopped = env.json_command(&["stop", "--instance", instance]);
    assert_eq!(stopped["stopped"], true, "{stopped}");
    start(&env, instance);

    let listed = call(
        &env,
        instance,
        "list-after",
        "tmux_manage",
        json!({ "command": "list" }),
        "list-after-restart",
    );
    assert_eq!(listed["ok"], true, "{listed}");
    assert!(
        listed["result"]["panes"]
            .as_array()
            .expect("pane list")
            .iter()
            .any(|pane| pane["name"] == "shell"),
        "{listed}"
    );

    let inspected = call(
        &env,
        instance,
        "inspect-after",
        "tmux_inspect",
        json!({ "pane": "shell", "start": -40, "end": 0 }),
        "inspect-after-restart",
    );
    assert_eq!(inspected["ok"], true, "{inspected}");
    assert_eq!(inspected["result"]["panes"][0]["name"], "shell");
    assert!(
        matches!(
            inspected["result"]["panes"][0]["command"].as_str(),
            Some("pwsh" | "powershell")
        ),
        "{inspected}"
    );

    let stopped = env.json_command(&["stop", "--instance", instance]);
    assert_eq!(stopped["stopped"], true, "{stopped}");
    let retired = env.json_command(&["retire", "--instance", instance]);
    assert_eq!(retired["retired"], true, "{retired}");
}

#[test]
fn managed_task_uses_pwsh_and_preserves_durable_output_on_windows() {
    let env = TestEnv::new();
    let instance = "windows-managed-task";
    start(&env, instance);

    let run = call(
        &env,
        instance,
        "run",
        "tmux_run",
        json!({
            "command": "Write-Output 'WINDOWS_TASK_FIRST_中文'; Start-Sleep -Milliseconds 50; Write-Output WINDOWS_TASK_SECOND",
            "wait": "block",
            "timeout": 5000,
            "line": 80
        }),
        "run-pwsh-task",
    );
    assert_eq!(run["ok"], true, "{run}");
    assert_eq!(run["result"]["task"]["status"], "0", "{run}");
    let output = run["result"]["output"].as_array().expect("task output");
    assert!(
        output
            .iter()
            .filter_map(Value::as_str)
            .any(|line| line.contains("WINDOWS_TASK_FIRST_中文")),
        "{run}"
    );
    assert!(
        output
            .iter()
            .filter_map(Value::as_str)
            .any(|line| line.contains("WINDOWS_TASK_SECOND")),
        "{run}"
    );

    let stopped = env.json_command(&["stop", "--instance", instance]);
    assert_eq!(stopped["stopped"], true, "{stopped}");
    let retired = env.json_command(&["retire", "--instance", instance]);
    assert_eq!(retired["retired"], true, "{retired}");
}

#[test]
fn managed_task_accepts_input_on_windows() {
    let env = TestEnv::new();
    let instance = "windows-managed-input";
    start(&env, instance);

    let run = call(
        &env,
        instance,
        "run",
        "tmux_run",
        json!({
            "command": "$line = [Console]::ReadLine(); Write-Output (\"WINDOWS_INPUT:\" + $line)",
            "wait": "nonblock",
            "consumeOutput": false,
            "line": 0
        }),
        "run-input-task",
    );
    assert_eq!(run["ok"], true, "{run}");
    let task = run["result"]["task"]["id"].as_str().expect("task id");

    let input = call(
        &env,
        instance,
        "input",
        "tmux_input",
        json!({
            "task": task,
            "input": "hello-windows^M",
            "timeMs": 0,
            "line": 0
        }),
        "input-task",
    );
    assert_eq!(input["ok"], true, "{input}");

    let mut observed = Vec::new();
    let mut final_read = Value::Null;
    for index in 0..8 {
        let read = call(
            &env,
            instance,
            &format!("read-{index}"),
            "tmux_read",
            json!({ "task": task, "timeMs": 1000, "line": 80 }),
            &format!("read-input-result-{index}"),
        );
        assert_eq!(read["ok"], true, "{read}");
        observed.extend(
            read["result"]["output"]
                .as_array()
                .expect("task output")
                .iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned),
        );
        final_read = read;
        if observed
            .iter()
            .any(|line| line.contains("WINDOWS_INPUT:hello-windows"))
        {
            break;
        }
    }
    assert!(
        observed
            .iter()
            .any(|line| line.contains("WINDOWS_INPUT:hello-windows")),
        "{final_read}; observed={observed:?}"
    );

    let stopped = env.json_command(&["stop", "--instance", instance]);
    assert_eq!(stopped["stopped"], true, "{stopped}");
    let retired = env.json_command(&["retire", "--instance", instance]);
    assert_eq!(retired["retired"], true, "{retired}");
}

#[test]
fn managed_task_preserves_nonzero_exit_and_output_on_windows() {
    let env = TestEnv::new();
    let instance = "windows-managed-failure";
    start(&env, instance);

    let run = call(
        &env,
        instance,
        "run",
        "tmux_run",
        json!({
            "command": "Write-Output WINDOWS_FAILURE_OUTPUT; exit 7",
            "wait": "block",
            "timeout": 5000,
            "line": 80
        }),
        "run-failure-task",
    );
    assert_eq!(run["ok"], true, "{run}");
    assert_eq!(run["result"]["task"]["status"], "7", "{run}");
    assert!(
        run["result"]["output"]
            .as_array()
            .expect("task output")
            .iter()
            .filter_map(Value::as_str)
            .any(|line| line.contains("WINDOWS_FAILURE_OUTPUT")),
        "{run}"
    );

    let stopped = env.json_command(&["stop", "--instance", instance]);
    assert_eq!(stopped["stopped"], true, "{stopped}");
    let retired = env.json_command(&["retire", "--instance", instance]);
    assert_eq!(retired["retired"], true, "{retired}");
}

#[test]
fn managed_task_and_transcript_survive_worker_restart_on_windows() {
    let env = TestEnv::new();
    let instance = "windows-managed-restart";
    start(&env, instance);

    let run = call(
        &env,
        instance,
        "run",
        "tmux_run",
        json!({
            "command": "Write-Output BEFORE_WORKER_RESTART; Start-Sleep -Milliseconds 1200; Write-Output AFTER_WORKER_RESTART",
            "wait": "nonblock",
            "consumeOutput": false,
            "line": 0
        }),
        "run-restart-task",
    );
    assert_eq!(run["ok"], true, "{run}");
    let task = run["result"]["task"]["id"]
        .as_str()
        .expect("task id")
        .to_string();

    let stopped = env.json_command(&["stop", "--instance", instance]);
    assert_eq!(stopped["stopped"], true, "{stopped}");
    start(&env, instance);
    thread::sleep(Duration::from_millis(1600));

    let read = call(
        &env,
        instance,
        "read",
        "tmux_read",
        json!({ "task": task, "line": 80, "timeMs": 3000 }),
        "read-after-restart",
    );
    assert_eq!(read["ok"], true, "{read}");
    assert_eq!(read["result"]["task"]["status"], "0", "{read}");
    let output = read["result"]["output"].as_array().expect("task output");
    for marker in ["BEFORE_WORKER_RESTART", "AFTER_WORKER_RESTART"] {
        assert!(
            output
                .iter()
                .filter_map(Value::as_str)
                .any(|line| line.contains(marker)),
            "{read}"
        );
    }

    let stopped = env.json_command(&["stop", "--instance", instance]);
    assert_eq!(stopped["stopped"], true, "{stopped}");
    let retired = env.json_command(&["retire", "--instance", instance]);
    assert_eq!(retired["retired"], true, "{retired}");
}

#[test]
fn user_panes_do_not_inherit_the_internal_psmux_role_on_windows() {
    let env = TestEnv::new();
    let instance = "windows-psmux-environment";
    start(&env, instance);

    let run = call(
        &env,
        instance,
        "run-env",
        "tmux_run",
        json!({
            "command": "if (Test-Path Env:DEVSHELL_WORKER_INTERNAL_PSMUX) { exit 19 }; Write-Output PSMUX_ENV_CLEAN",
            "wait": "block",
            "timeout": 5000,
            "line": 40
        }),
        "run-env-clean",
    );
    assert_eq!(run["ok"], true, "{run}");
    assert_eq!(run["result"]["task"]["status"], "0", "{run}");
    assert!(
        run["result"]["output"]
            .as_array()
            .expect("task output")
            .iter()
            .filter_map(Value::as_str)
            .any(|line| line.contains("PSMUX_ENV_CLEAN")),
        "{run}"
    );

    let created = call(
        &env,
        instance,
        "create-env",
        "tmux_manage",
        json!({ "command": "create", "name": "env-shell" }),
        "create-env-shell",
    );
    assert_eq!(created["ok"], true, "{created}");
    let input = call(
        &env,
        instance,
        "input-env",
        "tmux_input",
        json!({
            "pane": "env-shell",
            "input": "if (Test-Path Env:DEVSHELL_WORKER_INTERNAL_PSMUX) { Write-Output PSMUX_ENV_LEAK } else { Write-Output PSMUX_PANE_ENV_CLEAN }^M"
        }),
        "input-env-shell",
    );
    assert_eq!(input["ok"], true, "{input}");
    thread::sleep(Duration::from_millis(300));
    let inspected = call(
        &env,
        instance,
        "inspect-env",
        "tmux_inspect",
        json!({ "pane": "env-shell", "start": -30, "end": 0 }),
        "inspect-env-shell",
    );
    assert_eq!(inspected["ok"], true, "{inspected}");
    let lines = inspected["result"]["panes"][0]["lines"]
        .as_array()
        .expect("pane lines");
    assert!(
        lines
            .iter()
            .filter_map(Value::as_str)
            .any(|line| line.contains("PSMUX_PANE_ENV_CLEAN")),
        "{inspected}"
    );
    assert!(
        !lines
            .iter()
            .filter_map(Value::as_str)
            .any(|line| line == "PSMUX_ENV_LEAK"),
        "{inspected}"
    );

    let stopped = env.json_command(&["stop", "--instance", instance]);
    assert_eq!(stopped["stopped"], true, "{stopped}");
    let retired = env.json_command(&["retire", "--instance", instance]);
    assert_eq!(retired["retired"], true, "{retired}");
}

#[test]
fn user_psmux_config_does_not_change_managed_session_on_windows() {
    let env = TestEnv::new();
    fs::write(
        env.home().join(".psmux.conf"),
        "set-environment DEVSHELL_PSMUX_CONFIG_POISON loaded\n",
    )
    .unwrap();
    let instance = "windows-psmux-config-isolation";
    start(&env, instance);

    let created = call(
        &env,
        instance,
        "create",
        "tmux_manage",
        json!({ "command": "create", "name": "config-safe" }),
        "create-config-safe-pane",
    );
    assert_eq!(created["ok"], true, "{created}");
    assert_eq!(
        created["result"]["pane"]["name"], "config-safe",
        "{created}"
    );

    let input = call(
        &env,
        instance,
        "input",
        "tmux_input",
        json!({
            "pane": "config-safe",
            "input": "if (Test-Path Env:DEVSHELL_PSMUX_CONFIG_POISON) { Write-Output (\"CONFIG_POISON:\" + $env:DEVSHELL_PSMUX_CONFIG_POISON) } else { Write-Output CONFIG_CLEAN }^M"
        }),
        "probe-config-isolation",
    );
    assert_eq!(input["ok"], true, "{input}");
    thread::sleep(Duration::from_millis(300));
    let inspected = call(
        &env,
        instance,
        "inspect",
        "tmux_inspect",
        json!({ "pane": "config-safe", "start": -30, "end": 0 }),
        "inspect-config-isolation",
    );
    assert_eq!(inspected["ok"], true, "{inspected}");
    let lines = inspected["result"]["panes"][0]["lines"]
        .as_array()
        .expect("pane lines");
    assert!(
        lines
            .iter()
            .filter_map(Value::as_str)
            .any(|line| line.contains("CONFIG_CLEAN")),
        "{inspected}"
    );
    assert!(
        !lines
            .iter()
            .filter_map(Value::as_str)
            .any(|line| line.contains("CONFIG_POISON:loaded")),
        "{inspected}"
    );

    let stopped = env.json_command(&["stop", "--instance", instance]);
    assert_eq!(stopped["stopped"], true, "{stopped}");
    let retired = env.json_command(&["retire", "--instance", instance]);
    assert_eq!(retired["retired"], true, "{retired}");
}
