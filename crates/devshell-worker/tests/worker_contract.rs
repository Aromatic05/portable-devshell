mod support;

use std::fs;
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};

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
    assert_eq!(start["workspace"], env.protocol_workspace());

    let instance_root = env.instance_root(instance);
    assert!(instance_root.join("config.toml").exists());
    assert!(instance_root.join("logs/worker.log").exists());
    assert!(instance_root.join("state/worker.pid").exists());
    #[cfg(unix)]
    assert!(env.socket_file(instance).exists());

    let config = fs::read_to_string(instance_root.join("config.toml")).unwrap();
    assert!(config.contains("instance = \"aromatic-pc\""));
    assert!(!config.contains("workspace"));
    assert!(!config.contains("socket"));
    assert!(!config.contains("pid"));
    assert!(!config.contains("home"));
    assert!(!config.contains("workerPath"));
    assert!(!config.contains("tools"));

    let status = env.json_command(&["status", "--instance", instance]);
    assert_eq!(status["state"], "running");
    assert_eq!(status["running"], true);
    assert_eq!(status["workspace"], env.protocol_workspace());

    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn start_replaces_a_running_daemon_from_a_different_worker_identity() {
    let env = TestEnv::new();
    let instance = "aromatic-worker-upgrade";
    let source = assert_cmd::cargo::cargo_bin("devshell-worker");
    let binary_name = source.file_name().unwrap();
    let old_sha = "1".repeat(64);
    let new_sha = "2".repeat(64);
    let old_binary = env.home().join(&old_sha).join(binary_name);
    let new_binary = env.home().join(&new_sha).join(binary_name);
    fs::create_dir_all(old_binary.parent().unwrap()).unwrap();
    fs::create_dir_all(new_binary.parent().unwrap()).unwrap();
    fs::copy(&source, &old_binary).unwrap();
    fs::copy(&source, &new_binary).unwrap();

    let old_start = env
        .std_command_for(&old_binary)
        .current_dir(env.workspace())
        .args(["start", "--instance", instance])
        .output()
        .unwrap();
    assert!(old_start.status.success(), "{}", String::from_utf8_lossy(&old_start.stderr));
    let old_start: Value = serde_json::from_slice(&old_start.stdout).unwrap();
    let old_pid = old_start["pid"].as_u64().unwrap();

    let new_start = env
        .std_command_for(&new_binary)
        .current_dir(env.workspace())
        .args(["start", "--instance", instance])
        .output()
        .unwrap();
    assert!(new_start.status.success(), "{}", String::from_utf8_lossy(&new_start.stderr));
    let new_start: Value = serde_json::from_slice(&new_start.stdout).unwrap();
    let new_pid = new_start["pid"].as_u64().unwrap();

    assert_eq!(new_start["started"], true);
    assert_ne!(new_pid, old_pid);
    let status = env
        .std_command_for(&new_binary)
        .args(["status", "--instance", instance])
        .output()
        .unwrap();
    assert!(status.status.success(), "{}", String::from_utf8_lossy(&status.stderr));
    let status: Value = serde_json::from_slice(&status.stdout).unwrap();
    assert_eq!(status["workerSha256"], new_sha);

    env.std_command_for(&new_binary)
        .args(["stop", "--instance", instance])
        .status()
        .unwrap();
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
                "minProtocolVersion": 4,
                "maxProtocolVersion": 4,
                "clientName": "portable-devshell",
                "clientVersion": "0.1.0"
            }
        }),
    );
    assert_eq!(handshake["type"], "response");
    assert_eq!(handshake["ok"], true);
    assert_eq!(handshake["result"]["protocolVersion"], 4);
    assert_eq!(
        handshake["result"]["workerVersion"],
        env!("CARGO_PKG_VERSION")
    );
    assert!(handshake["result"]["workerSha256"].is_null());
    assert_eq!(handshake["result"]["workspace"], env.protocol_workspace());
    assert_eq!(
        handshake["result"]["skillsDirectory"],
        env.protocol_skills_directory()
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
    let mut expected_tools = vec![
        "artifact_read",
        "bash_run",
        "file_edit",
        "file_find",
        "file_info",
        "file_read",
        "file_search",
    ];
    if cfg!(unix)
        && Command::new("tmux")
            .arg("-V")
            .output()
            .is_ok_and(|output| output.status.success())
    {
        expected_tools.extend([
            "tmux_close",
            "tmux_create",
            "tmux_input",
            "tmux_inspect",
            "tmux_list",
            "tmux_read",
            "tmux_run",
        ]);
    }
    assert_eq!(
        catalog
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        expected_tools
    );
    for tool in catalog {
        assert!(tool["description"].is_string());
        assert!(tool["inputSchema"].is_object());
        assert!(tool["outputSchema"].is_object());
        let serialized = serde_json::to_string(tool).unwrap();
        assert!(
            !serialized.contains("\"format\":\"uint8\""),
            "{} contains uint8: {serialized}",
            tool["name"]
        );
        assert!(
            !serialized.contains("\"format\":\"int64\""),
            "{} contains int64: {serialized}",
            tool["name"]
        );
        let required_capabilities = tool["requiredCapabilities"].as_array().unwrap();
        assert!(!required_capabilities.is_empty());
        assert!(
            required_capabilities.iter().all(|capability| matches!(
                capability.as_str(),
                Some("read" | "write" | "execute")
            ))
        );
    }
    let bash_schema = catalog
        .iter()
        .find(|tool| tool["name"] == "bash_run")
        .unwrap();
    assert_eq!(
        bash_schema["inputSchema"]["properties"]["timeoutMs"]["maximum"],
        100_000
    );

    #[cfg(unix)]
    let command = "printf ready";
    #[cfg(windows)]
    let command = "[Console]::Out.Write('ready')";

    let bash_run = env.rpc(
        instance,
        &serde_json::json!({
            "type": "request",
            "id": "3",
            "method": "bash_run",
            "params": {
                "command": command
            },
            "context": { "workspace": env.workspace() }
        }),
    );
    assert_eq!(bash_run["ok"], true);
    assert_eq!(bash_run["result"]["exitCode"], 0);
    assert_eq!(bash_run["result"]["termination"], "exited");
    assert_eq!(bash_run["result"]["stdoutTruncated"], false);
    assert_eq!(bash_run["result"]["stderrTruncated"], false);
    assert_eq!(bash_run["result"]["stdout"], "ready");
    assert!(bash_run["result"].get("timedOut").is_none());
    assert!(bash_run["result"].get("artifactWarnings").is_none());

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
                "maxProtocolVersion": 2
            }
        }),
    );
    assert_eq!(handshake["ok"], false);
    assert_eq!(
        handshake["error"]["code"],
        "worker.protocolVersionUnsupported"
    );
    assert_eq!(handshake["error"]["retryable"], false);
    assert_eq!(handshake["error"]["details"]["workerProtocolVersion"], 3);

    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn bash_run_returns_success_for_timeout_and_capture_truncation() {
    let env = TestEnv::new();
    let instance = "aromatic-timeout";

    env.command()
        .current_dir(env.workspace())
        .args(["start", "--instance", instance])
        .assert()
        .success();

    #[cfg(unix)]
    let timeout_command = "sleep 1";
    #[cfg(windows)]
    let timeout_command = "Start-Sleep -Seconds 1";

    let timed_out = env.rpc(
        instance,
        &serde_json::json!({
            "type": "request",
            "id": "5",
            "method": "bash_run",
            "params": {
                "command": timeout_command,
                "timeoutMs": 10
            },
            "context": { "workspace": env.workspace() }
        }),
    );
    assert_eq!(timed_out["ok"], true);
    assert_eq!(timed_out["result"]["termination"], "timeout");
    assert_eq!(timed_out["result"]["timedOut"], true);
    assert!(timed_out["result"].get("exitCode").is_none());
    #[cfg(unix)]
    assert!(timed_out["result"]["termSignal"].as_i64().is_some());
    #[cfg(windows)]
    assert!(timed_out["result"].get("termSignal").is_none());
    assert!(timed_out["result"].get("artifactWarnings").is_none());

    let too_long = env.rpc(
        instance,
        &serde_json::json!({
            "type": "request",
            "id": "5-limit",
            "method": "bash_run",
            "params": {
                "command": "true",
                "timeoutMs": 100001
            },
            "context": { "workspace": env.workspace() }
        }),
    );
    assert_eq!(too_long["ok"], false);
    assert_eq!(too_long["error"]["code"], "tool.invalidArguments");
    assert!(
        too_long["error"]["message"]
            .as_str()
            .unwrap()
            .contains("tmux_run")
    );

    #[cfg(unix)]
    let output_command = "awk 'BEGIN { for (i = 0; i < 2000; i++) printf \"x\" }'";
    #[cfg(windows)]
    let output_command = "[Console]::Out.Write([string]::new([char]'x', 2000))";

    let output_limited = env.rpc(
        instance,
        &serde_json::json!({
            "type": "request",
            "id": "6",
            "method": "bash_run",
            "params": {
                "command": output_command,
                "maxCaptureBytes": 128
            },
            "context": { "workspace": env.workspace() }
        }),
    );
    assert_eq!(output_limited["ok"], true);
    assert_eq!(output_limited["result"]["termination"], "exited");
    assert_eq!(output_limited["result"]["stdoutTruncated"], true);
    assert_eq!(output_limited["result"]["stderrTruncated"], false);
    assert!(output_limited["result"].get("timedOut").is_none());
    assert!(output_limited["result"].get("artifactWarnings").is_none());
    assert!(output_limited["result"].get("stderrArtifact").is_none());
    let handle = output_limited["result"]["stdoutArtifact"]["handle"]
        .as_str()
        .expect("truncated stdout must expose an artifact handle");
    assert_eq!(
        output_limited["result"]["stdoutArtifact"]["sourceBytes"],
        2000
    );
    assert_eq!(
        output_limited["result"]["stdoutArtifact"]["storedBytes"],
        2000
    );
    assert_eq!(
        output_limited["result"]["stdoutArtifact"]["artifactTruncated"],
        false
    );

    let first = env.rpc(
        instance,
        &serde_json::json!({
            "type": "request",
            "id": "7",
            "method": "artifact_read",
            "params": {
                "handle": handle,
                "maxBytes": 1000
            },
            "context": { "workspace": env.workspace() }
        }),
    );
    assert_eq!(first["ok"], true, "{first}");
    assert_eq!(first["result"]["returnedBytes"], 1000);
    assert_eq!(first["result"]["eof"], false);
    assert_eq!(first["result"]["nextOffsetBytes"], 1000);

    let second = env.rpc(
        instance,
        &serde_json::json!({
            "type": "request",
            "id": "8",
            "method": "artifact_read",
            "params": {
                "handle": handle,
                "offsetBytes": first["result"]["nextOffsetBytes"],
                "maxBytes": 2000
            },
            "context": { "workspace": env.workspace() }
        }),
    );
    assert_eq!(second["ok"], true, "{second}");
    assert_eq!(second["result"]["returnedBytes"], 1000);
    assert_eq!(second["result"]["eof"], true);
    assert!(second["result"].get("nextOffsetBytes").is_none());
    let restored = format!(
        "{}{}",
        first["result"]["content"].as_str().unwrap(),
        second["result"]["content"].as_str().unwrap()
    );
    assert_eq!(restored, "x".repeat(2000));

    #[cfg(unix)]
    let compact_command = "printf compact";
    #[cfg(windows)]
    let compact_command = "[Console]::Out.Write('compact')";

    let compact = env.rpc(
        instance,
        &serde_json::json!({
            "type": "request",
            "id": "9",
            "method": "bash_run",
            "params": { "command": compact_command },
            "context": { "workspace": env.workspace() }
        }),
    );
    assert_eq!(compact["ok"], true, "{compact}");
    assert!(compact["result"].get("stdoutArtifact").is_none());
    assert!(compact["result"].get("stderrArtifact").is_none());

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
fn dropping_test_env_terminates_workers_started_inside_it() {
    let env = TestEnv::new();
    let instance = "aromatic-drop-cleanup";
    let started = env.json_command(&["start", "--instance", instance]);
    let pid = started["pid"].as_i64().expect("started worker pid") as i32;

    drop(env);

    let cleaned = process_exits_within(pid, Duration::from_secs(2));
    if !cleaned {
        force_terminate_process(pid);
        assert!(
            process_exits_within(pid, Duration::from_secs(5)),
            "failed to clean leaked worker daemon {pid} after the harness assertion"
        );
    }
    assert!(cleaned, "dropping TestEnv leaked worker daemon {pid}");
}

#[test]
fn independent_test_envs_isolate_same_named_worker_lifecycles() {
    let first = TestEnv::new();
    let second = TestEnv::new();
    let instance = "aromatic-test-env-isolation";

    let first_started = first.json_command(&["start", "--instance", instance]);
    let second_started = second.json_command(&["start", "--instance", instance]);
    assert_ne!(first_started["pid"], second_started["pid"]);

    first.json_command(&["stop", "--instance", instance]);
    let second_status = second.json_command(&["status", "--instance", instance]);
    assert_eq!(second_status["running"], true, "{second_status}");
    second.json_command(&["stop", "--instance", instance]);
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

    let missing_tool = env.rpc(
        instance,
        &serde_json::json!({
            "type": "request",
            "id": "bad-3",
            "method": "missing_tool",
            "params": {}
        }),
    );
    assert_eq!(missing_tool["ok"], false);
    assert_eq!(missing_tool["error"]["code"], "tool.notFound");

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
fn workspace_security_mode_rejects_absolute_bash_cwd() {
    let env = TestEnv::new();
    let instance = "aromatic-secure";
    let outside = env.home().join("outside-bash");
    fs::create_dir_all(&outside).unwrap();

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
                "cwd": outside.to_string_lossy()
            },
            "context": { "workspace": env.workspace() }
        }),
    );
    assert_eq!(escaped["ok"], false);
    assert_eq!(escaped["error"]["code"], "security.denied");

    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn workspace_security_mode_rejects_absolute_terminal_cwd() {
    let env = TestEnv::new();
    let instance = "aromatic-secure-terminal";
    let outside = env.home().join("outside-terminal");
    fs::create_dir_all(&outside).unwrap();

    env.workspace_mode_command()
        .current_dir(env.workspace())
        .args(["start", "--instance", instance])
        .assert()
        .success();

    let escaped = env.rpc(
        instance,
        &serde_json::json!({
            "type": "request",
            "id": "terminal-security",
            "method": "terminal.open",
            "params": {
                "cols": 80,
                "rows": 24,
                "cwd": outside.to_string_lossy(),
                "command": "exit"
            }
        }),
    );
    assert_eq!(escaped["ok"], false);
    assert_eq!(escaped["error"]["code"], "security.denied");

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
    #[cfg(unix)]
    {
        fs::create_dir_all(env.socket_file(instance).parent().unwrap()).unwrap();
        fs::write(env.socket_file(instance), b"stale").unwrap();
    }

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
    assert!(running_status["workerSha256"].is_null());

    env.json_command(&["stop", "--instance", instance]);
}

#[cfg(unix)]
#[test]
fn start_terminates_an_unresponsive_live_daemon_before_replacing_it() {
    let env = TestEnv::new();
    let instance = "aromatic-stale-start";

    env.command()
        .current_dir(env.workspace())
        .args(["start", "--instance", instance])
        .assert()
        .success();

    let pid_path = env.instance_root(instance).join("state/worker.pid");
    let old_pid: i32 = fs::read_to_string(&pid_path)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    fs::remove_file(env.socket_file(instance)).unwrap();

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
    let new_pid = restarted["pid"].as_i64().unwrap() as i32;

    assert_ne!(new_pid, old_pid);
    wait_until_process_exits(old_pid);
    assert!(process_is_running(new_pid));

    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn concurrent_stop_waits_for_start_to_finish() {
    let env = TestEnv::new();
    let instance = "aromatic-start-stop";
    let start = env
        .std_command()
        .current_dir(env.workspace())
        .env("DEVSHELL_WORKER_TEST_DELAY_READY_MS", "300")
        .env("DEVSHELL_WORKER_TEST_READY_TIMEOUT_MS", "2000")
        .args(["start", "--instance", instance])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    wait_until_path_exists(&env.instance_root(instance).join("state/worker.pid"));
    let stopped = env
        .command()
        .args(["stop", "--instance", instance])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let stopped: Value = serde_json::from_slice(&stopped).unwrap();
    let start_output = start.wait_with_output().unwrap();

    assert!(
        start_output.status.success(),
        "{}",
        String::from_utf8_lossy(&start_output.stderr)
    );
    assert_eq!(stopped["stopped"], true);
    assert!(
        !env.instance_root(instance)
            .join("state/worker.pid")
            .exists()
    );
    #[cfg(unix)]
    assert!(!env.socket_file(instance).exists());
}

#[cfg(unix)]
#[test]
fn stop_terminates_unresponsive_live_daemon_before_clearing_runtime_files() {
    let env = TestEnv::new();
    let instance = "aromatic-unresponsive";

    env.command()
        .current_dir(env.workspace())
        .args(["start", "--instance", instance])
        .assert()
        .success();

    let pid_path = env.instance_root(instance).join("state/worker.pid");
    let pid: i32 = fs::read_to_string(&pid_path)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    fs::remove_file(env.socket_file(instance)).unwrap();

    let stale = env.json_command(&["status", "--instance", instance]);
    assert_eq!(stale["state"], "stale");
    assert!(process_is_running(pid));

    let stopped = env.json_command(&["stop", "--instance", instance]);
    assert_eq!(stopped["stopped"], true);
    wait_until_process_exits(pid);
    assert!(!pid_path.exists());
    #[cfg(unix)]
    assert!(!env.socket_file(instance).exists());
}

#[test]
fn stop_force_terminates_a_responsive_daemon_when_stop_rpc_fails() {
    let env = TestEnv::new();
    let instance = "aromatic-stop-rpc-failure";

    env.command_with_env("DEVSHELL_WORKER_TEST_FAIL_STOP", "1")
        .current_dir(env.workspace())
        .args(["start", "--instance", instance])
        .assert()
        .success();

    let pid_path = env.instance_root(instance).join("state/worker.pid");
    let pid: i32 = fs::read_to_string(&pid_path)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let running = env.json_command(&["status", "--instance", instance]);
    assert_eq!(running["state"], "running");

    let stopped = env.json_command(&["stop", "--instance", instance]);
    assert_eq!(stopped["stopped"], true);
    wait_until_process_exits(pid);
    assert!(!pid_path.exists());
    #[cfg(unix)]
    assert!(!env.socket_file(instance).exists());
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
    #[cfg(unix)]
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
    #[cfg(unix)]
    assert!(!env.socket_file(loop_fail).exists());
}

#[test]
fn readiness_timeout_terminates_the_spawned_daemon_and_cleans_runtime_files() {
    let env = TestEnv::new();
    let instance = "aromatic-ready-timeout";
    let start = env
        .std_command()
        .current_dir(env.workspace())
        .env("DEVSHELL_WORKER_TEST_DELAY_READY_MS", "1000")
        .env("DEVSHELL_WORKER_TEST_READY_TIMEOUT_MS", "100")
        .args(["start", "--instance", instance])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let pid_path = env.instance_root(instance).join("state/worker.pid");

    wait_until_path_exists(&pid_path);
    let daemon_pid: i32 = fs::read_to_string(&pid_path)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let output = start.wait_with_output().unwrap();

    assert!(!output.status.success());
    wait_until_process_exits(daemon_pid);
    assert!(!pid_path.exists());
    #[cfg(unix)]
    assert!(!env.socket_file(instance).exists());
}

#[test]
fn long_tool_call_does_not_block_control_requests_on_the_same_rpc_connection() {
    let env = TestEnv::new();
    let instance = "aromatic-concurrent-rpc";

    env.command()
        .current_dir(env.workspace())
        .args(["start", "--instance", instance])
        .assert()
        .success();

    let mut bridge = env
        .std_command()
        .args(["rpc", "--instance", instance])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = bridge.stdin.take().unwrap();
    let mut stdout = bridge.stdout.take().unwrap();

    #[cfg(unix)]
    let long_command = "sleep 2; printf done";
    #[cfg(windows)]
    let long_command = "Start-Sleep -Seconds 2; [Console]::Out.Write('done')";

    write_rpc_frame(
        &mut stdin,
        &serde_json::json!({
            "type": "request",
            "id": "long-tool",
            "method": "bash_run",
            "params": {
                "command": long_command,
                "timeoutMs": 5000
            },
            "context": { "workspace": env.workspace() }
        }),
    );
    write_rpc_frame(
        &mut stdin,
        &serde_json::json!({
            "type": "request",
            "id": "ping-during-tool",
            "method": "worker.ping",
            "params": {}
        }),
    );

    let first = read_rpc_frame(&mut stdout);
    assert_eq!(first["id"], "ping-during-tool");
    assert_eq!(first["ok"], true);

    let second = read_rpc_frame(&mut stdout);
    assert_eq!(second["id"], "long-tool");
    assert_eq!(second["ok"], true);
    assert_eq!(second["result"]["stdout"], "done");

    drop(stdin);
    bridge.wait().unwrap();
    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn persistent_rpc_bridge_forwards_terminal_notifications() {
    let env = TestEnv::new();
    let instance = "aromatic-terminal-notifications";

    env.command()
        .current_dir(env.workspace())
        .args(["start", "--instance", instance])
        .assert()
        .success();

    let mut bridge = env
        .std_command()
        .args(["rpc", "--instance", instance])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = bridge.stdin.take().unwrap();
    let mut stdout = bridge.stdout.take().unwrap();
    let (frames, received) = mpsc::channel();
    let reader = thread::spawn(move || {
        while let Ok(frame) = try_read_rpc_frame(&mut stdout) {
            if frames.send(frame).is_err() {
                return;
            }
        }
    });

    write_rpc_frame(
        &mut stdin,
        &serde_json::json!({
            "type": "request",
            "id": "terminal-open",
            "method": "terminal.open",
            "params": { "cols": 80, "rows": 24 }
        }),
    );
    let opened = receive_response(&received, "terminal-open");
    assert_eq!(opened["ok"], true, "{opened}");
    let terminal_id = opened["result"]["terminalId"].as_str().unwrap();
    let generation = opened["result"]["generation"].as_u64().unwrap();
    let version = opened["result"]["version"].as_u64().unwrap();

    #[cfg(unix)]
    let command = "printf '%s\\n' 'forward-notification-ready'\\r";
    #[cfg(windows)]
    let command = "powershell.exe -NoLogo -NoProfile -NonInteractive -Command \"[Console]::WriteLine('forward-notification-ready')\"\\r";
    write_rpc_frame(
        &mut stdin,
        &serde_json::json!({
            "type": "request",
            "id": "terminal-write",
            "method": "terminal.write",
            "params": {
                "clientSeq": 1,
                "generation": generation,
                "terminalId": terminal_id,
                "version": version,
                "data": BASE64.encode(command.as_bytes())
            }
        }),
    );

    let deadline = Instant::now() + Duration::from_secs(5);
    let mut write_accepted = false;
    let mut output = String::new();
    while Instant::now() < deadline
        && (!write_accepted || !output.contains("forward-notification-ready"))
    {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let frame = received
            .recv_timeout(remaining)
            .expect("persistent RPC bridge did not forward terminal response/notification");
        if frame["type"] == "response" && frame["id"] == "terminal-write" {
            assert_eq!(frame["ok"], true, "{frame}");
            write_accepted = true;
        }
        if frame["type"] == "notification" && frame["method"] == "terminal.output" {
            if let Some(data) = frame["params"]["dataBase64"].as_str() {
                output.push_str(&String::from_utf8_lossy(&BASE64.decode(data).unwrap()));
            }
        }
    }
    assert!(write_accepted, "terminal.write response was not forwarded");
    assert!(
        output.contains("forward-notification-ready"),
        "terminal output was not forwarded: {output:?}"
    );

    drop(stdin);
    bridge.kill().ok();
    bridge.wait().ok();
    drop(received);
    reader.join().unwrap();
    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn tool_call_cancel_terminates_a_running_bash_process_group() {
    let env = TestEnv::new();
    let instance = "aromatic-cancel-rpc";
    let started_marker = env.workspace().join("cancelled-command-started");
    let marker = env.workspace().join("cancelled-command-finished");

    env.command()
        .current_dir(env.workspace())
        .args(["start", "--instance", instance])
        .assert()
        .success();

    let mut bridge = env
        .std_command()
        .args(["rpc", "--instance", instance])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = bridge.stdin.take().unwrap();
    let mut stdout = bridge.stdout.take().unwrap();

    #[cfg(unix)]
    let cancel_command = format!(
        "printf started > {}; sleep 5; printf done > {}",
        started_marker.display(),
        marker.display()
    );
    #[cfg(windows)]
    let cancel_command = format!(
        "[System.IO.File]::WriteAllText('{}', 'started'); Start-Sleep -Seconds 5; [System.IO.File]::WriteAllText('{}', 'done')",
        started_marker.display().to_string().replace('\'', "''"),
        marker.display().to_string().replace('\'', "''")
    );

    write_rpc_frame(
        &mut stdin,
        &serde_json::json!({
            "type": "request",
            "id": "cancel-me",
            "method": "bash_run",
            "params": {
                "command": cancel_command,
                "timeoutMs": 10000
            },
            "context": {
                "ctxId": "ctx-cancel",
                "requestId": "mcp-cancel-me",
                "source": "mcp",
                "workspace": env.workspace()
            }
        }),
    );
    wait_until_path_exists(&started_marker);
    write_rpc_frame(
        &mut stdin,
        &serde_json::json!({
            "type": "request",
            "id": "cancel-control",
            "method": "tool.call.cancel",
            "params": {
                "rpcRequestId": "cancel-me",
                "ctxId": "ctx-cancel",
                "reason": "client timeout"
            }
        }),
    );

    let responses = [read_rpc_frame(&mut stdout), read_rpc_frame(&mut stdout)];
    let cancel_response = responses
        .iter()
        .find(|response| response["id"] == "cancel-control")
        .expect("cancel acknowledgement response");
    assert_eq!(cancel_response["ok"], true, "{cancel_response}");
    assert_eq!(
        cancel_response["result"]["cancelled"], true,
        "{cancel_response}"
    );

    let call_response = responses
        .iter()
        .find(|response| response["id"] == "cancel-me")
        .expect("cancelled tool call response");
    assert_eq!(call_response["ok"], false, "{call_response}");
    assert_eq!(
        call_response["error"]["code"], "tool.cancelled",
        "{call_response}"
    );
    assert!(!marker.exists());

    drop(stdin);
    bridge.wait().unwrap();
    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn internal_artifact_payload_rpc_is_persistent_and_not_listed_as_a_tool() {
    let env = TestEnv::new();
    let instance = "artifact-payload";
    fs::write(env.workspace().join("payload.txt"), b"rpc payload").unwrap();
    env.command()
        .current_dir(env.workspace())
        .args(["start", "--instance", instance])
        .assert()
        .success();

    let tools = env.rpc(
        instance,
        &serde_json::json!({
            "type": "request",
            "id": "payload-tools",
            "method": "tools.list",
            "params": {}
        }),
    );
    let names = tools["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert!(!names.contains(&"artifact.payload.open"));
    assert!(!names.contains(&"artifact.payload.read"));
    assert!(!names.contains(&"artifact.payload.close"));
    assert!(!names.contains(&"artifact.receive.begin"));
    assert!(!names.contains(&"artifact.receive.write"));
    assert!(!names.contains(&"artifact.receive.finish"));
    assert!(!names.contains(&"artifact.receive.abort"));

    let expires_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis()
        + 60_000;
    let opened = env.rpc(
        instance,
        &serde_json::json!({
            "type": "request",
            "id": "payload-open",
            "method": "artifact.payload.open",
            "params": {
                "path": "./payload.txt",
                "expiresAtMs": expires_at_ms
            }
        }),
    );
    assert_eq!(opened["ok"], true, "{opened}");
    assert_eq!(opened["result"]["descriptor"]["type"], "file");
    let payload_id = opened["result"]["payloadId"].as_str().unwrap();

    let read = env.rpc(
        instance,
        &serde_json::json!({
            "type": "request",
            "id": "payload-read",
            "method": "artifact.payload.read",
            "params": {
                "payloadId": payload_id,
                "offsetBytes": 0,
                "maxBytes": 1024
            }
        }),
    );
    assert_eq!(read["ok"], true, "{read}");
    assert_eq!(read["result"]["content"], "cnBjIHBheWxvYWQ=");
    assert_eq!(read["result"]["eof"], true);

    let descriptor = opened["result"]["descriptor"].clone();
    let begun = env.rpc(
        instance,
        &serde_json::json!({
            "type": "request",
            "id": "receive-begin",
            "method": "artifact.receive.begin",
            "params": {
                "descriptor": descriptor,
                "overwrite": false,
                "targetPath": "./received.txt"
            }
        }),
    );
    assert_eq!(begun["ok"], true, "{begun}");
    let receive_id = begun["result"]["receiveId"].as_str().unwrap();
    let written = env.rpc(
        instance,
        &serde_json::json!({
            "type": "request",
            "id": "receive-write",
            "method": "artifact.receive.write",
            "params": {
                "receiveId": receive_id,
                "offsetBytes": 0,
                "content": read["result"]["content"]
            }
        }),
    );
    assert_eq!(written["ok"], true, "{written}");
    assert_eq!(written["result"]["nextOffsetBytes"], 11);
    let finished = env.rpc(
        instance,
        &serde_json::json!({
            "type": "request",
            "id": "receive-finish",
            "method": "artifact.receive.finish",
            "params": { "receiveId": receive_id }
        }),
    );
    assert_eq!(finished["ok"], true, "{finished}");
    assert_eq!(
        fs::read(env.workspace().join("received.txt")).unwrap(),
        b"rpc payload"
    );

    let closed = env.rpc(
        instance,
        &serde_json::json!({
            "type": "request",
            "id": "payload-close",
            "method": "artifact.payload.close",
            "params": { "payloadId": payload_id }
        }),
    );
    assert_eq!(closed["ok"], true, "{closed}");
    assert_eq!(closed["result"]["closed"], true);

    env.json_command(&["stop", "--instance", instance]);
}

fn receive_response(receiver: &mpsc::Receiver<Value>, id: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let frame = receiver
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("RPC response timeout");
        if frame["type"] == "response" && frame["id"] == id {
            return frame;
        }
    }
}

fn try_read_rpc_frame(reader: &mut impl Read) -> Result<Value, String> {
    let mut length = [0_u8; 4];
    reader
        .read_exact(&mut length)
        .map_err(|error| error.to_string())?;
    let mut payload = vec![0_u8; u32::from_be_bytes(length) as usize];
    reader
        .read_exact(&mut payload)
        .map_err(|error| error.to_string())?;
    serde_json::from_slice(&payload).map_err(|error| error.to_string())
}

fn write_rpc_frame(writer: &mut impl Write, value: &Value) {
    let payload = serde_json::to_vec(value).unwrap();
    writer
        .write_all(&(payload.len() as u32).to_be_bytes())
        .unwrap();
    writer.write_all(&payload).unwrap();
    writer.flush().unwrap();
}

fn read_rpc_frame(reader: &mut impl Read) -> Value {
    let mut length = [0_u8; 4];
    reader.read_exact(&mut length).unwrap();
    let mut payload = vec![0_u8; u32::from_be_bytes(length) as usize];
    reader.read_exact(&mut payload).unwrap();
    serde_json::from_slice(&payload).unwrap()
}

#[cfg(unix)]
fn process_is_running(pid: i32) -> bool {
    use nix::errno::Errno;
    use nix::sys::signal::kill;
    use nix::unistd::Pid;

    match kill(Pid::from_raw(pid), None) {
        Ok(()) | Err(Errno::EPERM) => true,
        Err(_) => false,
    }
}

#[cfg(windows)]
fn process_is_running(pid: i32) -> bool {
    let output = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output()
        .unwrap();
    String::from_utf8_lossy(&output.stdout).contains(&pid.to_string())
}

fn wait_until_process_exits(pid: i32) {
    assert!(
        process_exits_within(pid, Duration::from_secs(10)),
        "worker daemon process {pid} did not exit"
    );
}

fn process_exits_within(pid: i32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if !process_is_running(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    !process_is_running(pid)
}

#[cfg(unix)]
fn force_terminate_process(pid: i32) {
    use nix::sys::signal::{Signal, kill};
    use nix::unistd::Pid;

    let _ = kill(Pid::from_raw(pid), Signal::SIGKILL);
}

#[cfg(windows)]
fn force_terminate_process(pid: i32) {
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .status();
}

fn wait_until_path_exists(path: &std::path::Path) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if path.exists() {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("path did not appear: {}", path.display());
}
