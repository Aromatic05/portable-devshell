mod support;

use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use support::TestEnv;

fn tmux_available() -> bool {
    Command::new("tmux")
        .arg("-V")
        .output()
        .is_ok_and(|output| output.status.success())
}

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
    session: &str,
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
                "sessionId": session,
                "requestId": request_id,
                "source": "mcp"
            }
        }),
    )
}

fn kill_tmux_server(env: &TestEnv, instance: &str) {
    let socket = env.tmux_socket_file(instance);
    if socket.exists() {
        let _ = Command::new("tmux")
            .args(["-S", socket.to_string_lossy().as_ref(), "kill-server"])
            .status();
    }
}

fn stop(env: &TestEnv, instance: &str) {
    env.json_command(&["stop", "--instance", instance]);
    kill_tmux_server(env, instance);
}

fn wait_for_terminal(env: &TestEnv, instance: &str, task: &str, session: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let response = call(
            env,
            instance,
            "wait",
            "tmux_read",
            json!({ "task": task, "line": 200, "timeMs": 200 }),
            session,
            "wait-task",
        );
        assert_eq!(response["ok"], true, "{response}");
        let status = response["result"]["task"]["status"]
            .as_str()
            .unwrap_or("unknown");
        if status != "running" {
            return response;
        }
        assert!(Instant::now() < deadline, "task did not finish: {response}");
    }
}

#[test]
fn tmux_catalog_exposes_task_scoped_tools() {
    if !tmux_available() {
        return;
    }
    let env = TestEnv::new();
    let instance = "aromatic-tmux-catalog";
    start(&env, instance);
    let tools = call(
        &env,
        instance,
        "1",
        "tools.list",
        json!({}),
        "catalog",
        "tools",
    );
    let catalog = tools["result"]["tools"].as_array().unwrap();
    let names = catalog
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect::<Vec<_>>();
    for expected in [
        "tmux_close",
        "tmux_create",
        "tmux_input",
        "tmux_inspect",
        "tmux_list",
        "tmux_read",
        "tmux_run",
    ] {
        assert!(names.contains(&expected), "missing {expected}: {names:?}");
    }
    assert!(!names.contains(&"tmux_send"));
    assert!(!names.contains(&"tmux_capture"));
    let run = catalog
        .iter()
        .find(|tool| tool["name"] == "tmux_run")
        .unwrap();
    assert_eq!(run["inputSchema"]["required"], json!(["command"]));
    let input = catalog
        .iter()
        .find(|tool| tool["name"] == "tmux_input")
        .unwrap();
    assert_eq!(input["inputSchema"]["required"], json!(["task", "input"]));
    stop(&env, instance);
}

#[test]
fn tmux_run_returns_a_task_and_preserves_clean_first_output() {
    if !tmux_available() {
        return;
    }
    let env = TestEnv::new();
    let instance = "aromatic-tmux-run";
    start(&env, instance);
    let run = call(
        &env,
        instance,
        "1",
        "tmux_run",
        json!({
            "pane": "main",
            "command": "printf '\\x4f\\x4b\\n'",
            "wait": "block",
            "timeMs": 3000,
            "line": 80
        }),
        "session-a",
        "run-ok",
    );
    assert_eq!(run["ok"], true, "{run}");
    assert_eq!(run["result"]["task"]["status"], "0", "{run}");
    assert!(
        run["result"]["output"]
            .as_array()
            .unwrap()
            .iter()
            .any(|line| line.as_str() == Some("OK")),
        "{run}"
    );
    stop(&env, instance);
}

#[test]
fn tmux_task_lock_controls_input_read_and_close_but_not_inspect() {
    if !tmux_available() {
        return;
    }
    let env = TestEnv::new();
    let instance = "aromatic-tmux-lock";
    start(&env, instance);
    let created = call(
        &env,
        instance,
        "0",
        "tmux_create",
        json!({ "name": "server" }),
        "session-a",
        "create-server",
    );
    assert_eq!(created["ok"], true, "{created}");
    let run = call(
        &env,
        instance,
        "1",
        "tmux_run",
        json!({ "pane": "server", "command": "sleep 10", "wait": "nonblock" }),
        "session-a",
        "run-sleep",
    );
    assert_eq!(run["ok"], true, "{run}");
    let task = run["result"]["task"]["id"].as_str().unwrap();

    let denied_read = call(
        &env,
        instance,
        "2",
        "tmux_read",
        json!({ "task": task }),
        "session-b",
        "read-foreign",
    );
    assert_eq!(
        denied_read["error"]["code"], "tmux.taskLocked",
        "{denied_read}"
    );
    let denied_input = call(
        &env,
        instance,
        "3",
        "tmux_input",
        json!({ "task": task, "input": "^C" }),
        "session-b",
        "input-foreign",
    );
    assert_eq!(
        denied_input["error"]["code"], "tmux.taskLocked",
        "{denied_input}"
    );
    let inspect = call(
        &env,
        instance,
        "4",
        "tmux_inspect",
        json!({ "pane": "server", "start": -20, "end": 0 }),
        "session-b",
        "inspect-foreign",
    );
    assert_eq!(inspect["ok"], true, "{inspect}");
    let denied_close = call(
        &env,
        instance,
        "5",
        "tmux_close",
        json!({ "pane": "server", "force": true }),
        "session-b",
        "close-foreign",
    );
    assert_eq!(
        denied_close["error"]["code"], "tmux.taskLocked",
        "{denied_close}"
    );

    let interrupted = call(
        &env,
        instance,
        "6",
        "tmux_input",
        json!({ "task": task, "input": "^C", "timeMs": 1000 }),
        "session-a",
        "input-owner",
    );
    assert_eq!(interrupted["ok"], true, "{interrupted}");
    let finished = wait_for_terminal(&env, instance, task, "session-a");
    assert_ne!(finished["result"]["task"]["status"], "running");
    stop(&env, instance);
}

#[test]
fn tmux_run_without_pane_reuses_idle_then_creates_auto_pane() {
    if !tmux_available() {
        return;
    }
    let env = TestEnv::new();
    let instance = "aromatic-tmux-auto";
    start(&env, instance);
    let first = call(
        &env,
        instance,
        "1",
        "tmux_run",
        json!({ "command": "sleep 10", "wait": "nonblock" }),
        "session-a",
        "run-main",
    );
    assert_eq!(first["result"]["pane"]["name"], "main", "{first}");
    let first_task = first["result"]["task"]["id"].as_str().unwrap();

    let second = call(
        &env,
        instance,
        "2",
        "tmux_run",
        json!({ "command": "printf AUTO\\n", "wait": "block", "timeMs": 3000 }),
        "session-b",
        "run-auto",
    );
    assert_eq!(second["ok"], true, "{second}");
    assert_eq!(second["result"]["pane"]["name"], "auto-1", "{second}");

    let replay = call(
        &env,
        instance,
        "3",
        "tmux_run",
        json!({ "command": "printf AUTO\\n", "wait": "block", "timeMs": 3000 }),
        "session-b",
        "run-auto",
    );
    assert_eq!(
        replay["result"]["task"]["id"],
        second["result"]["task"]["id"]
    );
    let conflict = call(
        &env,
        instance,
        "3b",
        "tmux_run",
        json!({ "command": "printf DIFFERENT\\n", "wait": "block", "timeMs": 3000 }),
        "session-b",
        "run-auto",
    );
    assert_eq!(
        conflict["error"]["code"], "tmux.requestIdConflict",
        "{conflict}"
    );

    let _ = call(
        &env,
        instance,
        "4",
        "tmux_input",
        json!({ "task": first_task, "input": "^C" }),
        "session-a",
        "stop-main",
    );
    let _ = wait_for_terminal(&env, instance, first_task, "session-a");
    stop(&env, instance);
}

#[test]
fn concurrent_duplicate_run_requests_share_one_in_flight_execution() {
    if !tmux_available() {
        return;
    }
    let env = TestEnv::new();
    let instance = "aromatic-tmux-replay-race";
    start(&env, instance);

    let (first, second) = thread::scope(|scope| {
        let first = scope.spawn(|| {
            call(
                &env,
                instance,
                "1",
                "tmux_run",
                json!({ "pane": "main", "command": "sleep 10", "wait": "nonblock" }),
                "session-a",
                "same-run-request",
            )
        });
        let second = scope.spawn(|| {
            call(
                &env,
                instance,
                "2",
                "tmux_run",
                json!({ "pane": "main", "command": "sleep 10", "wait": "nonblock" }),
                "session-a",
                "same-run-request",
            )
        });
        (first.join().unwrap(), second.join().unwrap())
    });

    assert_eq!(first["ok"], true, "{first}");
    assert_eq!(second["ok"], true, "{second}");
    assert_eq!(
        first["result"]["task"]["id"],
        second["result"]["task"]["id"]
    );
    let task = first["result"]["task"]["id"].as_str().unwrap();
    let interrupted = call(
        &env,
        instance,
        "3",
        "tmux_input",
        json!({ "task": task, "input": "^C", "timeMs": 1000 }),
        "session-a",
        "stop-replayed-task",
    );
    assert_eq!(interrupted["ok"], true, "{interrupted}");
    let _ = wait_for_terminal(&env, instance, task, "session-a");
    stop(&env, instance);
}

#[test]
fn block_wait_does_not_prevent_same_session_interrupt() {
    if !tmux_available() {
        return;
    }
    let env = TestEnv::new();
    let instance = "aromatic-tmux-concurrent";
    start(&env, instance);

    thread::scope(|scope| {
        let block = scope.spawn(|| {
            call(
                &env,
                instance,
                "1",
                "tmux_run",
                json!({ "pane": "main", "command": "sleep 10", "wait": "block", "timeMs": 5000 }),
                "session-a",
                "block-run",
            )
        });

        let deadline = Instant::now() + Duration::from_secs(3);
        let task = loop {
            let listed = call(
                &env,
                instance,
                "2",
                "tmux_list",
                json!({}),
                "session-a",
                "list-running",
            );
            if let Some(task) = listed["result"]["panes"][0]["task"]["id"].as_str() {
                break task.to_string();
            }
            assert!(Instant::now() < deadline, "task did not appear: {listed}");
            thread::sleep(Duration::from_millis(25));
        };
        let interrupted = call(
            &env,
            instance,
            "3",
            "tmux_input",
            json!({ "task": task, "input": "^C", "timeMs": 1000 }),
            "session-a",
            "interrupt-block",
        );
        assert_eq!(interrupted["ok"], true, "{interrupted}");
        let result = block.join().unwrap();
        assert_eq!(result["ok"], true, "{result}");
        assert_ne!(result["result"]["task"]["status"], "running", "{result}");
    });

    stop(&env, instance);
}

#[test]
fn bash_shell_preserves_task_identity_through_exit() {
    if !tmux_available()
        || !Command::new("bash")
            .arg("--version")
            .output()
            .is_ok_and(|output| output.status.success())
    {
        return;
    }
    let env = TestEnv::new();
    let instance = "aromatic-tmux-bash";
    env.command_with_env("SHELL", "/bin/bash")
        .current_dir(env.workspace())
        .args(["start", "--instance", instance])
        .assert()
        .success();
    let run = call(
        &env,
        instance,
        "1",
        "tmux_run",
        json!({
            "pane": "main",
            "command": "printf 'BASH-OK\\n'",
            "wait": "block",
            "timeMs": 3000,
            "line": 80
        }),
        "session-bash",
        "run-bash",
    );
    assert_eq!(run["ok"], true, "{run}");
    assert_eq!(run["result"]["task"]["status"], "0", "{run}");
    assert!(
        run["result"]["output"]
            .as_array()
            .unwrap()
            .iter()
            .any(|line| line.as_str() == Some("BASH-OK")),
        "{run}"
    );
    stop(&env, instance);
}

#[test]
fn fish_shell_preserves_task_identity_through_exit() {
    let fish = Command::new("sh")
        .args(["-c", "command -v fish"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty());
    let Some(fish) = fish.filter(|_| tmux_available()) else {
        return;
    };
    let env = TestEnv::new();
    let fish_config_dir = env.home().join(".config/fish");
    std::fs::create_dir_all(&fish_config_dir).unwrap();
    std::fs::write(
        fish_config_dir.join("config.fish"),
        "set -gx DEVSHELL_FISH_CONFIG_MARKER loaded\n",
    )
    .unwrap();
    let instance = "aromatic-tmux-fish";
    env.command_with_env("SHELL", &fish)
        .current_dir(env.workspace())
        .args(["start", "--instance", instance])
        .assert()
        .success();
    let run = call(
        &env,
        instance,
        "1",
        "tmux_run",
        json!({
            "pane": "main",
            "command": "test \"$DEVSHELL_FISH_CONFIG_MARKER\" = loaded; and printf 'FISH-OK\\n'",
            "wait": "block",
            "timeMs": 3000,
            "line": 80
        }),
        "session-fish",
        "run-fish",
    );
    assert_eq!(run["ok"], true, "{run}");
    assert_eq!(run["result"]["task"]["status"], "0", "{run}");
    assert!(
        run["result"]["output"]
            .as_array()
            .unwrap()
            .iter()
            .any(|line| line.as_str() == Some("FISH-OK")),
        "{run}"
    );
    stop(&env, instance);
}

#[test]
fn closing_owner_session_keeps_running_task_locked_until_exit() {
    if !tmux_available() {
        return;
    }
    let env = TestEnv::new();
    let instance = "aromatic-tmux-session-close";
    start(&env, instance);
    let run = call(
        &env,
        instance,
        "1",
        "tmux_run",
        json!({ "pane": "main", "command": "sleep 1", "wait": "nonblock" }),
        "session-a",
        "run-before-close",
    );
    assert_eq!(run["ok"], true, "{run}");
    let task = run["result"]["task"]["id"].as_str().unwrap();
    let closed = call(
        &env,
        instance,
        "2",
        "tool.session.close",
        json!({ "sessionId": "session-a" }),
        "control",
        "close-session",
    );
    assert_eq!(closed["ok"], true, "{closed}");

    let listed = call(
        &env,
        instance,
        "3",
        "tmux_list",
        json!({}),
        "session-b",
        "list-locked",
    );
    assert_eq!(listed["result"]["panes"][0]["locked"], true, "{listed}");
    assert_eq!(
        listed["result"]["panes"][0]["task"]["ownerConnected"], false,
        "{listed}"
    );
    let stale_owner = call(
        &env,
        instance,
        "4",
        "tmux_input",
        json!({ "task": task, "input": "^C" }),
        "session-a",
        "input-after-close",
    );
    assert_eq!(
        stale_owner["error"]["code"], "tmux.sessionClosed",
        "{stale_owner}"
    );
    let late_run = call(
        &env,
        instance,
        "4b",
        "tmux_run",
        json!({ "command": "echo LATE", "wait": "block", "timeMs": 1000 }),
        "session-a",
        "late-run-after-close",
    );
    assert_eq!(
        late_run["error"]["code"], "tmux.sessionClosed",
        "{late_run}"
    );

    thread::sleep(Duration::from_millis(1200));
    let after = call(
        &env,
        instance,
        "5",
        "tmux_list",
        json!({}),
        "session-b",
        "list-after-exit",
    );
    assert_eq!(after["result"]["panes"][0]["locked"], false, "{after}");
    stop(&env, instance);
}

#[test]
fn worker_restart_adopts_existing_panes() {
    if !tmux_available() {
        return;
    }
    let env = TestEnv::new();
    let instance = "aromatic-tmux-adopt";
    start(&env, instance);
    let created = call(
        &env,
        instance,
        "1",
        "tmux_create",
        json!({ "name": "persistent" }),
        "session-a",
        "create-persistent",
    );
    let pane_id = created["result"]["pane"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    env.json_command(&["stop", "--instance", instance]);
    assert!(env.tmux_socket_file(instance).exists());
    start(&env, instance);
    let listed = call(
        &env,
        instance,
        "2",
        "tmux_list",
        json!({}),
        "session-b",
        "list-adopt",
    );
    let persistent = listed["result"]["panes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|pane| pane["name"] == "persistent")
        .unwrap();
    assert_eq!(persistent["id"], pane_id);
    assert_eq!(listed["result"]["observationReset"], true);
    stop(&env, instance);
}
