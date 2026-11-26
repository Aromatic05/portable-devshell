#![cfg(windows)]

#[path = "support/process.rs"]
mod process_fixture;
mod support;

use std::time::{Duration, Instant};

use base64::{Engine, engine::general_purpose::STANDARD};
use process_fixture::WorkerFixture;
use serde_json::{Value, json};

fn restart(fixture: &WorkerFixture, instance: &str) {
    assert_eq!(
        fixture.env.json_command(&["stop", "--instance", instance])["stopped"],
        true
    );
    fixture.env.json_command(&["start", "--instance", instance]);
}

fn wait_screen(fixture: &WorkerFixture, id: &str, marker: &str) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let page = fixture.tool("task_inspect", json!({"terminal": id}));
        if page["text"].as_str().unwrap().contains(marker) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "terminal did not display {marker}: {page}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn persistent_conpty_terminal_survives_worker_restart() {
    let instance = "windows-process-terminal";
    let fixture = WorkerFixture::start(instance);
    let created = fixture.tool(
        "task_manage",
        json!({
            "command": "create", "shell": "pwsh.exe -NoLogo -NoProfile",
        }),
    );
    assert_eq!(created["state"], "running");
    let id = created["id"].as_str().unwrap();
    fixture.tool(
        "task_input",
        json!({
            "task": id, "input": "[Console]::WriteLine(('WINDOWS-' + 'TERMINAL-中文'))\r",
        }),
    );
    wait_screen(&fixture, id, "WINDOWS-TERMINAL-中文");
    restart(&fixture, instance);
    let listed = fixture.tool("task_manage", json!({"command": "list"}));
    assert!(
        listed["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["id"] == id && entry["state"] == "running")
    );
    wait_screen(&fixture, id, "WINDOWS-TERMINAL-中文");
    fixture.tool(
        "task_input",
        json!({
            "task": id, "input": "[Console]::WriteLine(('AFTER-' + 'RESTART'))\r",
        }),
    );
    wait_screen(&fixture, id, "AFTER-RESTART");
    fixture.tool("task_manage", json!({"command": "close", "id": id}));
    let ended = fixture.wait_task(id, json!({}));
    assert_ne!(ended["termination"], "running");
    assert!(ended["stdout"].as_str().unwrap().contains("AFTER-RESTART"));
}

#[test]
fn managed_powershell_pipe_retains_unicode_output_across_restart() {
    let instance = "windows-process-pipe";
    let fixture = WorkerFixture::start(instance);
    let run = fixture.tool("bash_run", json!({
        "command": "[Console]::WriteLine('WINDOWS_TASK_FIRST_中文'); $value = [Console]::ReadLine(); [Console]::WriteLine(('WINDOWS_TASK_SECOND:' + $value)); [Console]::Error.WriteLine('WINDOWS_STDERR'); exit 7",
        "waitMs": 0, "keepStdin": true,
    }));
    assert_eq!(run["termination"], "running");
    let id = run["task"]["id"].as_str().unwrap();
    restart(&fixture, instance);
    fixture.tool(
        "task_input",
        json!({"task": id, "input": "hello-windows\n"}),
    );
    let result = fixture.wait_task(id, json!({}));
    assert_eq!(result["exitCode"], 7);
    assert!(
        result["stdout"]
            .as_str()
            .unwrap()
            .contains("WINDOWS_TASK_FIRST_中文")
    );
    assert!(
        result["stdout"]
            .as_str()
            .unwrap()
            .contains("WINDOWS_TASK_SECOND:hello-windows")
    );
    assert!(
        result["stderr"]
            .as_str()
            .unwrap()
            .contains("WINDOWS_STDERR")
    );
    let replay = fixture.tool("task_read", json!({"task": id}));
    assert_eq!(replay["stdout"], result["stdout"]);
    assert_eq!(replay["stderr"], result["stderr"]);
}

#[test]
fn native_conpty_shares_model_task_and_remote_control() {
    let instance = "windows-process-control";
    let fixture = WorkerFixture::start(instance);
    let started = fixture.tool("bash_run", json!({
        "command": "[Console]::WriteLine(('PTY-'+'READY')); $human = [Console]::ReadLine(); [Console]::WriteLine(('human:'+$human)); $model = [Console]::ReadLine(); [Console]::WriteLine(('model:'+$model))",
        "tty": true, "waitMs": 0,
    }));
    let id = started["task"]["id"].as_str().unwrap();
    wait_screen(&fixture, id, "PTY-READY");
    let call = |method: &str, message: Value| {
        let reply = fixture.env.rpc(instance, "terminal", &json!({
            "protocol": "rpc", "type": "request", "id": method, "method": method, "message": message
        }));
        assert_eq!(reply["type"], "reply", "{method}: {reply}");
        reply["message"].clone()
    };
    let listed = call("terminal.list", json!({}));
    let terminal = listed
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["terminalId"] == id)
        .unwrap();
    let generation = &terminal["generation"];
    let taken = call(
        "terminal.control",
        json!({"terminalId": id, "generation": generation}),
    );
    let controller = &taken["controller"];
    let denied = fixture.env.rpc(instance, "tool", &json!({
        "protocol": "rpc", "type": "request", "id": "deny-model-input", "method": "task_input",
        "message": {"input": {"task": id, "input": "unwanted\r"}, "context": {"workspace": fixture.env.protocol_workspace()}}
    }));
    assert_eq!(denied["type"], "error", "{denied}");
    assert_eq!(denied["error"]["code"], "process.controlOwned", "{denied}");
    let resized = call(
        "terminal.resize",
        json!({
            "terminalId": id, "generation": generation, "version": taken["session"]["version"],
            "clientSeq": 1, "controller": controller, "cols": 101, "rows": 31
        }),
    );
    call(
        "terminal.write",
        json!({
            "terminalId": id, "generation": generation, "version": resized["version"],
            "clientSeq": 2, "controller": controller, "data": STANDARD.encode("operator\r")
        }),
    );
    wait_screen(&fixture, id, "human:operator");
    call(
        "terminal.control",
        json!({"terminalId": id, "generation": generation, "controller": controller}),
    );
    fixture.tool("task_input", json!({"task": id, "input": "agent\r"}));
    let ended = fixture.wait_task(id, json!({}));
    assert_eq!(ended["exitCode"], 0, "{ended}");
    let stdout = ended["stdout"].as_str().unwrap();
    assert!(stdout.contains("human:operator"), "{stdout}");
    assert!(stdout.contains("model:agent"), "{stdout}");
}
