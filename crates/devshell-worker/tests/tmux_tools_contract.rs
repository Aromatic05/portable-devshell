#![cfg(unix)]

mod support;

use std::collections::HashSet;
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
    ctx_id: &str,
    request_id: &str,
) -> Value {
    call_with_identity(
        env,
        instance,
        id,
        method,
        params,
        CallIdentity {
            ctx_id,
            operation_id: None,
            request_id,
        },
    )
}

#[derive(Clone, Copy)]
struct CallIdentity<'a> {
    ctx_id: &'a str,
    operation_id: Option<&'a str>,
    request_id: &'a str,
}

fn call_with_identity(
    env: &TestEnv,
    instance: &str,
    id: &str,
    method: &str,
    params: Value,
    identity: CallIdentity<'_>,
) -> Value {
    let mut context = json!({
        "ctxId": identity.ctx_id,
        "requestId": identity.request_id,
        "source": "mcp"
    });
    if let Some(operation_id) = identity.operation_id {
        context["operationId"] = json!(operation_id);
    }
    env.rpc(
        instance,
        &json!({
            "type": "request",
            "id": id,
            "method": method,
            "params": params,
            "context": context
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

fn tmux_window_layout(env: &TestEnv, instance: &str) -> Vec<(String, usize, String)> {
    let socket = env.tmux_socket_file(instance);
    let output = Command::new("tmux")
        .args([
            "-S",
            socket.to_string_lossy().as_ref(),
            "list-panes",
            "-s",
            "-t",
            "devshell",
            "-F",
            "#{window_id}|#{window_panes}|#{pane_id}",
        ])
        .output()
        .expect("tmux list-panes should run");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .expect("tmux layout should be UTF-8")
        .lines()
        .map(|line| {
            let mut fields = line.split('|');
            let window_id = fields.next().unwrap().to_string();
            let window_panes = fields.next().unwrap().parse::<usize>().unwrap();
            let pane_id = fields.next().unwrap().to_string();
            (window_id, window_panes, pane_id)
        })
        .collect()
}

fn tmux_pane_sizes(env: &TestEnv, instance: &str) -> Vec<(usize, usize)> {
    let socket = env.tmux_socket_file(instance);
    let output = Command::new("tmux")
        .args([
            "-S",
            socket.to_string_lossy().as_ref(),
            "list-panes",
            "-s",
            "-t",
            "devshell",
            "-F",
            "#{pane_width}|#{pane_height}",
        ])
        .output()
        .expect("tmux list-panes should run");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .expect("tmux pane sizes should be UTF-8")
        .lines()
        .map(|line| {
            let mut fields = line.split('|');
            let width = fields.next().unwrap().parse::<usize>().unwrap();
            let height = fields.next().unwrap().parse::<usize>().unwrap();
            (width, height)
        })
        .collect()
}

fn tmux_capture_range(
    env: &TestEnv,
    instance: &str,
    pane_id: &str,
    start: i64,
    end: i64,
) -> Vec<String> {
    let socket = env.tmux_socket_file(instance);
    let output = Command::new("tmux")
        .arg("-S")
        .arg(socket)
        .args(["capture-pane", "-p", "-t", pane_id, "-S", "-", "-E", "-"])
        .output()
        .expect("tmux capture-pane should run");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let lines = String::from_utf8(output.stdout)
        .expect("tmux capture should be UTF-8")
        .lines()
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    let logical_start = lines.len().saturating_sub(start.unsigned_abs() as usize);
    let logical_end = lines.len().saturating_sub(end.unsigned_abs() as usize);
    let mut selected = lines[logical_start.min(logical_end)..logical_end].to_vec();
    while selected.last().is_some_and(String::is_empty) {
        selected.pop();
    }
    selected
}

fn wait_for_terminal(env: &TestEnv, instance: &str, task: &str, ctx_id: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut attempt = 0;
    loop {
        attempt += 1;
        let response = call(
            env,
            instance,
            &format!("wait-{attempt}"),
            "tmux_read",
            json!({ "task": task, "line": 200, "timeMs": 200 }),
            ctx_id,
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
#[ignore = "requires tmux on PATH"]
fn tmux_catalog_exposes_task_scoped_tools() {
    assert!(
        tmux_available(),
        "tmux is required to run this ignored contract test"
    );
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
        "tmux_reclaim",
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
    assert_eq!(
        run["inputSchema"]["properties"]["pane"]["description"],
        "Managed pane name returned by tmux_list or tmux_create."
    );
    let input = catalog
        .iter()
        .find(|tool| tool["name"] == "tmux_input")
        .unwrap();
    assert_eq!(input["inputSchema"]["required"], json!(["task", "input"]));
    let create = catalog
        .iter()
        .find(|tool| tool["name"] == "tmux_create")
        .unwrap();
    assert_eq!(create["inputSchema"]["required"], json!(["name"]));
    for removed in ["relativeTo", "position", "sizePercent"] {
        assert!(
            create["inputSchema"]["properties"].get(removed).is_none(),
            "obsolete split option remains in tmux_create: {removed}"
        );
    }
    let read = catalog
        .iter()
        .find(|tool| tool["name"] == "tmux_read")
        .unwrap();
    assert!(
        read["description"]
            .as_str()
            .unwrap()
            .contains("not raw process stdout")
    );
    for (tool_name, field) in [("tmux_close", "pane"), ("tmux_inspect", "pane")] {
        let tool = catalog
            .iter()
            .find(|tool| tool["name"] == tool_name)
            .unwrap();
        assert_eq!(
            tool["inputSchema"]["properties"][field]["description"],
            "Managed pane name returned by tmux_list or tmux_create."
        );
    }
    for tool_name in ["tmux_run", "tmux_input", "tmux_read"] {
        let tool = catalog
            .iter()
            .find(|tool| tool["name"] == tool_name)
            .unwrap();
        assert_eq!(tool["inputSchema"]["properties"]["timeMs"]["minimum"], 0);
        assert_eq!(
            tool["inputSchema"]["properties"]["timeMs"]["maximum"],
            300_000
        );
    }
    stop(&env, instance);
}

#[test]
#[ignore = "requires tmux on PATH"]
fn tmux_zero_time_ms_returns_immediate_observations() {
    assert!(
        tmux_available(),
        "tmux is required to run this ignored contract test"
    );
    let env = TestEnv::new();
    let instance = "aromatic-tmux-zero-time";
    start(&env, instance);
    let run = call(
        &env,
        instance,
        "1",
        "tmux_run",
        json!({ "pane": "main", "command": "sleep 120", "wait": "nonblock", "timeMs": 0 }),
        "ctx-a",
        "run-ready",
    );
    assert_eq!(run["ok"], true, "{run}");
    let task = run["result"]["task"]["id"].as_str().unwrap();
    let input = call(
        &env,
        instance,
        "2",
        "tmux_input",
        json!({ "task": task, "input": "^C", "timeMs": 0 }),
        "ctx-a",
        "input-zero-time",
    );
    assert_eq!(input["ok"], true, "{input}");
    let read = call(
        &env,
        instance,
        "3",
        "tmux_read",
        json!({ "task": task, "timeMs": 0 }),
        "ctx-a",
        "read-zero-time",
    );
    assert_eq!(read["ok"], true, "{read}");
    let finished = wait_for_terminal(&env, instance, task, "ctx-a");
    assert_ne!(finished["result"]["task"]["status"], "running");
    stop(&env, instance);
}

#[test]
#[ignore = "requires tmux on PATH"]
fn tmux_run_returns_a_task_and_preserves_clean_first_output() {
    assert!(
        tmux_available(),
        "tmux is required to run this ignored contract test"
    );
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
        "ctx-a",
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
#[ignore = "requires tmux on PATH"]
fn tmux_task_lock_controls_input_read_and_close_but_not_inspect() {
    assert!(
        tmux_available(),
        "tmux is required to run this ignored contract test"
    );
    let env = TestEnv::new();
    let instance = "aromatic-tmux-lock";
    start(&env, instance);
    let created = call(
        &env,
        instance,
        "0",
        "tmux_create",
        json!({ "name": "server" }),
        "ctx-a",
        "create-server",
    );
    assert_eq!(created["ok"], true, "{created}");
    let run = call(
        &env,
        instance,
        "1",
        "tmux_run",
        json!({ "pane": "server", "command": "sleep 10", "wait": "nonblock" }),
        "ctx-a",
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
        "ctx-b",
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
        "ctx-b",
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
        "ctx-b",
        "inspect-foreign",
    );
    assert_eq!(inspect["ok"], true, "{inspect}");
    let denied_close = call(
        &env,
        instance,
        "5",
        "tmux_close",
        json!({ "pane": "server", "force": true }),
        "ctx-b",
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
        "ctx-a",
        "input-owner",
    );
    assert_eq!(interrupted["ok"], true, "{interrupted}");
    let finished = wait_for_terminal(&env, instance, task, "ctx-a");
    assert_ne!(finished["result"]["task"]["status"], "running");
    stop(&env, instance);
}

#[test]
#[ignore = "requires tmux on PATH"]
fn tmux_inspect_honors_nonzero_end_offsets() {
    assert!(
        tmux_available(),
        "tmux is required to run this ignored contract test"
    );
    let env = TestEnv::new();
    let instance = "aromatic-tmux-inspect-range";
    start(&env, instance);
    let run = call(
        &env,
        instance,
        "1",
        "tmux_run",
        json!({
            "pane": "main",
            "command": "i=1; while [ $i -le 200 ]; do printf 'LINE-%03d\\n' $i; i=$((i+1)); done",
            "wait": "block",
            "timeMs": 3000,
            "line": 300
        }),
        "ctx-a",
        "fill-history",
    );
    assert_eq!(run["ok"], true, "{run}");
    let pane_id = run["result"]["pane"]["tmuxPaneId"].as_str().unwrap();
    let expected = tmux_capture_range(&env, instance, pane_id, -100, -90);
    assert_eq!(expected.len(), 10, "{expected:?}");

    let inspect = call(
        &env,
        instance,
        "2",
        "tmux_inspect",
        json!({ "pane": "main", "start": -100, "end": -90 }),
        "ctx-a",
        "inspect-range",
    );
    assert_eq!(inspect["ok"], true, "{inspect}");
    let actual = inspect["result"]["panes"][0]["lines"]
        .as_array()
        .unwrap()
        .iter()
        .map(|line| line.as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_eq!(actual, expected);

    stop(&env, instance);
}

#[test]
#[ignore = "requires tmux on PATH"]
fn tmux_run_without_pane_reuses_idle_then_creates_auto_pane() {
    assert!(
        tmux_available(),
        "tmux is required to run this ignored contract test"
    );
    let env = TestEnv::new();
    let instance = "aromatic-tmux-auto";
    start(&env, instance);
    let first = call(
        &env,
        instance,
        "1",
        "tmux_run",
        json!({ "command": "sleep 10", "wait": "nonblock" }),
        "ctx-a",
        "run-main",
    );
    assert_eq!(first["result"]["pane"]["name"], "main", "{first}");
    let first_task = first["result"]["task"]["id"].as_str().unwrap();

    let second = call_with_identity(
        &env,
        instance,
        "2",
        "tmux_run",
        json!({ "command": "printf AUTO\\n", "wait": "block", "timeMs": 3000 }),
        CallIdentity {
            ctx_id: "ctx-b",
            operation_id: Some("run-auto-operation"),
            request_id: "run-auto",
        },
    );
    assert_eq!(second["ok"], true, "{second}");
    assert_eq!(second["result"]["pane"]["name"], "auto-1", "{second}");

    let replay = call_with_identity(
        &env,
        instance,
        "3",
        "tmux_run",
        json!({ "command": "printf AUTO\\n", "wait": "block", "timeMs": 3000 }),
        CallIdentity {
            ctx_id: "ctx-b",
            operation_id: Some("run-auto-operation"),
            request_id: "run-auto",
        },
    );
    assert_eq!(
        replay["result"]["task"]["id"],
        second["result"]["task"]["id"]
    );
    let conflict = call_with_identity(
        &env,
        instance,
        "3b",
        "tmux_run",
        json!({ "command": "printf DIFFERENT\\n", "wait": "block", "timeMs": 3000 }),
        CallIdentity {
            ctx_id: "ctx-b",
            operation_id: Some("run-auto-operation"),
            request_id: "run-auto",
        },
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
        "ctx-a",
        "stop-main",
    );
    let _ = wait_for_terminal(&env, instance, first_task, "ctx-a");
    stop(&env, instance);
}

#[test]
#[ignore = "requires tmux on PATH"]
fn managed_panes_use_independent_single_pane_windows() {
    assert!(
        tmux_available(),
        "tmux is required to run this ignored contract test"
    );
    let env = TestEnv::new();
    let instance = "aromatic-tmux-windows";
    start(&env, instance);

    for (id, name) in [("1", "server"), ("2", "watcher")] {
        let created = call(
            &env,
            instance,
            id,
            "tmux_create",
            json!({ "name": name }),
            "ctx-a",
            &format!("create-{name}"),
        );
        assert_eq!(created["ok"], true, "{created}");
    }

    let layout = tmux_window_layout(&env, instance);
    assert_eq!(layout.len(), 3, "{layout:?}");
    assert!(
        layout.iter().all(|(_, pane_count, _)| *pane_count == 1),
        "every managed task must have a full single-pane window: {layout:?}"
    );
    let windows = layout
        .iter()
        .map(|(window_id, _, _)| window_id)
        .collect::<HashSet<_>>();
    assert_eq!(windows.len(), layout.len(), "{layout:?}");
    let sizes = tmux_pane_sizes(&env, instance);
    assert!(
        sizes
            .iter()
            .all(|(width, height)| *width >= 240 && *height >= 60),
        "managed terminals must have a useful detached canvas: {sizes:?}"
    );

    stop(&env, instance);
}

#[test]
#[ignore = "requires tmux on PATH"]
fn existing_split_layout_is_migrated_without_restarting_tasks() {
    assert!(
        tmux_available(),
        "tmux is required to run this ignored contract test"
    );
    let env = TestEnv::new();
    let instance = "aromatic-tmux-migrate";
    start(&env, instance);

    let created = call(
        &env,
        instance,
        "1",
        "tmux_create",
        json!({ "name": "server" }),
        "ctx-a",
        "create-server",
    );
    assert_eq!(created["ok"], true, "{created}");
    let server_pane = created["result"]["pane"]["tmuxPaneId"].as_str().unwrap();
    let socket = env.tmux_socket_file(instance);
    let main_pane = tmux_window_layout(&env, instance)
        .into_iter()
        .map(|(_, _, pane_id)| pane_id)
        .find(|pane_id| pane_id != server_pane)
        .unwrap();
    let joined = Command::new("tmux")
        .args([
            "-S",
            socket.to_string_lossy().as_ref(),
            "join-pane",
            "-d",
            "-h",
            "-s",
            server_pane,
            "-t",
            &main_pane,
        ])
        .output()
        .expect("tmux join-pane should run");
    assert!(
        joined.status.success(),
        "{}",
        String::from_utf8_lossy(&joined.stderr)
    );
    assert!(
        tmux_window_layout(&env, instance)
            .iter()
            .all(|(_, pane_count, _)| *pane_count == 2)
    );

    let listed = call(
        &env,
        instance,
        "2",
        "tmux_list",
        json!({}),
        "ctx-a",
        "list-after-legacy-layout",
    );
    assert_eq!(listed["ok"], true, "{listed}");
    let layout = tmux_window_layout(&env, instance);
    assert_eq!(layout.len(), 2, "{layout:?}");
    assert!(
        layout.iter().all(|(_, pane_count, _)| *pane_count == 1),
        "legacy panes should be moved into full windows without task restart: {layout:?}"
    );

    stop(&env, instance);
}

#[test]
#[ignore = "requires tmux on PATH"]
fn concurrent_duplicate_run_requests_share_one_in_flight_execution() {
    assert!(
        tmux_available(),
        "tmux is required to run this ignored contract test"
    );
    let env = TestEnv::new();
    let instance = "aromatic-tmux-replay-race";
    start(&env, instance);

    let (first, second) = thread::scope(|scope| {
        let first = scope.spawn(|| {
            call_with_identity(
                &env,
                instance,
                "1",
                "tmux_run",
                json!({ "pane": "main", "command": "sleep 10", "wait": "nonblock" }),
                CallIdentity {
                    ctx_id: "ctx-a",
                    operation_id: Some("same-run-operation"),
                    request_id: "same-run-request",
                },
            )
        });
        let second = scope.spawn(|| {
            call_with_identity(
                &env,
                instance,
                "2",
                "tmux_run",
                json!({ "pane": "main", "command": "sleep 10", "wait": "nonblock" }),
                CallIdentity {
                    ctx_id: "ctx-a",
                    operation_id: Some("same-run-operation"),
                    request_id: "same-run-request",
                },
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
        "ctx-a",
        "stop-replayed-task",
    );
    assert_eq!(interrupted["ok"], true, "{interrupted}");
    let _ = wait_for_terminal(&env, instance, task, "ctx-a");
    stop(&env, instance);
}

#[test]
#[ignore = "requires tmux on PATH"]
fn block_wait_does_not_prevent_same_context_interrupt() {
    assert!(
        tmux_available(),
        "tmux is required to run this ignored contract test"
    );
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
                "ctx-a",
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
                "ctx-a",
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
            "ctx-a",
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
#[ignore = "requires tmux on PATH"]
fn bash_shell_preserves_task_identity_through_exit() {
    assert!(
        tmux_available(),
        "tmux is required to run this ignored contract test"
    );
    if !Command::new("bash")
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
        "ctx-bash",
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
#[ignore = "requires tmux on PATH"]
fn fish_shell_preserves_task_identity_through_exit() {
    let fish = Command::new("sh")
        .args(["-c", "command -v fish"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty());
    assert!(
        tmux_available(),
        "tmux is required to run this ignored contract test"
    );
    let Some(fish) = fish else {
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
    let started = Instant::now();
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
        "ctx-fish",
        "run-fish",
    );
    let elapsed = started.elapsed();
    assert_eq!(run["ok"], true, "{run}");
    assert!(
        elapsed < Duration::from_secs(2),
        "Fish pane initialization waited for the prompt timeout: {elapsed:?}"
    );
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
#[ignore = "requires tmux on PATH"]
fn transport_session_close_does_not_invalidate_context_owned_task() {
    assert!(
        tmux_available(),
        "tmux is required to run this ignored contract test"
    );
    let env = TestEnv::new();
    let instance = "aromatic-tmux-context-reconnect";
    start(&env, instance);
    let run = call(
        &env,
        instance,
        "1",
        "tmux_run",
        json!({ "pane": "main", "command": "sleep 10", "wait": "nonblock" }),
        "ctx-a",
        "run-before-close",
    );
    assert_eq!(run["ok"], true, "{run}");
    assert_eq!(
        run["result"]["pane"]["ownedByCurrentContext"], true,
        "{run}"
    );
    assert!(
        run["result"]["pane"].get("ownedByCurrentSession").is_none(),
        "{run}"
    );
    assert!(
        run["result"]["task"].get("ownerConnected").is_none(),
        "{run}"
    );
    let task = run["result"]["task"]["id"].as_str().unwrap();

    let closed = call(
        &env,
        instance,
        "2",
        "tool.session.close",
        json!({ "sessionId": "transport-session-a" }),
        "ctx-control",
        "close-transport-session",
    );
    assert_eq!(closed["ok"], true, "{closed}");

    let reconnected_owner = call(
        &env,
        instance,
        "3",
        "tmux_read",
        json!({ "task": task }),
        "ctx-a",
        "read-after-reconnect",
    );
    assert_eq!(reconnected_owner["ok"], true, "{reconnected_owner}");
    assert_eq!(
        reconnected_owner["result"]["pane"]["ownedByCurrentContext"], true,
        "{reconnected_owner}"
    );

    let foreign = call(
        &env,
        instance,
        "4",
        "tmux_input",
        json!({ "task": task, "input": "^C" }),
        "ctx-b",
        "input-foreign-context",
    );
    assert_eq!(foreign["error"]["code"], "tmux.taskLocked", "{foreign}");

    let interrupted = call(
        &env,
        instance,
        "5",
        "tmux_input",
        json!({ "task": task, "input": "^C", "timeMs": 1000 }),
        "ctx-a",
        "input-after-reconnect",
    );
    assert_eq!(interrupted["ok"], true, "{interrupted}");
    let finished = wait_for_terminal(&env, instance, task, "ctx-a");
    assert_ne!(finished["result"]["task"]["status"], "running");
    stop(&env, instance);
}

#[test]
#[ignore = "requires tmux on PATH"]
fn worker_restart_adopts_existing_panes() {
    assert!(
        tmux_available(),
        "tmux is required to run this ignored contract test"
    );
    let env = TestEnv::new();
    let instance = "aromatic-tmux-adopt";
    start(&env, instance);
    let created = call(
        &env,
        instance,
        "1",
        "tmux_create",
        json!({ "name": "persistent" }),
        "ctx-a",
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
        "ctx-b",
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

#[test]
#[ignore = "requires tmux on PATH"]
fn worker_restart_allows_explicit_orphan_reclaim() {
    assert!(
        tmux_available(),
        "tmux is required to run this ignored contract test"
    );
    let env = TestEnv::new();
    let instance = "aromatic-tmux-reclaim";
    start(&env, instance);
    let run = call(
        &env,
        instance,
        "1",
        "tmux_run",
        json!({ "pane": "main", "command": "sleep 30", "wait": "nonblock" }),
        "ctx-a",
        "run-before-restart",
    );
    assert_eq!(run["ok"], true, "{run}");
    let task = run["result"]["task"]["id"].as_str().unwrap();

    env.json_command(&["stop", "--instance", instance]);
    assert!(env.tmux_socket_file(instance).exists());
    start(&env, instance);

    let listed = call(
        &env,
        instance,
        "2",
        "tmux_list",
        json!({}),
        "ctx-b",
        "list-orphan",
    );
    assert_eq!(listed["ok"], true, "{listed}");
    assert_eq!(listed["result"]["panes"][0]["task"]["id"], task);
    assert_eq!(listed["result"]["panes"][0]["ownedByCurrentContext"], false);

    let reclaimed = call(
        &env,
        instance,
        "3",
        "tmux_reclaim",
        json!({ "task": task }),
        "ctx-b",
        "reclaim-orphan",
    );
    assert_eq!(reclaimed["ok"], true, "{reclaimed}");
    assert_eq!(reclaimed["result"]["task"]["id"], task);
    assert_eq!(reclaimed["result"]["pane"]["ownedByCurrentContext"], true);

    let foreign_reclaim = call(
        &env,
        instance,
        "4",
        "tmux_reclaim",
        json!({ "task": task }),
        "ctx-c",
        "reclaim-owned",
    );
    assert_eq!(
        foreign_reclaim["error"]["code"], "tmux.taskLocked",
        "{foreign_reclaim}"
    );

    let interrupted = call(
        &env,
        instance,
        "5",
        "tmux_input",
        json!({ "task": task, "input": "^C", "timeMs": 1000 }),
        "ctx-b",
        "interrupt-reclaimed",
    );
    assert_eq!(interrupted["ok"], true, "{interrupted}");
    let finished = wait_for_terminal(&env, instance, task, "ctx-b");
    assert_ne!(finished["result"]["task"]["status"], "running");
    stop(&env, instance);
}

#[test]
#[ignore = "requires tmux on PATH"]
fn tmux_input_delivers_ctrl_b_to_foreground_process() {
    assert!(
        tmux_available(),
        "tmux is required to run this ignored contract test"
    );
    let env = TestEnv::new();
    let instance = "aromatic-tmux-ctrl-b";
    start(&env, instance);
    let run = call(
        &env,
        instance,
        "1",
        "tmux_run",
        json!({
            "pane": "main",
            "command": "stty raw -echo; od -An -t x1 -N 1; stty sane",
            "wait": "nonblock"
        }),
        "ctx-a",
        "run-od",
    );
    assert_eq!(run["ok"], true, "{run}");
    let task = run["result"]["task"]["id"].as_str().unwrap();
    let input = call(
        &env,
        instance,
        "2",
        "tmux_input",
        json!({ "task": task, "input": "^B", "timeMs": 1000, "line": 20 }),
        "ctx-a",
        "send-ctrl-b",
    );
    assert_eq!(input["ok"], true, "{input}");
    let finished = wait_for_terminal(&env, instance, task, "ctx-a");
    assert_ne!(finished["result"]["task"]["status"], "running");
    stop(&env, instance);
}

#[test]
#[ignore = "requires tmux on PATH"]
fn tmux_input_returns_immediately_by_default() {
    assert!(
        tmux_available(),
        "tmux is required to run this ignored contract test"
    );
    let env = TestEnv::new();
    let instance = "aromatic-tmux-input-immediate";
    start(&env, instance);
    let run = call(
        &env,
        instance,
        "1",
        "tmux_run",
        json!({
            "pane": "main",
            "command": "stty raw -echo; dd bs=1 count=1 of=/dev/null 2>/dev/null; stty sane; sleep 30",
            "wait": "nonblock"
        }),
        "ctx-a",
        "run-no-output-input",
    );
    assert_eq!(run["ok"], true, "{run}");
    let task = run["result"]["task"]["id"].as_str().unwrap();

    let started = Instant::now();
    let input = call(
        &env,
        instance,
        "2",
        "tmux_input",
        json!({ "task": task, "input": "x" }),
        "ctx-a",
        "send-no-output-input",
    );
    let elapsed = started.elapsed();
    assert_eq!(input["ok"], true, "{input}");
    assert!(
        elapsed < Duration::from_millis(750),
        "default tmux_input waited instead of returning after send: {elapsed:?}"
    );

    let interrupted = call(
        &env,
        instance,
        "3",
        "tmux_input",
        json!({ "task": task, "input": "^C", "timeMs": 1000 }),
        "ctx-a",
        "interrupt-after-input",
    );
    assert_eq!(interrupted["ok"], true, "{interrupted}");
    let finished = wait_for_terminal(&env, instance, task, "ctx-a");
    assert_ne!(finished["result"]["task"]["status"], "running");
    stop(&env, instance);
}
