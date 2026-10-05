mod support;
#[path = "support/endpoint.rs"]
mod endpoint;

use std::fs;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};

use serde_json::Value;
use support::TestEnv;
use endpoint::{TransportEndpointReader, TransportEndpointWriter};

#[test]
fn start_is_workspace_neutral_and_keeps_config_minimal() {
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
    assert!(start.get("workspace").is_none(), "{start}");

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
    assert!(status.get("workspace").is_none(), "{status}");

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
    assert!(
        old_start.status.success(),
        "{}",
        String::from_utf8_lossy(&old_start.stderr)
    );
    let old_start: Value = serde_json::from_slice(&old_start.stdout).unwrap();
    let old_pid = old_start["pid"].as_u64().unwrap();

    let new_start = env
        .std_command_for(&new_binary)
        .current_dir(env.workspace())
        .args(["start", "--instance", instance])
        .output()
        .unwrap();
    assert!(
        new_start.status.success(),
        "{}",
        String::from_utf8_lossy(&new_start.stderr)
    );
    let new_start: Value = serde_json::from_slice(&new_start.stdout).unwrap();
    let new_pid = new_start["pid"].as_u64().unwrap();

    assert_eq!(new_start["started"], true);
    assert_ne!(new_pid, old_pid);
    let status = env
        .std_command_for(&new_binary)
        .args(["status", "--instance", instance])
        .output()
        .unwrap();
    assert!(
        status.status.success(),
        "{}",
        String::from_utf8_lossy(&status.stderr)
    );
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
        "core",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": "1",
            "method": "worker.handshake",
            "message": {
                "protocolRange": { "min": "0.9.0", "max": "1.2.0" },
                "clientName": "portable-devshell",
                "clientVersion": "0.1.0"
            }
        }),
    );
    assert_eq!(handshake["type"], "reply");
    assert_eq!(handshake["type"], "reply");
    assert_eq!(handshake["message"]["protocolVersion"], "1.0.0");
    assert_eq!(
        handshake["message"]["workerVersion"],
        env!("CARGO_PKG_VERSION")
    );
    assert!(handshake["message"]["workerSha256"].is_null());
    assert!(
        handshake["message"].get("workspace").is_none(),
        "{handshake}"
    );
    assert!(
        handshake["message"].get("skillsDirectory").is_none(),
        "{handshake}"
    );
    assert!(handshake["message"].get("tools").is_none());

    let tools = env.rpc(
        instance,
        "tool",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": "2",
            "method": "tools.list",
            "message": {}
        }),
    );
    assert_eq!(tools["type"], "reply");
    let catalog = tools["message"]["tools"].as_array().unwrap();
    let mut expected_tools = vec![
        "bash_run",
        "file_edit",
        "file_glob",
        "file_grep",
        "file_read",
    ];
    if cfg!(windows)
        || (cfg!(unix)
            && Command::new("tmux")
                .arg("-V")
                .output()
                .is_ok_and(|output| output.status.success()))
    {
        expected_tools.extend([
            "tmux_input",
            "tmux_inspect",
            "tmux_manage",
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
    assert!(
        bash_schema["inputSchema"]["required"]
            .as_array()
            .is_some_and(|required| required.iter().any(|field| field == "timeoutMs"))
    );
    assert_eq!(
        bash_schema["inputSchema"]["properties"]["command"]["minLength"],
        1
    );
    if let Some(tmux_read_schema) = catalog.iter().find(|tool| tool["name"] == "tmux_read") {
        assert!(
            tmux_read_schema["outputSchema"]["properties"]
                .get("resume")
                .is_none()
        );
        assert!(
            tmux_read_schema["outputSchema"]["properties"]
                .get("timeout")
                .is_none()
        );
        let tmux_run_schema = catalog
            .iter()
            .find(|tool| tool["name"] == "tmux_run")
            .unwrap();
        assert!(
            tmux_run_schema["inputSchema"]["properties"]
                .get("resume")
                .is_none()
        );
        assert!(
            tmux_run_schema["outputSchema"]["properties"]
                .get("resume")
                .is_none()
        );
        assert!(tmux_run_schema["outputSchema"]["properties"]["timeout"].is_object());
        assert!(tmux_run_schema["outputSchema"]["properties"]["interrupted"].is_object());
    }
    let file_edit_schema = catalog
        .iter()
        .find(|tool| tool["name"] == "file_edit")
        .unwrap();
    assert_eq!(
        file_edit_schema["inputSchema"]["properties"]["changes"]["minLength"],
        1
    );
    let file_read_schema = catalog
        .iter()
        .find(|tool| tool["name"] == "file_read")
        .unwrap();
    assert_eq!(
        file_read_schema["inputSchema"]["required"],
        serde_json::json!(["files"])
    );
    assert!(file_read_schema["inputSchema"]["properties"]["files"].is_object());
    assert!(
        file_read_schema["inputSchema"]["properties"]
            .get("path")
            .is_none()
    );
    assert!(
        file_read_schema["inputSchema"]["properties"]
            .get("view")
            .is_none()
    );
    assert!(
        file_read_schema["inputSchema"]["properties"]
            .get("selector")
            .is_none()
    );
    assert_eq!(
        file_read_schema["inputSchema"]["properties"]["files"]["minItems"],
        1
    );
    assert!(file_read_schema["outputSchema"]["properties"]["files"].is_object());
    let file_glob_schema = catalog
        .iter()
        .find(|tool| tool["name"] == "file_glob")
        .unwrap();
    assert_eq!(
        file_glob_schema["inputSchema"]["properties"]["patterns"]["minItems"],
        1
    );
    assert_eq!(
        file_glob_schema["inputSchema"]["properties"]["cursor"]["minLength"],
        1
    );
    let file_grep_schema = catalog
        .iter()
        .find(|tool| tool["name"] == "file_grep")
        .unwrap();
    assert_eq!(
        file_grep_schema["inputSchema"]["properties"]["pattern"]["minLength"],
        1
    );
    assert_eq!(
        file_grep_schema["inputSchema"]["properties"]["paths"]["minItems"],
        1
    );
    assert_eq!(
        file_grep_schema["inputSchema"]["properties"]["cursor"]["minLength"],
        1
    );
    for retired in ["file_find", "file_info", "file_search"] {
        assert!(catalog.iter().all(|tool| tool["name"] != retired));
    }

    if expected_tools.contains(&"tmux_input") {
        for name in ["tmux_input", "tmux_inspect", "tmux_manage"] {
            let tool = catalog.iter().find(|tool| tool["name"] == name).unwrap();
            assert_eq!(
                tool["inputSchema"]["type"], "object",
                "{name}: {}",
                tool["inputSchema"]
            );
            assert!(
                tool["inputSchema"].get("anyOf").is_none(),
                "{name}: {}",
                tool["inputSchema"]
            );
            assert!(
                tool["inputSchema"].get("oneOf").is_none(),
                "{name}: {}",
                tool["inputSchema"]
            );
        }
        let tmux_input = catalog
            .iter()
            .find(|tool| tool["name"] == "tmux_input")
            .unwrap();
        for property in ["task", "pane", "input", "timeMs", "line"] {
            assert!(
                tmux_input["inputSchema"]["properties"]
                    .get(property)
                    .is_some(),
                "tmux_input missing {property}: {}",
                tmux_input["inputSchema"]
            );
        }
        assert_eq!(
            tmux_input["inputSchema"]["required"],
            serde_json::json!(["input"])
        );
        let tmux_run = catalog
            .iter()
            .find(|tool| tool["name"] == "tmux_run")
            .unwrap();
        assert!(
            tmux_run["inputSchema"]["properties"]
                .get("timeMs")
                .is_none()
        );
        let tmux_run_description = tmux_run["description"].as_str().unwrap();
        assert!(tmux_run_description.contains("Start long-running or PTY/interactive work"));
        assert!(tmux_run_description.contains("Prefer wait=block"));
        assert!(tmux_run_description.contains("tmux_read/tmux_input"));
        assert_eq!(
            tmux_run["_meta"]["devshell"]["mcp"]["title"],
            "Run tmux task"
        );
        assert_eq!(
            tmux_run["_meta"]["devshell"]["mcp"]["hiddenInputProperties"],
            serde_json::json!(["consumeOutput"])
        );
        assert_eq!(
            tmux_run["inputSchema"]["properties"]["wait"]["description"],
            "Wait strategy. Defaults to nonblock."
        );
        assert_eq!(
            tmux_run["inputSchema"]["properties"]["timeout"]["description"],
            "Total deadline from task start for wait=block. Reaching it does not stop the task."
        );
        let bash_run = catalog
            .iter()
            .find(|tool| tool["name"] == "bash_run")
            .unwrap();
        let bash_description = bash_run["description"].as_str().unwrap();
        assert!(bash_description.contains("tmux_run"));
        assert!(bash_description.contains("file_read"));
        assert_eq!(
            bash_run["_meta"]["devshell"]["mcp"]["title"],
            "Run shell command"
        );
        assert!(
            !bash_run["inputSchema"]["properties"]["timeoutMs"]["description"]
                .as_str()
                .unwrap_or("")
                .contains("tmux_run")
        );
        let tmux_manage = catalog
            .iter()
            .find(|tool| tool["name"] == "tmux_manage")
            .unwrap();
        assert_eq!(
            tmux_manage["inputSchema"]["required"],
            serde_json::json!(["command"])
        );
        for property in ["command", "name", "cwd", "task", "pane", "force"] {
            assert!(
                tmux_manage["inputSchema"]["properties"]
                    .get(property)
                    .is_some(),
                "tmux_manage missing {property}: {}",
                tmux_manage["inputSchema"]
            );
        }
        for retired in ["tmux_list", "tmux_create", "tmux_close"] {
            assert!(catalog.iter().all(|tool| tool["name"] != retired));
        }
    }

    #[cfg(unix)]
    let command = "printf ready";
    #[cfg(windows)]
    let command = "[Console]::Out.Write('ready')";

    let missing_workspace = env.rpc(
        instance,
        "tool",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": "missing-workspace",
            "method": "bash_run",
            "message": { "input": { "command": command, "timeoutMs": 30_000 }, "context": { "ctxId": "ctx-explicit", "source": "mcp" } }
        }),
    );
    assert_eq!(missing_workspace["type"], "error", "{missing_workspace}");
    assert_eq!(missing_workspace["error"]["code"], "rpc.invalidContext");

    let bash_run = env.rpc(
        instance,
        "tool",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": "3",
            "method": "bash_run",
            "message": { "input": {
                "command": command,
                "timeoutMs": 30_000
            }, "context": { "workspace": env.workspace() } }
        }),
    );
    assert_eq!(bash_run["type"], "reply");
    assert_eq!(bash_run["message"]["exitCode"], 0);
    assert_eq!(bash_run["message"]["termination"], "exited");
    assert_eq!(bash_run["message"]["stdoutTruncated"], false);
    assert_eq!(bash_run["message"]["stderrTruncated"], false);
    assert_eq!(bash_run["message"]["stdout"], "ready");
    assert!(bash_run["message"].get("timedOut").is_none());
    assert!(bash_run["message"].get("artifactWarnings").is_none());

    let stopped = env.json_command(&["stop", "--instance", instance]);
    assert_eq!(stopped["stopped"], true);
    let status = env.json_command(&["status", "--instance", instance]);
    assert_eq!(status["state"], "stopped");
    assert_eq!(status["running"], false);
    assert!(status.get("workspace").is_none(), "{status}");
}

#[test]
fn bash_run_accepts_bare_workspace_relative_cwd() {
    let env = TestEnv::new();
    let instance = "aromatic-bash-bare-cwd";
    fs::write(env.workspace().join("root-marker.txt"), "root").unwrap();
    fs::create_dir_all(env.workspace().join("extensions/stats")).unwrap();
    fs::write(
        env.workspace().join("extensions/stats/marker.txt"),
        "inside",
    )
    .unwrap();

    env.command()
        .current_dir(env.workspace())
        .args(["start", "--instance", instance])
        .assert()
        .success();

    #[cfg(unix)]
    let command = "test -f marker.txt && printf ready";
    #[cfg(windows)]
    let command = "if (Test-Path marker.txt) { [Console]::Out.Write('ready') } else { exit 7 }";

    let response = env.rpc(
        instance,
        "tool",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": "bare-cwd",
            "method": "bash_run",
            "message": { "input": {
                "command": command,
                "cwd": "extensions/stats",
                "timeoutMs": 30_000
            }, "context": {
                "ctxId": "ctx-bare-cwd",
                "source": "mcp",
                "workspace": env.workspace()
            } }
        }),
    );

    assert_eq!(response["type"], "reply", "{response}");
    assert_eq!(response["message"]["exitCode"], 0, "{response}");
    assert_eq!(response["message"]["stdout"], "ready", "{response}");

    #[cfg(unix)]
    let root_command = "test -f root-marker.txt && printf root";
    #[cfg(windows)]
    let root_command =
        "if (Test-Path root-marker.txt) { [Console]::Out.Write('root') } else { exit 7 }";
    let root = env.rpc(
        instance,
        "tool",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": "dot-cwd",
            "method": "bash_run",
            "message": { "input": {
                "command": root_command,
                "cwd": ".",
                "timeoutMs": 30_000
            }, "context": {
                "ctxId": "ctx-dot-cwd",
                "source": "mcp",
                "workspace": env.workspace()
            } }
        }),
    );
    assert_eq!(root["type"], "reply", "{root}");
    assert_eq!(root["message"]["stdout"], "root", "{root}");

    let home = env.rpc(
        instance,
        "tool",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": "home-cwd",
            "method": "bash_run",
            "message": { "input": {
                "command": command,
                "cwd": "~/extensions/stats",
                "timeoutMs": 30_000
            }, "context": {
                "ctxId": "ctx-home-cwd",
                "source": "mcp",
                "workspace": env.workspace()
            } }
        }),
    );
    assert_eq!(home["type"], "error", "{home}");
    assert_eq!(home["error"]["code"], "bash.invalidCwd", "{home}");

    env.json_command(&["stop", "--instance", instance]);
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
        "core",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": "4",
            "method": "worker.handshake",
            "message": {
                "protocolRange": { "min": "1.1.0", "max": "2.0.0" }
            }
        }),
    );
    assert_eq!(handshake["type"], "error");
    assert_eq!(
        handshake["error"]["code"],
        "worker.protocolVersionUnsupported"
    );
    assert_eq!(handshake["error"]["retryable"], false);
    assert_eq!(
        handshake["error"]["details"]["workerProtocolVersion"],
        "1.0.0"
    );

    env.json_command(&["stop", "--instance", instance]);
}


#[cfg(unix)]
#[test]
fn workspace_temporary_storage_migrates_to_managed_scratch_and_recovers_after_workspace_loss() {
    let env = TestEnv::new();
    let instance = "aromatic-context-temp";
    let context_temp_link = env.context_temp_link();
    fs::create_dir_all(&context_temp_link).unwrap();
    fs::write(context_temp_link.join("legacy-data"), b"discardable").unwrap();

    env.command()
        .current_dir(env.workspace())
        .args(["start", "--instance", instance])
        .assert()
        .success();

    let prepare = |id: &str| {
        env.rpc(
        instance,
        "core",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": id,
            "method": "workspace.prepare",
            "message": { "workspace": env.protocol_workspace() }
        }),
    )
    };

    let first = prepare("workspace-prepare-1");
    assert_eq!(first["type"], "reply");
    assert!(
        fs::symlink_metadata(&context_temp_link)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    let target = fs::read_link(&context_temp_link).unwrap();
    let first_temporary =
        std::path::PathBuf::from(first["message"]["temporaryDirectory"].as_str().unwrap());
    assert!(first_temporary.starts_with(&context_temp_link));
    assert!(
        first_temporary
            .canonicalize()
            .unwrap()
            .starts_with(target.canonicalize().unwrap())
    );

    let workspace_scratch = first_temporary.parent().unwrap().canonicalize().unwrap();
    fs::remove_dir_all(workspace_scratch).unwrap();
    let second = prepare("workspace-prepare-2");
    assert_eq!(second["type"], "reply");
    let second_temporary =
        std::path::PathBuf::from(second["message"]["temporaryDirectory"].as_str().unwrap());
    assert!(second_temporary.starts_with(&context_temp_link));
    assert!(
        second_temporary
            .canonicalize()
            .unwrap()
            .starts_with(target.canonicalize().unwrap())
    );

    env.json_command(&["stop", "--instance", instance]);
}

#[cfg(target_os = "linux")]
#[test]
fn workspace_temporary_storage_without_xdg_runtime_uses_tmpfs() {
    let env = TestEnv::new();
    let instance = "aromatic-context-temp-fallback";
    env.command_without_runtime_dir()
        .current_dir(env.workspace())
        .args(["start", "--instance", instance])
        .assert()
        .success();

    let prepared = env.rpc_without_runtime_dir(
        instance,
        "core",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": "workspace-prepare-no-xdg",
            "method": "workspace.prepare",
            "message": { "workspace": env.protocol_workspace() }
        }),
    );
    assert_eq!(prepared["type"], "reply");
    let target = fs::read_link(env.context_temp_link()).unwrap();
    assert!(target.starts_with("/tmp") || target.starts_with("/dev/shm"));
    assert_eq!(
        nix::sys::statfs::statfs(&target).unwrap().filesystem_type(),
        nix::sys::statfs::TMPFS_MAGIC
    );
    assert!(
        std::path::Path::new(prepared["message"]["temporaryDirectory"].as_str().unwrap())
            .canonicalize()
            .unwrap()
            .starts_with(target.canonicalize().unwrap())
    );

    env.command_without_runtime_dir()
        .args(["stop", "--instance", instance])
        .assert()
        .success();
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

    let missing_timeout = env.rpc(
        instance,
        "tool",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": "5-required",
            "method": "bash_run",
            "message": { "input": { "command": "true" }, "context": { "workspace": env.workspace() } }
        }),
    );
    assert_eq!(missing_timeout["type"], "error", "{missing_timeout}");
    assert_eq!(missing_timeout["error"]["code"], "tool.invalidArguments");
    assert!(
        missing_timeout["error"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("timeoutMs"))
    );

    let timed_out = env.rpc(
        instance,
        "tool",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": "5",
            "method": "bash_run",
            "message": { "input": {
                "command": timeout_command,
                "timeoutMs": 10
            }, "context": { "workspace": env.workspace() } }
        }),
    );
    assert_eq!(timed_out["type"], "reply");
    assert_eq!(timed_out["message"]["termination"], "timeout");
    assert_eq!(timed_out["message"]["timedOut"], true);
    assert!(timed_out["message"].get("exitCode").is_none());
    #[cfg(unix)]
    assert!(timed_out["message"]["termSignal"].as_i64().is_some());
    #[cfg(windows)]
    assert!(timed_out["message"].get("termSignal").is_none());
    assert!(timed_out["message"].get("artifactWarnings").is_none());

    let too_long = env.rpc(
        instance,
        "tool",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": "5-limit",
            "method": "bash_run",
            "message": { "input": {
                "command": "true",
                "timeoutMs": 100001
            }, "context": { "workspace": env.workspace() } }
        }),
    );
    assert_eq!(too_long["type"], "error");
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
        "tool",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": "6",
            "method": "bash_run",
            "message": { "input": {
                "command": output_command,
                "timeoutMs": 30_000,
                "maxCaptureBytes": 128
            }, "context": { "workspace": env.workspace() } }
        }),
    );
    assert_eq!(output_limited["type"], "reply");
    assert_eq!(output_limited["message"]["termination"], "exited");
    assert_eq!(output_limited["message"]["stdoutTruncated"], true);
    assert_eq!(output_limited["message"]["stderrTruncated"], false);
    assert!(
        output_limited["message"]["stdout"]
            .as_str()
            .unwrap()
            .contains("... [output omitted] ...")
    );
    assert!(output_limited["message"].get("timedOut").is_none());
    assert!(output_limited["message"].get("artifactWarnings").is_none());
    assert!(output_limited["message"].get("stderrArtifact").is_none());

    #[cfg(unix)]
    let exact_output_command = "awk 'BEGIN { for (i = 0; i < 128; i++) printf \"x\" }'";
    #[cfg(windows)]
    let exact_output_command = "[Console]::Out.Write([string]::new([char]'x', 128))";
    let exact_output = env.rpc(
        instance,
        "tool",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": "6-exact",
            "method": "bash_run",
            "message": { "input": {
                "command": exact_output_command,
                "timeoutMs": 30_000,
                "maxCaptureBytes": 128
            }, "context": { "workspace": env.workspace() } }
        }),
    );
    assert_eq!(exact_output["type"], "reply", "{exact_output}");
    assert_eq!(exact_output["message"]["stdoutBytes"], 128, "{exact_output}");
    assert_eq!(
        exact_output["message"]["stdoutTruncated"], false,
        "{exact_output}"
    );
    assert_eq!(
        exact_output["message"]["stdout"],
        "x".repeat(128),
        "{exact_output}"
    );

    assert!(
        output_limited["message"]["stdoutArtifact"]["handle"]
            .as_str()
            .is_some(),
        "truncated stdout must expose an artifact handle"
    );
    assert_eq!(
        output_limited["message"]["stdoutArtifact"]["sourceBytes"],
        2000
    );
    assert_eq!(
        output_limited["message"]["stdoutArtifact"]["storedBytes"],
        2000
    );
    assert_eq!(
        output_limited["message"]["stdoutArtifact"]["artifactTruncated"],
        false
    );
    let truncated_path = output_limited["message"]["stdoutPath"]
        .as_str()
        .expect("truncated stdout must expose a file_read recovery path");
    assert!(truncated_path.starts_with("/.devshell/tool-results/"));
    assert!(truncated_path.ends_with("/stdout"));
    let recovered = env.rpc(
        instance,
        "tool",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": "6-recover",
            "method": "file_read",
            "message": { "input": {
                "files": [{
                    "path": truncated_path,
                    "view": "content",
                    "selector": "1-1:raw"
                }]
            }, "context": { "workspace": env.workspace() } }
        }),
    );
    assert_eq!(recovered["type"], "reply", "{recovered}");
    assert_eq!(
        recovered["message"]["files"][0]["content"],
        format!("1:{}", "x".repeat(2000))
    );

    #[cfg(unix)]
    let recovery_command = "awk 'BEGIN { for (i = 1; i <= 4000; i++) printf \"line-%04d\\n\", i }'";
    #[cfg(windows)]
    let recovery_command =
        "1..4000 | ForEach-Object { [Console]::Out.WriteLine(('line-{0:D4}' -f $_)) }";
    let recovery = env.rpc(
        instance,
        "tool",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": "7-recovery",
            "method": "bash_run",
            "message": { "input": { "command": recovery_command, "timeoutMs": 30_000 }, "context": { "workspace": env.workspace() } }
        }),
    );
    assert_eq!(recovery["type"], "reply", "{recovery}");
    assert_eq!(recovery["message"]["stdoutTruncated"], false, "{recovery}");
    let recovery_path = recovery["message"]["stdoutPath"]
        .as_str()
        .expect("large inline stdout must expose a recovery path");
    let middle = env.rpc(
        instance,
        "tool",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": "7-recover-middle",
            "method": "file_read",
            "message": { "input": {
                "files": [{
                    "path": recovery_path,
                    "view": "content",
                    "selector": "2000-2002:raw"
                }]
            }, "context": { "workspace": env.workspace() } }
        }),
    );
    assert_eq!(middle["type"], "reply", "{middle}");
    assert_eq!(
        middle["message"]["files"][0]["content"],
        "2000:line-2000\n2001:line-2001\n2002:line-2002"
    );

    #[cfg(unix)]
    let compact_command = "printf compact";
    #[cfg(windows)]
    let compact_command = "[Console]::Out.Write('compact')";

    let compact = env.rpc(
        instance,
        "tool",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": "9",
            "method": "bash_run",
            "message": { "input": { "command": compact_command, "timeoutMs": 30_000 }, "context": { "workspace": env.workspace() } }
        }),
    );
    assert_eq!(compact["type"], "reply", "{compact}");
    assert!(compact["message"].get("stdoutArtifact").is_none());
    assert!(compact["message"].get("stderrArtifact").is_none());
    assert!(compact["message"].get("stdoutPath").is_none());
    assert!(compact["message"].get("stderrPath").is_none());

    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn bash_run_closes_omitted_stdin_and_handles_bidirectional_pipe_pressure() {
    let env = TestEnv::new();
    let instance = "aromatic-bash-stdio";
    env.command()
        .current_dir(env.workspace())
        .args(["start", "--instance", instance])
        .assert()
        .success();

    #[cfg(unix)]
    let eof_command = "cat; printf done";
    #[cfg(windows)]
    let eof_command = "$null = [Console]::In.ReadToEnd(); [Console]::Out.Write('done')";
    let eof = env.rpc(
        instance,
        "tool",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": "stdin-eof",
            "method": "bash_run",
            "message": { "input": { "command": eof_command, "timeoutMs": 2_000 }, "context": { "workspace": env.workspace() } }
        }),
    );
    assert_eq!(eof["type"], "reply", "{eof}");
    assert_eq!(eof["message"]["termination"], "exited", "{eof}");
    assert_eq!(eof["message"]["stdout"], "done", "{eof}");

    let stdin = "i".repeat(512 * 1024);
    #[cfg(unix)]
    let pressure_command = "head -c 524288 /dev/zero | tr '\\0' o; cat >/dev/null; printf done >&2";
    #[cfg(windows)]
    let pressure_command = "[Console]::Out.Write('o' * 524288); $null = [Console]::In.ReadToEnd(); [Console]::Error.Write('done')";
    let pressure = env.rpc(
        instance,
        "tool",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": "stdio-pressure",
            "method": "bash_run",
            "message": { "input": {
                "command": pressure_command,
                "stdin": stdin,
                "timeoutMs": 5_000,
                "maxCaptureBytes": 1024
            }, "context": { "workspace": env.workspace() } }
        }),
    );
    assert_eq!(pressure["type"], "reply", "{pressure}");
    assert_eq!(pressure["message"]["termination"], "exited", "{pressure}");
    assert_eq!(pressure["message"]["stderr"], "done", "{pressure}");
    assert_eq!(pressure["message"]["stdoutBytes"], 524288, "{pressure}");

    env.json_command(&["stop", "--instance", instance]);
}

#[cfg(unix)]
#[test]
fn bash_run_does_not_load_login_or_interactive_shell_profiles() {
    let env = TestEnv::new();
    fs::write(
        env.home().join(".bash_profile"),
        "export DEVSHELL_PROFILE_MARKER=login\n",
    )
    .unwrap();
    fs::write(
        env.home().join(".bashrc"),
        "export DEVSHELL_RC_MARKER=interactive\n",
    )
    .unwrap();
    let instance = "aromatic-bash-clean-profile";
    env.command()
        .current_dir(env.workspace())
        .args(["start", "--instance", instance])
        .assert()
        .success();

    let response = env.rpc(
        instance,
        "tool",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": "clean-profile",
            "method": "bash_run",
            "message": { "input": {
                "command": "printf '%s/%s' \"${DEVSHELL_PROFILE_MARKER:-unset}\" \"${DEVSHELL_RC_MARKER:-unset}\"",
                "timeoutMs": 2_000
            }, "context": { "workspace": env.workspace() } }
        }),
    );
    assert_eq!(response["type"], "reply", "{response}");
    assert_eq!(response["message"]["stdout"], "unset/unset", "{response}");
    env.json_command(&["stop", "--instance", instance]);
}

#[cfg(unix)]
#[test]
fn bash_run_ignores_inherited_bash_env_but_allows_an_explicit_override() {
    let env = TestEnv::new();
    let bash_env = env.home().join("bash-env.sh");
    fs::write(&bash_env, "export DEVSHELL_BASH_ENV_MARKER=loaded\n").unwrap();
    let instance = "aromatic-bash-env";
    env.command_with_env("BASH_ENV", bash_env.to_string_lossy().as_ref())
        .current_dir(env.workspace())
        .args(["start", "--instance", instance])
        .assert()
        .success();

    let inherited = env.rpc(
        instance,
        "tool",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": "inherited-bash-env",
            "method": "bash_run",
            "message": { "input": {
                "command": "printf '%s' \"${DEVSHELL_BASH_ENV_MARKER:-unset}\"",
                "timeoutMs": 2_000
            }, "context": { "workspace": env.workspace() } }
        }),
    );
    assert_eq!(inherited["type"], "reply", "{inherited}");
    assert_eq!(inherited["message"]["stdout"], "unset", "{inherited}");

    let explicit = env.rpc(
        instance,
        "tool",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": "explicit-bash-env",
            "method": "bash_run",
            "message": { "input": {
                "command": "printf '%s' \"${DEVSHELL_BASH_ENV_MARKER:-unset}\"",
                "env": { "BASH_ENV": bash_env },
                "timeoutMs": 2_000
            }, "context": { "workspace": env.workspace() } }
        }),
    );
    assert_eq!(explicit["type"], "reply", "{explicit}");
    assert_eq!(explicit["message"]["stdout"], "loaded", "{explicit}");

    env.json_command(&["stop", "--instance", instance]);
}

#[cfg(unix)]
#[test]
fn bash_run_cleans_background_processes_after_the_shell_exits() {
    let env = TestEnv::new();
    let instance = "aromatic-bash-background";
    env.command()
        .current_dir(env.workspace())
        .args(["start", "--instance", instance])
        .assert()
        .success();

    let response = env.rpc(
        instance,
        "tool",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": "background-child",
            "method": "bash_run",
            "message": { "input": {
                "command": "sleep 2 & printf done",
                "timeoutMs": 500
            }, "context": { "workspace": env.workspace() } }
        }),
    );

    assert_eq!(response["type"], "reply", "{response}");
    assert_eq!(response["message"]["termination"], "exited", "{response}");
    assert_eq!(response["message"]["stdout"], "done", "{response}");
    assert!(
        response["message"]["durationMs"].as_u64().unwrap() < 500,
        "background child kept bash_run alive: {response}"
    );
    env.json_command(&["stop", "--instance", instance]);
}

#[cfg(unix)]
#[test]
fn bash_run_keeps_legal_large_capture_within_the_rpc_frame() {
    let env = TestEnv::new();
    let instance = "aromatic-bash-large-capture";
    env.command()
        .current_dir(env.workspace())
        .args(["start", "--instance", instance])
        .assert()
        .success();

    let response = env.rpc(
        instance,
        "tool",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": "large-capture",
            "method": "bash_run",
            "message": { "input": {
                "command": "head -c 7340032 /dev/zero | tr '\\0' x",
                "timeoutMs": 30_000,
                "maxCaptureBytes": 16_777_216
            }, "context": { "workspace": env.workspace() } }
        }),
    );

    assert_eq!(response["type"], "reply", "{response}");
    assert_eq!(response["message"]["termination"], "exited", "{response}");
    assert_eq!(response["message"]["stdoutBytes"], 7_340_032, "{response}");
    assert_eq!(response["message"]["stdoutTruncated"], true, "{response}");
    assert!(
        response["message"]["stdout"].as_str().unwrap().len() <= 512 * 1024,
        "{response}"
    );
    assert_eq!(
        response["message"]["stdoutArtifact"]["sourceBytes"], 7_340_032,
        "{response}"
    );
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
fn missing_tool_returns_structured_error() {
    let env = TestEnv::new();
    let instance = "aromatic-errors";

    env.command()
        .current_dir(env.workspace())
        .args(["start", "--instance", instance])
        .assert()
        .success();

    let missing_tool = env.rpc(
        instance,
        "tool",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": "bad-3",
            "method": "missing_tool",
            "message": { "input": {} }
        }),
    );
    assert_eq!(missing_tool["type"], "error");
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
        "tool",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": "7",
            "method": "bash_run",
            "message": { "input": {
                "command": "pwd",
                "cwd": outside.to_string_lossy(),
                "timeoutMs": 30_000
            }, "context": { "workspace": env.workspace() } }
        }),
    );
    assert_eq!(escaped["type"], "error");
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
        "terminal",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": "terminal-security",
            "method": "terminal.open",
            "message": {
                "cols": 80,
                "rows": 24,
                "cwd": outside.to_string_lossy(),
                "command": "exit",
                "workspace": env.workspace()
            }
        }),
    );
    assert_eq!(escaped["type"], "error");
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
    let mut transport = env
        .std_command()
        .args(["transport", "--instance", instance])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let rpc = TransportEndpointWriter::new(transport.stdin.take().unwrap(), instance).unwrap();
    drop(rpc);
    let mut output = TransportEndpointReader::new(transport.stdout.take().unwrap());
    assert_eq!(output.read_to_end(&mut Vec::new()).unwrap(), 0);
    assert!(!transport.wait().unwrap().success());

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
    let control_history = env
        .instance_root(stopped)
        .join("control-worker/history.keep");
    fs::create_dir_all(control_history.parent().unwrap()).unwrap();
    fs::write(&control_history, "keep\n").unwrap();

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

    let applied = env.json_command(&["gc"]);
    assert_eq!(applied["removed_instances"][0], stopped);
    assert!(!env.instance_root(stopped).join("config.toml").exists());
    assert!(!env.instance_root(stopped).join("logs").exists());
    assert!(control_history.exists());

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
        .args(["transport", "--instance", instance])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = TransportEndpointWriter::new(bridge.stdin.take().unwrap(), instance).unwrap();
    let mut stdout = TransportEndpointReader::new(bridge.stdout.take().unwrap());
    stdout.wait_ready().unwrap();

    #[cfg(unix)]
    let long_command = "sleep 2; printf done";
    #[cfg(windows)]
    let long_command = "Start-Sleep -Seconds 2; [Console]::Out.Write('done')";

    stdin
        .send(
        "tool",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": "long-tool",
            "method": "bash_run",
            "message": {
                "input": {
                    "command": long_command,
                    "timeoutMs": 5000
                },
                "context": { "workspace": env.workspace() }
            }
        }),
    )
        .unwrap();
    stdin
        .send(
        "core",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": "ping-during-tool",
            "method": "worker.ping",
            "message": {}
        }),
    )
        .unwrap();

    let responses = read_rpc_responses(&mut stdout, &["ping-during-tool", "long-tool"]);
    let first = &responses[0];
    assert_eq!(first["id"], "ping-during-tool");
    assert_eq!(first["type"], "reply");

    let second = &responses[1];
    assert_eq!(second["id"], "long-tool");
    assert_eq!(second["type"], "reply");
    assert_eq!(second["message"]["stdout"], "done");

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
        .args(["transport", "--instance", instance])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = TransportEndpointWriter::new(bridge.stdin.take().unwrap(), instance).unwrap();
    let mut stdout = TransportEndpointReader::new(bridge.stdout.take().unwrap());
    stdout.wait_ready().unwrap();
    let (frames, received) = mpsc::channel();
    let reader = thread::spawn(move || {
        while let Ok(frame) = stdout.read_packet() {
            if frames.send(frame).is_err() {
                return;
            }
        }
    });

    stdin
        .send(
        "terminal",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": "terminal-open",
            "method": "terminal.open",
            "message": { "cols": 80, "rows": 24, "workspace": env.workspace() }
        }),
    )
        .unwrap();
    let opened = receive_response(&received, "terminal-open");
    assert_eq!(opened["type"], "reply", "{opened}");
    let terminal_id = opened["message"]["terminalId"].as_str().unwrap();
    let generation = opened["message"]["generation"].as_u64().unwrap();
    let version = opened["message"]["version"].as_u64().unwrap();

    #[cfg(unix)]
    let command = "printf '%s\\n' 'forward-notification-ready'\\r";
    #[cfg(windows)]
    let command = "powershell.exe -NoLogo -NoProfile -NonInteractive -Command \"[Console]::WriteLine('forward-notification-ready')\"\\r";
    stdin
        .send(
        "terminal",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": "terminal-write",
            "method": "terminal.write",
            "message": {
                "clientSeq": 1,
                "generation": generation,
                "terminalId": terminal_id,
                "version": version,
                "data": BASE64.encode(command.as_bytes())
            }
        }),
    )
        .unwrap();

    let deadline = Instant::now() + Duration::from_secs(5);
    let mut write_accepted = false;
    let mut output = String::new();
    #[cfg(windows)]
    let mut cursor_queries_answered = 0_usize;
    while Instant::now() < deadline
        && (!write_accepted || !output.contains("forward-notification-ready"))
    {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let frame = received
            .recv_timeout(remaining)
            .expect("persistent RPC bridge did not forward terminal response/notification");
        if frame["type"] == "reply" && frame["id"] == "terminal-write" {
            write_accepted = true;
        }
        if frame["protocol"] == "event"
            && frame["name"] == "output"
            && let Some(data) = frame["message"]["dataBase64"].as_str()
        {
            let decoded = BASE64.decode(data).unwrap();
            output.push_str(&String::from_utf8_lossy(&decoded));
            #[cfg(windows)]
            {
                let cursor_queries = output.matches("\u{1b}[6n").count();
                while cursor_queries_answered < cursor_queries {
                    let client_seq = 2 + cursor_queries_answered as u64;
                    stdin
                        .send(
                        "terminal",
                        &serde_json::json!({
                            "protocol": "rpc",
                            "type": "request",
                            "id": format!("terminal-cursor-response-{client_seq}"),
                            "method": "terminal.write",
                            "message": {
                                "clientSeq": client_seq,
                                "generation": generation,
                                "terminalId": terminal_id,
                                "version": version,
                                "data": BASE64.encode(b"\x1b[1;1R")
                            }
                        }),
                    )
                        .unwrap();
                    cursor_queries_answered += 1;
                }
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
        .args(["transport", "--instance", instance])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = TransportEndpointWriter::new(bridge.stdin.take().unwrap(), instance).unwrap();
    let mut stdout = TransportEndpointReader::new(bridge.stdout.take().unwrap());
    stdout.wait_ready().unwrap();

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

    stdin
        .send(
        "tool",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": "cancel-me",
            "method": "bash_run",
            "message": {
                "input": {
                    "command": cancel_command,
                    "timeoutMs": 10000
                },
                "context": {
                    "ctxId": "ctx-cancel",
                    "requestId": "mcp-cancel-me",
                    "source": "mcp",
                    "workspace": env.workspace()
                }
            }
        }),
    )
        .unwrap();
    wait_until_path_exists(&started_marker);
    stdin
        .send(
        "tool",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": "cancel-control",
            "method": "tool.call.cancel",
            "message": {
                "rpcRequestId": "cancel-me",
                "ctxId": "ctx-cancel",
                "reason": "client timeout"
            }
        }),
    )
        .unwrap();

    let responses = read_rpc_responses(&mut stdout, &["cancel-control", "cancel-me"]);
    let cancel_response = responses
        .iter()
        .find(|response| response["id"] == "cancel-control")
        .expect("cancel acknowledgement response");
    assert_eq!(cancel_response["type"], "reply", "{cancel_response}");
    assert_eq!(
        cancel_response["message"]["cancelled"], true,
        "{cancel_response}"
    );

    let call_response = responses
        .iter()
        .find(|response| response["id"] == "cancel-me")
        .expect("cancelled tool call response");
    assert_eq!(call_response["type"], "error", "{call_response}");
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
fn internal_artifact_rpc_is_not_listed_as_a_tool() {
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
        "tool",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": "payload-tools",
            "method": "tools.list",
            "message": {}
        }),
    );
    let names = tools["message"]["tools"]
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
    assert!(!names.contains(&"artifact.receive.direct.open"));
    assert!(!names.contains(&"artifact.receive.direct.close"));
    assert!(!names.contains(&"artifact.payload.direct.push"));

    let expires_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis()
        + 60_000;
    let opened = env.rpc(
        instance,
        "artifact",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": "payload-open",
            "method": "artifact.payload.open",
            "message": {
                "path": "./payload.txt",
                "expiresAtMs": expires_at_ms,
                "workspace": env.workspace()
            }
        }),
    );
    assert_eq!(opened["type"], "reply", "{opened}");
    assert_eq!(opened["message"]["descriptor"]["type"], "file");
    let payload_id = opened["message"]["payloadId"].as_str().unwrap();

    let direct_begun = env.rpc(
        instance,
        "artifact",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": "direct-receive-begin",
            "method": "artifact.receive.begin",
            "message": {
                "descriptor": opened["message"]["descriptor"].clone(),
                "overwrite": false,
                "targetPath": "./direct-received.txt",
                "workspace": env.workspace()
            }
        }),
    );
    assert_eq!(direct_begun["type"], "reply", "{direct_begun}");
    let direct_receive_id = direct_begun["message"]["receiveId"].as_str().unwrap();
    let direct_open = env.rpc(
        instance,
        "artifact",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": "direct-open",
            "method": "artifact.receive.direct.open",
            "message": { "receiveId": direct_receive_id, "expiresAtMs": expires_at_ms }
        }),
    );
    assert_eq!(direct_open["type"], "reply", "{direct_open}");
    let direct_push = env.rpc(
        instance,
        "artifact",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": "direct-push",
            "method": "artifact.payload.direct.push",
            "message": {
                "payloadId": payload_id,
                "offsetBytes": 0,
                "maxBytes": 1024,
                "urls": direct_open["message"]["urls"].clone()
            }
        }),
    );
    assert_eq!(direct_push["type"], "reply", "{direct_push}");
    assert_eq!(direct_push["message"]["nextOffsetBytes"], 11);
    let direct_close = env.rpc(
        instance,
        "artifact",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": "direct-close",
            "method": "artifact.receive.direct.close",
            "message": { "receiverId": direct_open["message"]["receiverId"].clone() }
        }),
    );
    assert_eq!(direct_close["type"], "reply", "{direct_close}");
    let direct_finished = env.rpc(
        instance,
        "artifact",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": "direct-finish",
            "method": "artifact.receive.finish",
            "message": { "receiveId": direct_receive_id }
        }),
    );
    assert_eq!(direct_finished["type"], "reply", "{direct_finished}");
    assert_eq!(
        fs::read(env.workspace().join("direct-received.txt")).unwrap(),
        b"rpc payload"
    );

    let closed = env.rpc(
        instance,
        "artifact",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": "payload-close",
            "method": "artifact.payload.close",
            "message": { "payloadId": payload_id }
        }),
    );
    assert_eq!(closed["type"], "reply", "{closed}");
    assert_eq!(closed["message"]["closed"], true);

    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn extension_resource_prepare_creates_a_private_instance_scoped_collection() {
    let env = TestEnv::new();
    let instance = "extension-resource";
    env.command()
        .current_dir(env.workspace())
        .args(["start", "--instance", instance])
        .assert()
        .success();

    let tools = env.rpc(
        instance,
        "tool",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": "resource-tools",
            "method": "tools.list",
            "message": {}
        }),
    );
    let names = tools["message"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert!(!names.contains(&"extension.resource.prepare"));

    let prepared = env.rpc(
        instance,
        "core",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": "resource-prepare",
            "method": "extension.resource.prepare",
            "message": {
                "extensionId": "skill",
                "collection": "managed"
            }
        }),
    );
    assert_eq!(prepared["type"], "reply", "{prepared}");
    let expected = env
        .instance_root(instance)
        .join("extensions")
        .join("skill")
        .join("resources")
        .join("managed");
    assert!(expected.is_dir());
    assert_eq!(
        prepared["message"]["directory"],
        expected.to_string_lossy().into_owned()
    );

    let escaped = env.rpc(
        instance,
        "core",
        &serde_json::json!({
            "protocol": "rpc",
            "type": "request",
            "id": "resource-escape",
            "method": "extension.resource.prepare",
            "message": {
                "extensionId": "../escape",
                "collection": "managed"
            }
        }),
    );
    assert_eq!(escaped["type"], "error", "{escaped}");
    assert_eq!(escaped["error"]["code"], "extension.resourceInvalid");

    env.json_command(&["stop", "--instance", instance]);
}

fn receive_response(receiver: &mpsc::Receiver<Value>, id: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let frame = receiver
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("RPC response timeout");
        if matches!(frame["type"].as_str(), Some("reply" | "error"))
            && frame["id"] == id
        {
            return frame;
        }
    }
}

fn read_rpc_responses<R: Read>(
    reader: &mut TransportEndpointReader<R>,
    ids: &[&str],
) -> Vec<Value> {
    let mut responses = vec![None; ids.len()];
    while responses.iter().any(Option::is_none) {
        let frame = reader.read_packet().unwrap();
        if !matches!(frame["type"].as_str(), Some("reply" | "error")) {
            continue;
        }
        let Some(id) = frame["id"].as_str() else {
            continue;
        };
        if let Some(index) = ids.iter().position(|expected| *expected == id) {
            responses[index] = Some(frame);
        }
    }
    responses
        .into_iter()
        .map(|response| response.expect("requested RPC response"))
        .collect()
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
