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

fn call(env: &TestEnv, instance: &str, id: &str, method: &str, params: Value) -> Value {
    env.rpc(
        instance,
        &json!({
            "type": "request",
            "id": id,
            "method": method,
            "params": params,
        }),
    )
}

fn kill_tmux_server(env: &TestEnv, instance: &str) {
    let socket = env.tmux_socket_file(instance);
    if !socket.exists() {
        return;
    }
    let _ = Command::new("tmux")
        .args(["-S", socket.to_string_lossy().as_ref(), "kill-server"])
        .status();
}

fn wait_for_idle(env: &TestEnv, instance: &str, pane: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let response = call(
            env,
            instance,
            "wait",
            "tmux_capture",
            json!({ "pane": pane, "line": 200 }),
        );
        assert_eq!(response["ok"], true, "{response}");
        let status = response["result"]["panes"][0]["status"]
            .as_str()
            .unwrap_or("unknown");
        if status == "idle" || status.parse::<i32>().is_ok() {
            return response;
        }
        assert!(
            Instant::now() < deadline,
            "pane did not become idle: {response}"
        );
        thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn tmux_tools_are_worker_native_and_document_caret_input() {
    if !tmux_available() {
        return;
    }

    let env = TestEnv::new();
    let instance = "aromatic-tmux-catalog";
    start(&env, instance);

    let tools = call(&env, instance, "1", "tools.list", json!({}));
    assert_eq!(tools["ok"], true, "{tools}");
    let catalog = tools["result"]["tools"].as_array().unwrap();
    let names = catalog
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect::<Vec<_>>();
    for expected in [
        "tmux_capture",
        "tmux_close",
        "tmux_create",
        "tmux_inspect",
        "tmux_list",
        "tmux_send",
    ] {
        assert!(names.contains(&expected), "missing {expected}: {names:?}");
    }

    let send = catalog
        .iter()
        .find(|tool| tool["name"] == "tmux_send")
        .expect("tmux_send catalog entry");
    let description = send["description"].as_str().unwrap();
    for notation in ["^M", "^C", "^D", "^I"] {
        assert!(
            description.contains(notation),
            "missing {notation}: {description}"
        );
    }

    env.json_command(&["stop", "--instance", instance]);
    kill_tmux_server(&env, instance);
}

#[test]
fn tmux_panes_support_send_capture_inspect_create_and_close() {
    if !tmux_available() {
        return;
    }

    let env = TestEnv::new();
    let instance = "aromatic-tmux-tools";
    start(&env, instance);

    let listed = call(&env, instance, "1", "tmux_list", json!({}));
    assert_eq!(listed["ok"], true, "{listed}");
    assert_eq!(listed["result"]["panes"].as_array().unwrap().len(), 1);
    assert_eq!(listed["result"]["panes"][0]["name"], "main");
    assert_eq!(listed["result"]["capacity"]["used"], 1);

    let sent = call(
        &env,
        instance,
        "2",
        "tmux_send",
        json!({
            "pane": "main",
            "input": "printf 'tmux-ready\\n'^M",
            "wait": "block",
            "timeMs": 3000,
            "line": 80
        }),
    );
    assert_eq!(sent["ok"], true, "{sent}");
    assert!(
        sent["result"]["panes"][0]["output"]
            .as_array()
            .unwrap()
            .iter()
            .any(|line| line
                .as_str()
                .is_some_and(|line| line.contains("tmux-ready"))),
        "{sent}"
    );

    let created = call(
        &env,
        instance,
        "3",
        "tmux_create",
        json!({
            "name": "server",
            "relativeTo": "main",
            "position": "right",
            "sizePercent": 40,
            "cwd": "./"
        }),
    );
    assert_eq!(created["ok"], true, "{created}");
    assert_eq!(created["result"]["pane"]["name"], "server");

    let nonblock = call(
        &env,
        instance,
        "4",
        "tmux_send",
        json!({
            "pane": "server",
            "input": "sleep 10^M",
            "wait": "nonblock",
            "timeMs": 100,
            "line": 20
        }),
    );
    assert_eq!(nonblock["ok"], true, "{nonblock}");
    assert_eq!(nonblock["result"]["panes"][0]["status"], "running");

    let interrupted = call(
        &env,
        instance,
        "5",
        "tmux_send",
        json!({
            "pane": "server",
            "input": "^C",
            "wait": "interactive",
            "timeMs": 1000,
            "line": 20
        }),
    );
    assert_eq!(interrupted["ok"], true, "{interrupted}");
    let _ = wait_for_idle(&env, instance, "server");

    let inspected = call(
        &env,
        instance,
        "6",
        "tmux_inspect",
        json!({ "panes": "all", "start": -20, "end": 0 }),
    );
    assert_eq!(inspected["ok"], true, "{inspected}");
    assert_eq!(inspected["result"]["panes"].as_array().unwrap().len(), 2);

    let closed = call(
        &env,
        instance,
        "7",
        "tmux_close",
        json!({ "pane": "server", "force": false }),
    );
    assert_eq!(closed["ok"], true, "{closed}");

    let final_list = call(&env, instance, "8", "tmux_list", json!({}));
    assert_eq!(final_list["result"]["panes"].as_array().unwrap().len(), 1);
    assert_eq!(final_list["result"]["panes"][0]["name"], "main");

    env.json_command(&["stop", "--instance", instance]);
    kill_tmux_server(&env, instance);
}

#[test]
fn worker_restart_adopts_the_existing_tmux_runtime() {
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
    );
    assert_eq!(created["ok"], true, "{created}");
    let pane_id = created["result"]["pane"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    env.json_command(&["stop", "--instance", instance]);
    assert!(env.tmux_socket_file(instance).exists());

    start(&env, instance);
    let listed = call(&env, instance, "2", "tmux_list", json!({}));
    assert_eq!(listed["ok"], true, "{listed}");
    let persistent = listed["result"]["panes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|pane| pane["name"] == "persistent")
        .expect("persistent pane after worker restart");
    assert_eq!(persistent["id"], pane_id);
    assert_eq!(listed["result"]["observationReset"], true);

    env.json_command(&["stop", "--instance", instance]);
    kill_tmux_server(&env, instance);
}
