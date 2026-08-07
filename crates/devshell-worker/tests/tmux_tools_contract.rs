#![cfg(unix)]

mod support;

use std::collections::HashSet;
use std::os::unix::fs::PermissionsExt;
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

fn tmux_pane_id_by_name(env: &TestEnv, instance: &str, name: &str) -> String {
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
            "#{@devshell_worker_pane_name}|#{pane_id}",
        ])
        .output()
        .expect("tmux list-panes should run");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .expect("tmux pane list should be UTF-8")
        .lines()
        .find_map(|line| {
            let (candidate, pane_id) = line.split_once('|')?;
            (candidate == name).then(|| pane_id.to_string())
        })
        .unwrap_or_else(|| panic!("managed pane not found: {name}"))
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
    assert!(input["result"].get("pane").is_none());
    assert!(input["result"].get("kind").is_none());
    assert!(input["result"].get("observationEpoch").is_none());
    assert!(input["result"].get("observationReset").is_none());
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
    assert!(read["result"].get("pane").is_none());
    assert!(read["result"].get("kind").is_none());
    assert!(read["result"].get("observationEpoch").is_none());
    assert!(read["result"].get("observationReset").is_none());
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
    assert!(run["result"]["task"].get("paneId").is_none());
    assert!(run["result"]["task"].get("startedAt").is_none());
    assert!(run["result"]["task"].get("finishedAt").is_none());
    assert!(run["result"]["pane"]["id"].is_string());
    assert_eq!(run["result"]["pane"]["name"], "main");
    assert!(run["result"]["pane"].get("tmuxPaneId").is_none());
    assert!(run["result"].get("kind").is_none());
    assert!(run["result"].get("warnings").is_none());
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
fn tmux_tasks_are_controllable_across_contexts_while_busy_guards_remain() {
    assert!(
        tmux_available(),
        "tmux is required to run this ignored contract test"
    );
    let env = TestEnv::new();
    let instance = "aromatic-tmux-cross-context";
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
    assert!(
        run["result"]["pane"].get("ownedByCurrentContext").is_none(),
        "{run}"
    );
    let task = run["result"]["task"]["id"].as_str().unwrap();

    let read = call(
        &env,
        instance,
        "2",
        "tmux_read",
        json!({ "task": task }),
        "ctx-b",
        "read-cross-context",
    );
    assert_eq!(read["ok"], true, "{read}");

    let inspect = call(
        &env,
        instance,
        "3",
        "tmux_inspect",
        json!({ "pane": "server", "start": -20, "end": 0 }),
        "ctx-b",
        "inspect-cross-context",
    );
    assert_eq!(inspect["ok"], true, "{inspect}");

    let busy_close = call(
        &env,
        instance,
        "4",
        "tmux_close",
        json!({ "pane": "server" }),
        "ctx-b",
        "close-busy",
    );
    assert_eq!(busy_close["error"]["code"], "tmux.paneBusy", "{busy_close}");

    let interrupted = call(
        &env,
        instance,
        "5",
        "tmux_input",
        json!({ "task": task, "input": "^C", "timeMs": 1000 }),
        "ctx-b",
        "input-cross-context",
    );
    assert_eq!(interrupted["ok"], true, "{interrupted}");
    let finished = wait_for_terminal(&env, instance, task, "ctx-c");
    assert_ne!(finished["result"]["task"]["status"], "running");

    let closed = call(
        &env,
        instance,
        "6",
        "tmux_close",
        json!({ "pane": "server" }),
        "ctx-c",
        "close-after-finish",
    );
    assert_eq!(closed["ok"], true, "{closed}");
    stop(&env, instance);
}

#[test]
#[ignore = "requires tmux on PATH"]
fn tmux_force_close_is_not_owned_by_the_creating_context() {
    assert!(
        tmux_available(),
        "tmux is required to run this ignored contract test"
    );
    let env = TestEnv::new();
    let instance = "aromatic-tmux-force-close";
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
    let pane_id = created["result"]["pane"]["id"].as_str().unwrap();
    let run = call(
        &env,
        instance,
        "2",
        "tmux_run",
        json!({ "pane": "server", "command": "sleep 30", "wait": "nonblock" }),
        "ctx-a",
        "run-server",
    );
    assert_eq!(run["ok"], true, "{run}");
    let task = run["result"]["task"]["id"].as_str().unwrap();

    let closed = call(
        &env,
        instance,
        "3",
        "tmux_close",
        json!({ "pane": "server", "force": true }),
        "ctx-b",
        "force-close-cross-context",
    );
    assert_eq!(closed["ok"], true, "{closed}");
    assert_eq!(closed["result"]["closedPaneId"], pane_id, "{closed}");

    let stale_input = call(
        &env,
        instance,
        "4",
        "tmux_input",
        json!({ "task": task, "input": "^C" }),
        "ctx-c",
        "input-after-force-close",
    );
    assert_eq!(
        stale_input["error"]["code"], "tmux.taskNotRunning",
        "{stale_input}"
    );
    stop(&env, instance);
}

#[test]
#[ignore = "requires tmux on PATH"]
fn pane_incarnation_change_invalidates_stale_task_control() {
    assert!(
        tmux_available(),
        "tmux is required to run this ignored contract test"
    );
    let env = TestEnv::new();
    let instance = "aromatic-tmux-incarnation";
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
    let run = call(
        &env,
        instance,
        "2",
        "tmux_run",
        json!({ "pane": "server", "command": "sleep 30", "wait": "nonblock" }),
        "ctx-a",
        "run-server",
    );
    assert_eq!(run["ok"], true, "{run}");
    let task = run["result"]["task"]["id"].as_str().unwrap();
    let tmux_pane_id = tmux_pane_id_by_name(&env, instance, "server");

    let changed = Command::new("tmux")
        .arg("-S")
        .arg(env.tmux_socket_file(instance))
        .args([
            "set-option",
            "-p",
            "-q",
            "-t",
            &tmux_pane_id,
            "@devshell_worker_pane_incarnation_id",
            "replacement-incarnation",
        ])
        .output()
        .expect("tmux set-option should run");
    assert!(
        changed.status.success(),
        "{}",
        String::from_utf8_lossy(&changed.stderr)
    );

    let stale_read = call(
        &env,
        instance,
        "3",
        "tmux_read",
        json!({ "task": task }),
        "ctx-b",
        "read-stale-incarnation",
    );
    assert_eq!(stale_read["ok"], true, "{stale_read}");
    assert_eq!(
        stale_read["result"]["task"]["status"], "unknown",
        "{stale_read}"
    );

    let stale_input = call(
        &env,
        instance,
        "4",
        "tmux_input",
        json!({ "task": task, "input": "^C" }),
        "ctx-c",
        "input-stale-incarnation",
    );
    assert_eq!(
        stale_input["error"]["code"], "tmux.taskNotRunning",
        "{stale_input}"
    );

    let closed = call(
        &env,
        instance,
        "5",
        "tmux_close",
        json!({ "pane": "server", "force": true }),
        "ctx-c",
        "close-reincarnated-pane",
    );
    assert_eq!(closed["ok"], true, "{closed}");
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
    let pane_id = tmux_pane_id_by_name(&env, instance, "main");
    let expected = tmux_capture_range(&env, instance, &pane_id, -100, -90);
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

    let dedicated = call(
        &env,
        instance,
        "1b",
        "tmux_create",
        json!({ "name": "server" }),
        "ctx-a",
        "create-dedicated",
    );
    assert_eq!(dedicated["ok"], true, "{dedicated}");

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
    let listed = call(
        &env,
        instance,
        "3",
        "tmux_list",
        json!({}),
        "ctx-a",
        "list-window-metadata",
    );
    assert_eq!(listed["ok"], true, "{listed}");
    let panes = listed["result"]["panes"].as_array().unwrap();
    assert_eq!(panes.len(), 3, "{listed}");
    assert!(panes.iter().all(|pane| {
        pane["id"].is_string()
            && pane["name"].is_string()
            && pane["status"].is_string()
            && pane.get("tmuxPaneId").is_none()
            && pane.get("tmuxWindowId").is_none()
            && pane.get("active").is_none()
            && pane.get("windowActive").is_none()
            && pane.get("columns").is_none()
            && pane.get("rows").is_none()
            && pane.get("cwd").is_none()
            && pane.get("command").is_none()
            && pane.get("createdAt").is_none()
            && pane.get("locked").is_none()
    }));
    assert!(listed["result"].get("kind").is_none());
    assert!(listed["result"].get("capacity").is_none());
    assert!(listed["result"].get("observationEpoch").is_none());
    assert!(listed["result"].get("observationReset").is_none());
    assert!(listed["result"].get("warnings").is_none());

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
    let server_pane = tmux_pane_id_by_name(&env, instance, "server");
    let socket = env.tmux_socket_file(instance);
    let main_pane = tmux_window_layout(&env, instance)
        .into_iter()
        .map(|(_, _, pane_id)| pane_id)
        .find(|pane_id| *pane_id != server_pane)
        .unwrap();
    let joined = Command::new("tmux")
        .args([
            "-S",
            socket.to_string_lossy().as_ref(),
            "join-pane",
            "-d",
            "-h",
            "-s",
            &server_pane,
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

    env.json_command(&["stop", "--instance", instance]);
    assert!(env.tmux_socket_file(instance).exists());
    start(&env, instance);

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
fn transport_session_close_does_not_bind_task_control_to_a_ctx_id() {
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
    assert!(
        run["result"]["pane"].get("ownedByCurrentContext").is_none(),
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

    let reconnected = call(
        &env,
        instance,
        "3",
        "tmux_read",
        json!({ "task": task }),
        "ctx-b",
        "read-after-reconnect",
    );
    assert_eq!(reconnected["ok"], true, "{reconnected}");

    let interrupted = call(
        &env,
        instance,
        "4",
        "tmux_input",
        json!({ "task": task, "input": "^C", "timeMs": 1000 }),
        "ctx-b",
        "input-after-reconnect",
    );
    assert_eq!(interrupted["ok"], true, "{interrupted}");
    let finished = wait_for_terminal(&env, instance, task, "ctx-c");
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
    assert!(listed["result"].get("observationReset").is_none());
    assert!(
        listed["result"]["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|warning| warning["code"] == "tmux.observationReset"),
        "{listed}"
    );
    stop(&env, instance);
}

#[test]
#[ignore = "requires tmux on PATH"]
fn worker_restart_automatically_adopts_running_tasks() {
    assert!(
        tmux_available(),
        "tmux is required to run this ignored contract test"
    );
    let env = TestEnv::new();
    let instance = "aromatic-tmux-adopt-task";
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
        "list-adopted",
    );
    assert_eq!(listed["ok"], true, "{listed}");
    assert_eq!(listed["result"]["panes"][0]["task"]["id"], task);
    assert!(
        listed["result"]["panes"][0]
            .get("ownedByCurrentContext")
            .is_none(),
        "{listed}"
    );
    assert!(
        listed["result"]["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|warning| warning["code"] == "tmux.taskAdopted"),
        "{listed}"
    );

    let interrupted = call(
        &env,
        instance,
        "3",
        "tmux_input",
        json!({ "task": task, "input": "^C", "timeMs": 1000 }),
        "ctx-b",
        "interrupt-adopted",
    );
    assert_eq!(interrupted["ok"], true, "{interrupted}");
    let finished = wait_for_terminal(&env, instance, task, "ctx-c");
    assert_ne!(finished["result"]["task"]["status"], "running");
    stop(&env, instance);
}

#[test]
#[ignore = "requires tmux on PATH"]
fn capacity_pressure_collects_only_idle_automatic_panes() {
    assert!(
        tmux_available(),
        "tmux is required to run this ignored contract test"
    );
    let env = TestEnv::new();
    let instance = "aromatic-tmux-gc-pressure";
    start(&env, instance);

    let main_task = call(
        &env,
        instance,
        "1",
        "tmux_run",
        json!({ "pane": "main", "command": "sleep 30", "wait": "nonblock" }),
        "ctx-a",
        "run-main-busy",
    );
    assert_eq!(main_task["ok"], true, "{main_task}");
    let main_task_id = main_task["result"]["task"]["id"].as_str().unwrap();

    let automatic = call(
        &env,
        instance,
        "2",
        "tmux_run",
        json!({ "command": "printf 'AUTO-DONE\\n'", "wait": "block", "timeMs": 3000, "line": 100 }),
        "ctx-a",
        "run-auto",
    );
    assert_eq!(automatic["ok"], true, "{automatic}");
    assert_eq!(automatic["result"]["pane"]["name"], "auto-1", "{automatic}");

    let interrupted = call(
        &env,
        instance,
        "3",
        "tmux_input",
        json!({ "task": main_task_id, "input": "^C", "timeMs": 1000 }),
        "ctx-b",
        "stop-main",
    );
    assert_eq!(interrupted["ok"], true, "{interrupted}");
    let _ = wait_for_terminal(&env, instance, main_task_id, "ctx-b");

    env.json_command(&["stop", "--instance", instance]);
    assert!(env.tmux_socket_file(instance).exists());
    start(&env, instance);
    let after_restart = call(
        &env,
        instance,
        "restart-list",
        "tmux_list",
        json!({}),
        "ctx-b",
        "list-before-pressure-gc",
    );
    assert_eq!(after_restart["ok"], true, "{after_restart}");
    assert!(
        after_restart["result"]["panes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|pane| pane["name"] == "auto-1"),
        "{after_restart}"
    );

    let explicit_auto_name = call(
        &env,
        instance,
        "create-auto-user",
        "tmux_create",
        json!({ "name": "auto-user" }),
        "ctx-a",
        "create-explicit-auto-name",
    );
    assert_eq!(explicit_auto_name["ok"], true, "{explicit_auto_name}");

    let mut collected = None;
    for index in 1..=64 {
        let created = call(
            &env,
            instance,
            &format!("create-{index}"),
            "tmux_create",
            json!({ "name": format!("persistent-{index}") }),
            "ctx-a",
            &format!("create-persistent-{index}"),
        );
        assert_eq!(created["ok"], true, "{created}");
        let pane_collected = created["result"]["warnings"]
            .as_array()
            .is_some_and(|warnings| {
                warnings
                    .iter()
                    .any(|warning| warning["code"] == "tmux.paneCollected")
            });
        if pane_collected {
            collected = Some(created);
            break;
        }
    }
    assert!(
        collected.is_some(),
        "capacity pressure did not collect the idle automatic pane"
    );

    let listed = call(
        &env,
        instance,
        "11",
        "tmux_list",
        json!({}),
        "ctx-c",
        "list-after-gc",
    );
    assert_eq!(listed["ok"], true, "{listed}");
    let pane_names = listed["result"]["panes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|pane| pane["name"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert!(!pane_names.contains(&"auto-1"), "{listed}");
    assert!(pane_names.contains(&"auto-user"), "{listed}");

    let full = call(
        &env,
        instance,
        "create-after-capacity",
        "tmux_create",
        json!({ "name": "persistent-after-capacity" }),
        "ctx-c",
        "create-without-collectable-pane",
    );
    assert_eq!(full["error"]["code"], "tmux.capacityReached", "{full}");
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

#[test]
#[ignore = "requires tmux on PATH"]
fn repeated_tmux_list_skips_session_reinitialization() {
    assert!(
        tmux_available(),
        "tmux is required to run this ignored contract test"
    );
    let real_tmux = Command::new("sh")
        .args(["-c", "command -v tmux"])
        .output()
        .expect("tmux path lookup should run");
    assert!(real_tmux.status.success());
    let real_tmux = String::from_utf8(real_tmux.stdout)
        .unwrap()
        .trim()
        .to_string();
    assert!(!real_tmux.contains('\''));

    let env = TestEnv::new();
    let bin_dir = env.home().join("tmux-wrapper-bin");
    std::fs::create_dir_all(&bin_dir).unwrap();
    let wrapper = bin_dir.join("tmux");
    let log = env.home().join("tmux-invocations.log");
    std::fs::write(
        &wrapper,
        format!("#!/bin/sh\nprintf 'x\\n' >> \"$TMUX_COUNT_LOG\"\nexec '{real_tmux}' \"$@\"\n"),
    )
    .unwrap();
    let mut permissions = std::fs::metadata(&wrapper).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&wrapper, permissions).unwrap();
    let path = format!(
        "{}:{}",
        bin_dir.display(),
        std::env::var("PATH").unwrap_or_default()
    );

    let instance = "aromatic-tmux-scan-count";
    env.command()
        .env("PATH", path)
        .env("TMUX_COUNT_LOG", &log)
        .current_dir(env.workspace())
        .args(["start", "--instance", instance])
        .assert()
        .success();
    let warm = call(
        &env,
        instance,
        "1",
        "tmux_list",
        json!({}),
        "ctx-a",
        "warm-list",
    );
    assert_eq!(warm["ok"], true, "{warm}");
    for index in 1..8 {
        let created = call(
            &env,
            instance,
            &format!("create-{index}"),
            "tmux_create",
            json!({ "name": format!("perf-{index}") }),
            "ctx-a",
            &format!("create-perf-{index}"),
        );
        assert_eq!(created["ok"], true, "{created}");
    }
    std::fs::write(&log, "").unwrap();

    let listed = call(
        &env,
        instance,
        "2",
        "tmux_list",
        json!({}),
        "ctx-a",
        "measured-list",
    );
    assert_eq!(listed["ok"], true, "{listed}");
    let invocation_count = std::fs::read_to_string(&log)
        .unwrap_or_default()
        .lines()
        .count();
    assert!(
        invocation_count <= 11,
        "repeated full-capacity tmux_list used {invocation_count} tmux commands"
    );
    stop(&env, instance);
}

#[test]
#[ignore = "requires tmux on PATH"]
fn concurrent_tmux_input_from_distinct_contexts_serializes_on_the_pane() {
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
    let instance = "aromatic-tmux-concurrent-input";
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
            "command": "read first; read second; printf 'CONTRACT:%s:%s\\n' \"$first\" \"$second\"",
            "wait": "nonblock"
        }),
        "ctx-a",
        "run-reader",
    );
    assert_eq!(run["ok"], true, "{run}");
    let task = run["result"]["task"]["id"].as_str().unwrap().to_string();
    assert_eq!(run["result"]["task"]["status"], "running", "{run}");

    let listed = call(
        &env,
        instance,
        "2",
        "tmux_list",
        json!({}),
        "ctx-list",
        "list-running-task",
    );
    assert_eq!(listed["ok"], true, "{listed}");
    let listed_task = listed["result"]["panes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|pane| pane["name"] == "main")
        .and_then(|pane| pane["task"]["id"].as_str())
        .map(ToOwned::to_owned);
    assert_eq!(listed_task.as_deref(), Some(task.as_str()), "{listed}");

    let task_a = task.clone();
    let task_b = task.clone();
    let (first, second) = thread::scope(|scope| {
        let first = scope.spawn(|| {
            call(
                &env,
                instance,
                "3a",
                "tmux_input",
                json!({ "task": task_a, "input": "AAAA^M", "timeMs": 0 }),
                "ctx-writer-a",
                "input-writer-a",
            )
        });
        let second = scope.spawn(|| {
            call(
                &env,
                instance,
                "3b",
                "tmux_input",
                json!({ "task": task_b, "input": "BBBB^M", "timeMs": 0 }),
                "ctx-writer-b",
                "input-writer-b",
            )
        });
        (first.join().unwrap(), second.join().unwrap())
    });

    assert_eq!(first["ok"], true, "{first}");
    assert_eq!(second["ok"], true, "{second}");

    let mut output: Vec<String> = Vec::new();
    for response in [&first, &second] {
        if let Some(lines) = response["result"]["output"].as_array() {
            output.extend(lines.iter().map(|line| line.as_str().unwrap().to_string()));
        }
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut attempt = 0;
    let final_status = loop {
        attempt += 1;
        let read = call(
            &env,
            instance,
            &format!("collect-{attempt}"),
            "tmux_read",
            json!({ "task": task, "line": 400, "timeMs": 200 }),
            "ctx-collect",
            &format!("collect-output-{attempt}"),
        );
        assert_eq!(read["ok"], true, "{read}");
        if let Some(lines) = read["result"]["output"].as_array() {
            output.extend(lines.iter().map(|line| line.as_str().unwrap().to_string()));
        }
        let status = read["result"]["task"]["status"]
            .as_str()
            .unwrap_or("unknown");
        if status != "running" {
            break status.to_string();
        }
        assert!(
            Instant::now() < deadline,
            "reader task did not finish; observed output: {output:?}"
        );
    };
    assert_eq!(
        final_status, "0",
        "reader task exit status; observed output: {output:?}"
    );

    let serialized = output
        .iter()
        .any(|line| line == "CONTRACT:AAAA:BBBB" || line == "CONTRACT:BBBB:AAAA");
    assert!(
        serialized,
        "concurrent tmux_input writes did not serialize into one intact line per writer (expected CONTRACT:AAAA:BBBB or CONTRACT:BBBB:AAAA); observed output: {output:?}"
    );

    stop(&env, instance);
}
