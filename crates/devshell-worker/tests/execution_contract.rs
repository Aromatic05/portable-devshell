mod support;

#[cfg(unix)]
mod unix {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;

    use serde_json::{Value, json};

    use super::support::TestEnv;

    fn bash_call(env: &TestEnv, instance: &str, input: Value) -> Value {
        env.rpc(
            instance,
            "tool",
            &json!({
                "protocol": "rpc",
                "type": "request",
                "id": "environment-check",
                "method": "bash_run",
                "message": {
                    "input": input,
                    "context": { "workspace": env.workspace() }
                }
            }),
        )
    }

    #[test]
    fn daemon_and_process_environment_hooks_are_inherited_by_bash() {
        let env = TestEnv::new();
        let instance = "execution-hooks";
        let config = json!({
            "environment": [
                {
                    "order": 100,
                    "name": "variables",
                    "phase": "daemon",
                    "content": { "set": { "DAEMON_STAGE": "daemon-ready" } }
                },
                {
                    "order": 200,
                    "name": "variables",
                    "content": {
                        "set": { "PROCESS_STAGE": "process-ready", "OVERWRITE": "hook-value" },
                        "unset": ["REMOVE_ME"]
                    }
                }
            ]
        });
        env.command_with_env("DEVSHELL_WORKER_EXECUTION_CONFIG", &config.to_string())
            .env("REMOVE_ME", "inherited")
            .args(["start", "--instance", instance])
            .assert()
            .success();

        let result = bash_call(
            &env,
            instance,
            json!({
                "command": "printf '%s|%s|%s|%s|%s' \"$DAEMON_STAGE\" \"$PROCESS_STAGE\" \"$OVERWRITE\" \"${REMOVE_ME-absent}\" \"${DEVSHELL_WORKER_EXECUTION_CONFIG-absent}\"",
                "timeoutMs": 10000,
                "env": { "OVERWRITE": "explicit-value" }
            }),
        );
        assert_eq!(result["type"], "reply", "{result}");
        assert_eq!(result["message"]["exitCode"], 0, "{result}");
        assert_eq!(
            result["message"]["stdout"],
            "daemon-ready|process-ready|explicit-value|absent|absent"
        );
        env.json_command(&["stop", "--instance", instance]);
    }

    #[test]
    fn direnv_provider_applies_authorized_envrc_in_target_workspace() {
        if !Command::new("direnv")
            .arg("version")
            .output()
            .is_ok_and(|out| out.status.success())
        {
            return;
        }
        let env = TestEnv::new();
        let instance = "execution-direnv";
        let rc = env.workspace().join(".envrc");
        fs::write(&rc, "export EXECUTION_DIRENV_PROBE=from-envrc\n").unwrap();
        let authorized = Command::new("direnv")
            .args(["allow", rc.to_str().unwrap()])
            .env("HOME", env.home())
            .output()
            .unwrap();
        assert!(authorized.status.success(), "{:?}", authorized);

        let config = json!({
            "environment": [{
                "order": 100, "name": "direnv", "content": { "required": true },
                "driver": {
                    "name": "direnv",
                    "version": 1,
                    "executable": "direnv",
                    "args": ["export", "json"]
                }
            }]
        });
        env.command_with_env("DEVSHELL_WORKER_EXECUTION_CONFIG", &config.to_string())
            .args(["start", "--instance", instance])
            .assert()
            .success();
        let result = bash_call(
            &env,
            instance,
            json!({
                "command": "printf '%s' \"$EXECUTION_DIRENV_PROBE\"",
                "timeoutMs": 10000
            }),
        );
        assert_eq!(result["type"], "reply", "{result}");
        assert_eq!(result["message"]["stdout"], "from-envrc", "{result}");
        env.json_command(&["stop", "--instance", instance]);
    }

    #[test]
    fn custom_environment_driver_receives_prior_hook_environment() {
        let env = TestEnv::new();
        let instance = "execution-custom-driver";
        let driver = env.workspace().join("execution-driver.sh");
        fs::write(
            &driver,
            "#!/bin/sh\nprintf '{\"GENERIC_DRIVER_PROBE\":\"%s\"}' \"$DRIVER_INPUT\"\n",
        )
        .unwrap();
        fs::set_permissions(&driver, fs::Permissions::from_mode(0o700)).unwrap();
        let config = json!({ "environment": [
            { "order": 100, "name": "variables",
              "content": { "set": { "DRIVER_INPUT": "from-previous-hook" } } },
            { "order": 200, "name": "custom-driver", "content": { "required": true },
              "driver": { "name": "custom-driver", "version": 1, "executable": driver } }
        ] });
        env.command_with_env("DEVSHELL_WORKER_EXECUTION_CONFIG", &config.to_string())
            .args(["start", "--instance", instance])
            .assert()
            .success();
        let result = bash_call(
            &env,
            instance,
            json!({
                "command": "printf '%s' \"$GENERIC_DRIVER_PROBE\"",
                "timeoutMs": 10000
            }),
        );
        assert_eq!(result["type"], "reply", "{result}");
        assert_eq!(
            result["message"]["stdout"], "from-previous-hook",
            "{result}"
        );
        env.json_command(&["stop", "--instance", instance]);
    }

    #[test]
    fn optional_driver_partial_patch_is_rolled_back_before_later_hooks() {
        let env = TestEnv::new();
        let instance = "execution-hook-rollback";
        let config = json!({ "environment": [
            { "order": 100, "name": "variables", "content": {
                "set": { "EXECUTION_LAYER": "original" },
                "unset": ["EXECUTION_REMOVED"]
            } },
            { "order": 200, "name": "broken-driver", "driver": {
                "name": "broken-driver", "version": 1, "executable": "/bin/sh",
                "args": ["-c", "printf '%s' '{\"EXECUTION_LAYER\":\"poisoned\",\"ZZ_INVALID\":42}'"]
            } },
            { "order": 300, "name": "observer", "content": { "required": true }, "driver": {
                "name": "observer", "version": 1, "executable": "/bin/sh",
                "args": ["-c", "printf '{\"EXECUTION_OBSERVED\":\"%s|%s\"}' \"$EXECUTION_LAYER\" \"${EXECUTION_REMOVED-absent}\""]
            } },
            { "order": 400, "name": "variables", "content": {
                "set": { "EXECUTION_LAYER": "final" }
            } }
        ] });
        env.command_with_env("DEVSHELL_WORKER_EXECUTION_CONFIG", &config.to_string())
            .env("EXECUTION_REMOVED", "inherited")
            .args(["start", "--instance", instance])
            .assert()
            .success();

        let result = bash_call(
            &env,
            instance,
            json!({
                "command": "printf '%s|%s' \"$EXECUTION_LAYER\" \"$EXECUTION_OBSERVED\"",
                "timeoutMs": 10000
            }),
        );
        assert_eq!(result["type"], "reply", "{result}");
        assert_eq!(result["message"]["exitCode"], 0, "{result}");
        assert_eq!(result["message"]["stdout"], "final|original|absent", "{result}");
        env.json_command(&["stop", "--instance", instance]);
    }

    #[test]
    fn required_driver_failure_recovers_without_leaking_call_environment() {
        let env = TestEnv::new();
        let instance = "execution-driver-recovery";
        let patch = env.workspace().join("driver-patch.json");
        let marker = env.workspace().join("command-ran");
        let config = json!({ "environment": [{
            "order": 100, "name": "recoverable", "content": { "required": true },
            "driver": {
                "name": "recoverable", "version": 1, "executable": "/bin/sh",
                "args": ["-c", "test -f driver-patch.json || { printf 'patch unavailable' >&2; exit 23; }; cat driver-patch.json"]
            }
        }] });
        env.command_with_env("DEVSHELL_WORKER_EXECUTION_CONFIG", &config.to_string())
            .env_remove("EXECUTION_TRANSIENT")
            .args(["start", "--instance", instance])
            .assert()
            .success();

        let failed = bash_call(
            &env,
            instance,
            json!({ "command": "printf ran > command-ran", "timeoutMs": 10000 }),
        );
        assert_eq!(failed["type"], "error", "{failed}");
        assert_eq!(failed["error"]["code"], "execution.providerFailed", "{failed}");
        assert_eq!(
            failed["error"]["message"],
            "required execution provider recoverable failed: patch unavailable",
            "{failed}"
        );
        assert!(!marker.exists());

        fs::write(&patch, r#"{"EXECUTION_SESSION":"recovered","EXECUTION_TRANSIENT":"hook-value"}"#).unwrap();
        let recovered = bash_call(
            &env,
            instance,
            json!({
                "command": "printf '%s|%s' \"$EXECUTION_SESSION\" \"$EXECUTION_TRANSIENT\"",
                "timeoutMs": 10000,
                "env": { "EXECUTION_TRANSIENT": "request-value" }
            }),
        );
        assert_eq!(recovered["type"], "reply", "{recovered}");
        assert_eq!(recovered["message"]["exitCode"], 0, "{recovered}");
        assert_eq!(recovered["message"]["stdout"], "recovered|request-value", "{recovered}");

        fs::write(&patch, r#"{"EXECUTION_SESSION":"next-call"}"#).unwrap();
        let isolated = bash_call(
            &env,
            instance,
            json!({
                "command": "printf '%s|%s' \"$EXECUTION_SESSION\" \"${EXECUTION_TRANSIENT-absent}\"",
                "timeoutMs": 10000
            }),
        );
        assert_eq!(isolated["type"], "reply", "{isolated}");
        assert_eq!(isolated["message"]["exitCode"], 0, "{isolated}");
        assert_eq!(isolated["message"]["stdout"], "next-call|absent", "{isolated}");
        env.json_command(&["stop", "--instance", instance]);
    }

    #[test]
    fn ordered_environment_hooks_reach_a_managed_tmux_task() {
        if !Command::new("tmux")
            .arg("-V")
            .output()
            .is_ok_and(|out| out.status.success())
        {
            return;
        }
        let env = TestEnv::new();
        let instance = "execution-tmux-environment";
        let config = json!({ "environment": [
            { "order": 100, "name": "variables", "content": { "set": { "LAYER": "first" } } },
            { "order": 200, "name": "variables", "content": {
                "set": { "LAYER": "second" }, "unset": ["REMOVE_ME"]
            } }
        ] });
        env.command_with_env("DEVSHELL_WORKER_EXECUTION_CONFIG", &config.to_string())
            .env("REMOVE_ME", "inherited")
            .args(["start", "--instance", instance])
            .assert()
            .success();
        let run = env.rpc(
            instance,
            "tool",
            &json!({
                "protocol": "rpc", "type": "request", "id": "execution-tmux-run",
                "method": "tmux_run",
                "message": {
                    "input": {
                        "command": "printf '%s|%s\\n' \"$LAYER\" \"${REMOVE_ME-missing}\"",
                        "wait": "block", "timeMs": 3000, "line": 80
                    },
                    "context": {
                        "workspace": env.workspace(), "source": "mcp",
                        "ctxId": "ctx-execution", "requestId": "tmux-execution-run"
                    }
                }
            }),
        );
        assert_eq!(run["type"], "reply", "{run}");
        assert_eq!(run["message"]["task"]["status"], "0", "{run}");
        assert!(
            run["message"]["output"]
                .as_array()
                .unwrap()
                .iter()
                .any(|line| line == "second|missing"),
            "{run}"
        );
        env.json_command(&["stop", "--instance", instance]);
    }

    #[test]
    fn exclusive_process_sandbox_wraps_bash_and_managed_tmux_tasks() {
        if !Command::new("tmux")
            .arg("-V")
            .output()
            .is_ok_and(|out| out.status.success())
        {
            return;
        }
        if !Command::new("bwrap")
            .args([
                "--ro-bind",
                "/",
                "/",
                "--dev-bind",
                "/dev",
                "/dev",
                "--proc",
                "/proc",
                "--",
                "/bin/true",
            ])
            .output()
            .is_ok_and(|out| out.status.success())
        {
            return;
        }
        let env = TestEnv::new();
        let instance = "execution-process-sandbox";
        let config = json!({ "sandbox": {
            "name": "bubblewrap",
            "content": { "args": ["--ro-bind", "/", "/", "--dev-bind", "/dev", "/dev", "--proc", "/proc"] }
        } });
        env.command_with_env("DEVSHELL_WORKER_EXECUTION_CONFIG", &config.to_string())
            .args(["start", "--instance", instance])
            .assert()
            .success();
        let bash = bash_call(
            &env,
            instance,
            json!({
                "command": "printf sandbox-bash", "timeoutMs": 10000
            }),
        );
        assert_eq!(bash["message"]["stdout"], "sandbox-bash", "{bash}");
        let tmux = env.rpc(instance, "tool", &json!({
            "protocol": "rpc", "type": "request", "id": "sandbox-tmux-run",
            "method": "tmux_run",
            "message": {
                "input": { "command": "printf 'sandbox-task\\n'", "wait": "block", "timeMs": 3000, "line": 80 },
                "context": {
                    "workspace": env.workspace(), "source": "mcp",
                    "ctxId": "ctx-sandbox", "requestId": "sandbox-tmux-run"
                }
            }
        }));
        assert_eq!(tmux["type"], "reply", "{tmux}");
        assert_eq!(tmux["message"]["task"]["status"], "0", "{tmux}");
        assert!(
            tmux["message"]["output"]
                .as_array()
                .unwrap()
                .iter()
                .any(|line| line == "sandbox-task"),
            "{tmux}"
        );
        env.json_command(&["stop", "--instance", instance]);
    }
}
