mod support;

use std::fs;

use serde_json::Value;
use support::TestEnv;

#[test]
fn start_uses_runtime_workspace_and_keeps_config_minimal() {
    let env = TestEnv::new();
    let instance = "aromatic-pc";

    let start = env
        .command()
        .current_dir(env.workspace())
        .args(["start", "--instance", instance])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let start: Value = serde_json::from_slice(&start).unwrap();

    assert_eq!(start["ok"], true);
    assert_eq!(start["started"], true);
    assert_eq!(
        start["workspace"],
        env.workspace()
            .canonicalize()
            .unwrap()
            .display()
            .to_string()
    );

    let instance_root = env.instance_root(instance);
    assert!(instance_root.join("config.toml").exists());
    assert!(instance_root.join("logs/worker.log").exists());
    assert!(instance_root.join("state/worker.pid").exists());
    assert!(env.socket_file(instance).exists());

    let config = fs::read_to_string(instance_root.join("config.toml")).unwrap();
    assert!(config.contains("instance = \"aromatic-pc\""));
    assert!(!config.contains("workspace"));
    assert!(!config.contains("socket"));
    assert!(!config.contains("pid"));
    assert!(!config.contains("home"));
    assert!(!config.contains("workerPath"));

    let status = env.json_command(&["status", "--instance", instance]);
    assert_eq!(status["state"], "running");
    assert_eq!(status["running"], true);
    assert_eq!(
        status["workspace"],
        env.workspace()
            .canonicalize()
            .unwrap()
            .display()
            .to_string()
    );

    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn handshake_tools_and_bash_run_flow_work_over_framed_rpc() {
    let env = TestEnv::new();
    let instance = "aromatic-server";

    env.command()
        .current_dir(env.workspace())
        .args(["start", "--instance", instance])
        .assert()
        .success();

    let handshake = env.rpc(
        instance,
        &serde_json::json!({
            "type": "request",
            "id": "1",
            "method": "worker.handshake",
            "params": {
                "minProtocolVersion": 1,
                "maxProtocolVersion": 1,
                "clientName": "portable-devshell",
                "clientVersion": "0.1.0"
            }
        }),
    );
    assert_eq!(handshake["type"], "response");
    assert_eq!(handshake["ok"], true);
    assert_eq!(handshake["result"]["protocolVersion"], 1);
    assert_eq!(
        handshake["result"]["workerVersion"],
        env!("CARGO_PKG_VERSION")
    );
    assert_eq!(
        handshake["result"]["workspace"],
        env.workspace()
            .canonicalize()
            .unwrap()
            .display()
            .to_string()
    );
    assert!(handshake["result"].get("tools").is_none());

    let tools = env.rpc(
        instance,
        &serde_json::json!({
            "type": "request",
            "id": "2",
            "method": "tools.list",
            "params": {}
        }),
    );
    assert_eq!(tools["ok"], true);
    let catalog = tools["result"]["tools"].as_array().unwrap();
    assert_eq!(
        catalog
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec![
            "bash_run",
            "file_edit",
            "file_find",
            "file_info",
            "file_read",
            "file_search",
            "file_write",
        ]
    );
    for tool in catalog {
        assert!(tool["description"].is_string());
        assert!(tool["inputSchema"].is_object());
        assert!(tool["outputSchema"].is_object());
        assert!(matches!(
            tool["access"].as_str(),
            Some("read" | "write" | "execute" | "session")
        ));
    }

    let bash_run = env.rpc(
        instance,
        &serde_json::json!({
            "type": "request",
            "id": "3",
            "method": "bash_run",
            "params": {
                "command": "pwd && printf 'ready'"
            }
        }),
    );
    assert_eq!(bash_run["ok"], true);
    assert_eq!(bash_run["result"]["exitCode"], 0);
    assert_eq!(bash_run["result"]["termination"], "exited");
    assert_eq!(bash_run["result"]["stdoutTruncated"], false);
    assert_eq!(bash_run["result"]["stderrTruncated"], false);
    assert_eq!(
        bash_run["result"]["stdout"],
        format!(
            "{}\nready",
            env.workspace().canonicalize().unwrap().display()
        )
    );

    let stopped = env.json_command(&["stop", "--instance", instance]);
    assert_eq!(stopped["stopped"], true);
    let status = env.json_command(&["status", "--instance", instance]);
    assert_eq!(status["state"], "stopped");
    assert_eq!(status["running"], false);
    assert!(status["workspace"].is_null());
}

#[test]
fn handshake_rejects_unsupported_protocol_versions() {
    let env = TestEnv::new();
    let instance = "aromatic-lab";

    env.command()
        .current_dir(env.workspace())
        .args(["start", "--instance", instance])
        .assert()
        .success();

    let handshake = env.rpc(
        instance,
        &serde_json::json!({
            "type": "request",
            "id": "4",
            "method": "worker.handshake",
            "params": {
                "minProtocolVersion": 2,
                "maxProtocolVersion": 3
            }
        }),
    );
    assert_eq!(handshake["ok"], false);
    assert_eq!(
        handshake["error"]["code"],
        "worker.protocolVersionUnsupported"
    );
    assert_eq!(handshake["error"]["retryable"], false);
    assert_eq!(handshake["error"]["details"]["workerProtocolVersion"], 1);

    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn bash_run_returns_success_for_timeout_and_output_limit() {
    let env = TestEnv::new();
    let instance = "aromatic-timeout";

    env.command()
        .current_dir(env.workspace())
        .args(["start", "--instance", instance])
        .assert()
        .success();

    let timed_out = env.rpc(
        instance,
        &serde_json::json!({
            "type": "request",
            "id": "5",
            "method": "bash_run",
            "params": {
                "command": "sleep 1",
                "timeoutMs": 10
            }
        }),
    );
    assert_eq!(timed_out["ok"], true);
    assert_eq!(timed_out["result"]["termination"], "timeout");
    assert!(timed_out["result"]["exitCode"].is_null());

    let output_limited = env.rpc(
        instance,
        &serde_json::json!({
            "type": "request",
            "id": "6",
            "method": "bash_run",
            "params": {
                "command": "python3 - <<'PY'\nprint('x' * 2000)\nPY",
                "maxOutputBytes": 128
            }
        }),
    );
    assert_eq!(output_limited["ok"], true);
    assert_eq!(output_limited["result"]["termination"], "outputLimit");
    assert_eq!(output_limited["result"]["stdoutTruncated"], true);

    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn rejects_old_cli_shapes_and_invalid_instance_names() {
    let env = TestEnv::new();

    env.command()
        .args(["init", "--instance", "legacy-test"])
        .assert()
        .failure();
    env.command()
        .args(["status", "--instance", "abc"])
        .assert()
        .failure();
    env.command()
        .args(["status", "--instance", "bad_name"])
        .assert()
        .failure();
    env.command()
        .args(["start", "--instance", "ok-name", "--home", "/tmp/devshell"])
        .assert()
        .failure();
}

#[test]
fn invalid_rpc_requests_return_structured_errors() {
    let env = TestEnv::new();
    let instance = "aromatic-errors";

    env.command()
        .current_dir(env.workspace())
        .args(["start", "--instance", instance])
        .assert()
        .success();

    let wrong_type = env.rpc(
        instance,
        &serde_json::json!({
            "type": "response",
            "id": "bad-1",
            "method": "worker.ping",
            "params": {}
        }),
    );
    assert_eq!(wrong_type["ok"], false);
    assert_eq!(wrong_type["error"]["code"], "rpc.invalidRequest");
    assert_eq!(wrong_type["id"], "bad-1");

    let invalid_json = env.raw_rpc(
        instance,
        br#"{"type":"request","id":"bad-2","method":"worker.ping","params":"#,
    );
    assert_eq!(invalid_json["ok"], false);
    assert_eq!(invalid_json["error"]["code"], "rpc.invalidRequest");
    assert_eq!(invalid_json["id"], "");

    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn start_falls_back_to_stable_runtime_dir_when_xdg_runtime_dir_is_missing() {
    let env = TestEnv::new();
    let instance = "aromatic-mac";

    let start = env
        .command_without_runtime_dir()
        .current_dir(env.workspace())
        .args(["start", "--instance", instance])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let start: Value = serde_json::from_slice(&start).unwrap();

    assert_eq!(start["ok"], true);
    assert_eq!(start["started"], true);
    assert!(env.fallback_socket_file(instance).exists());

    let status_output = env
        .command_without_runtime_dir()
        .args(["status", "--instance", instance])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let status: Value = serde_json::from_slice(&status_output).unwrap();
    assert_eq!(status["state"], "running");
    assert_eq!(status["running"], true);

    let stop_output = env
        .command_without_runtime_dir()
        .args(["stop", "--instance", instance])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let stop: Value = serde_json::from_slice(&stop_output).unwrap();
    assert_eq!(stop["stopped"], true);
}

#[test]
fn workspace_security_mode_rejects_cwd_escape() {
    let env = TestEnv::new();
    let instance = "aromatic-secure";

    env.workspace_mode_command()
        .current_dir(env.workspace())
        .args(["start", "--instance", instance])
        .assert()
        .success();

    let escaped = env.rpc(
        instance,
        &serde_json::json!({
            "type": "request",
            "id": "7",
            "method": "bash_run",
            "params": {
                "command": "pwd",
                "cwd": ".."
            }
        }),
    );
    assert_eq!(escaped["ok"], false);
    assert_eq!(escaped["error"]["code"], "bash.invalidCwd");

    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn status_reports_stale_and_start_recovers_from_stale_runtime_files() {
    let env = TestEnv::new();
    let instance = "aromatic-stale";

    env.command()
        .current_dir(env.workspace())
        .args(["start", "--instance", instance])
        .assert()
        .success();
    env.json_command(&["stop", "--instance", instance]);

    let instance_root = env.instance_root(instance);
    fs::create_dir_all(instance_root.join("state")).unwrap();
    fs::write(instance_root.join("state/worker.pid"), "999999\n").unwrap();
    fs::create_dir_all(env.socket_file(instance).parent().unwrap()).unwrap();
    fs::write(env.socket_file(instance), b"stale").unwrap();

    let stale_status = env.json_command(&["status", "--instance", instance]);
    assert_eq!(stale_status["state"], "stale");
    assert_eq!(stale_status["running"], false);
    assert!(stale_status["workspace"].is_null());
    env.command()
        .args(["rpc", "--instance", instance])
        .assert()
        .failure();

    let restarted = env
        .command()
        .current_dir(env.workspace())
        .args(["start", "--instance", instance])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let restarted: Value = serde_json::from_slice(&restarted).unwrap();
    assert_eq!(restarted["started"], true);

    let running_status = env.json_command(&["status", "--instance", instance]);
    assert_eq!(running_status["state"], "running");
    assert_eq!(running_status["running"], true);

    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn gc_skips_invalid_markers_and_responsive_instances() {
    let env = TestEnv::new();
    let running = "aromatic-running";
    let stopped = "aromatic-stopped";
    let no_config = env.instance_root("aromatic-noconfig");
    let bad_config = env.instance_root("aromatic-badcfg");
    let mismatch = env.instance_root("aromatic-mismatch");

    env.command()
        .current_dir(env.workspace())
        .args(["start", "--instance", running])
        .assert()
        .success();

    env.command()
        .current_dir(env.workspace())
        .args(["start", "--instance", stopped])
        .assert()
        .success();
    env.json_command(&["stop", "--instance", stopped]);

    fs::create_dir_all(&no_config).unwrap();
    fs::create_dir_all(&bad_config).unwrap();
    fs::write(bad_config.join("config.toml"), "not = [toml").unwrap();
    fs::create_dir_all(&mismatch).unwrap();
    fs::write(
        mismatch.join("config.toml"),
        "version = 1\ninstance = \"someone-else\"\ncreatedAt = 1\n",
    )
    .unwrap();

    let gc = env.json_command(&["gc", "--dry-run"]);
    assert_eq!(gc["removed_instances"][0], stopped);
    assert_eq!(gc["skipped_running_instances"][0], running);
    assert!(gc["skipped_stale_instances"].as_array().unwrap().is_empty());
    assert!(no_config.exists());
    assert!(bad_config.exists());
    assert!(mismatch.exists());

    env.json_command(&["stop", "--instance", running]);
}

#[test]
fn daemon_start_failures_and_accept_loop_errors_clean_runtime_files() {
    let env = TestEnv::new();
    let bind_fail = "aromatic-bindfail";
    let loop_fail = "aromatic-loopfail";

    env.command_with_env("DEVSHELL_WORKER_TEST_FAIL_AFTER_BIND", "1")
        .current_dir(env.workspace())
        .args(["start", "--instance", bind_fail])
        .assert()
        .failure();
    assert!(
        !env.instance_root(bind_fail)
            .join("state/worker.pid")
            .exists()
    );
    assert!(!env.socket_file(bind_fail).exists());

    env.command_with_env("DEVSHELL_WORKER_TEST_FAIL_ACCEPT_LOOP", "1")
        .current_dir(env.workspace())
        .args(["start", "--instance", loop_fail])
        .assert()
        .failure();
    assert!(
        !env.instance_root(loop_fail)
            .join("state/worker.pid")
            .exists()
    );
    assert!(!env.socket_file(loop_fail).exists());
}
