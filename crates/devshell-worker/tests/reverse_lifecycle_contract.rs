mod support;

use std::fs;
use std::process::{Child, Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use support::TestEnv;

fn finish(mut child: Child) -> Output {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if child.try_wait().unwrap().is_some() {
            return child.wait_with_output().unwrap();
        }
        if Instant::now() >= deadline {
            child.kill().ok();
            let output = child.wait_with_output().unwrap();
            panic!("lifecycle command hung: {output:?}");
        }
        thread::sleep(Duration::from_millis(25));
    }
}

fn run(mut command: Command) -> Output {
    finish(
        command
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    )
}

fn start(env: &TestEnv, instance: &str) -> Output {
    let mut command = env.std_command();
    command.args(["start", "--instance", instance]);
    run(command)
}

fn connection(env: &TestEnv, instance: &str) -> Value {
    serde_json::from_slice(
        &fs::read(
            env.instance_root(instance)
                .join("state/reverse-connection.json"),
        )
        .unwrap(),
    )
    .unwrap()
}

fn write_reverse_config(env: &TestEnv, instance: &str, controller: &str, proxy: Option<&str>) {
    fs::create_dir_all(env.instance_root(instance)).unwrap();
    let mut reverse = toml::Table::new();
    reverse.insert("controllerUrl".into(), controller.into());
    reverse.insert("deviceToken".into(), "contract-token".into());
    if let Some(proxy) = proxy {
        reverse.insert("proxyUrl".into(), proxy.into());
    }
    let mut config = toml::Table::new();
    config.insert("version".into(), 1.into());
    config.insert("instance".into(), instance.into());
    config.insert("createdAt".into(), 0.into());
    config.insert("reverse".into(), reverse.into());
    fs::write(
        env.instance_root(instance).join("config.toml"),
        toml::to_string(&config).unwrap(),
    )
    .unwrap();
}

#[test]
fn reverse_initialization_failure_repeated_start_and_repaired_config_recover() {
    use std::net::TcpListener;
    use tungstenite::handshake::server::{Request, Response};

    let env = TestEnv::new();
    let instance = "reverse-init-retry";
    write_reverse_config(
        &env,
        instance,
        "http://127.0.0.1:1",
        Some("https://127.0.0.1:8443"),
    );

    let first = start(&env, instance);
    assert!(!first.status.success(), "{first:?}");
    assert!(
        String::from_utf8_lossy(&first.stderr)
            .contains("unsupported reverse proxy URL scheme: https"),
        "{first:?}; daemon log: {:?}",
        fs::read_to_string(env.instance_root(instance).join("logs/worker.log"))
    );
    let first_state = connection(&env, instance);
    assert_eq!(first_state["state"], "failed");
    assert!(first_state["generation"].as_u64().unwrap() > 0);

    let second = start(&env, instance);
    assert!(!second.status.success(), "{second:?}");
    assert!(
        String::from_utf8_lossy(&second.stderr)
            .contains("unsupported reverse proxy URL scheme: https")
    );
    let second_state = connection(&env, instance);
    assert_eq!(second_state["state"], "failed");
    assert_eq!(second_state["pid"], first_state["pid"]);
    assert!(
        second_state["generation"].as_u64().unwrap() > first_state["generation"].as_u64().unwrap()
    );

    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    listener.set_nonblocking(true).unwrap();
    let controller = format!("http://{}", listener.local_addr().unwrap());
    write_reverse_config(&env, instance, &controller, None);
    let server = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(15);
        let socket = loop {
            match listener.accept() {
                Ok((socket, _)) => break socket,
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        && Instant::now() < deadline =>
                {
                    thread::sleep(Duration::from_millis(25));
                }
                result => panic!("no recovered Reverse connection: {result:?}"),
            }
        };
        socket
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let mut socket =
            tungstenite::accept_hdr(socket, |request: &Request, mut response: Response| {
                assert_eq!(request.headers()["authorization"], "Bearer contract-token");
                response.headers_mut().insert(
                    "sec-websocket-protocol",
                    "devshell-worker-transport.v3".parse().unwrap(),
                );
                Ok(response)
            })
            .unwrap();
        socket
            .send(tungstenite::Message::Text("DSR2:ready".into()))
            .unwrap();
        // Keep Ready observable until the test explicitly stops its daemon.
        while socket.read().is_ok() {}
    });
    let recovered = start(&env, instance);
    assert!(recovered.status.success(), "{recovered:?}");
    let recovered: Value = serde_json::from_slice(&recovered.stdout).unwrap();
    assert_eq!(recovered["started"], false);
    let ready = connection(&env, instance);
    assert_eq!(ready["state"], "connected");
    assert_eq!(ready["pid"], first_state["pid"]);
    assert!(ready["generation"].as_u64().unwrap() > second_state["generation"].as_u64().unwrap());
    env.json_command(&["stop", "--instance", instance]);
    server.join().unwrap();
}

#[test]
fn ordinary_offline_start_keeps_retrying_until_explicit_stop() {
    use std::net::TcpListener;

    let env = TestEnv::new();
    let instance = "reverse-ordinary-offline";
    let reservation = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let controller = format!("http://{}", reservation.local_addr().unwrap());
    drop(reservation);
    write_reverse_config(&env, instance, &controller, None);
    let mut child = env
        .std_command()
        .args(["start", "--instance", instance])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut first_generation = None;
    loop {
        assert!(
            child.try_wait().unwrap().is_none(),
            "offline start returned before stop"
        );
        if let Ok(bytes) = fs::read(
            env.instance_root(instance)
                .join("state/reverse-connection.json"),
        ) {
            if let Ok(status) = serde_json::from_slice::<Value>(&bytes) {
                assert_ne!(status["state"], "failed");
                if let Some(generation) = status["generation"].as_u64().filter(|g| *g > 0) {
                    if first_generation.is_some_and(|first| generation > first) {
                        break;
                    }
                    first_generation = Some(generation);
                }
            }
        }
        if Instant::now() >= deadline {
            child.kill().ok();
            panic!(
                "offline connector did not retry: {:?}",
                child.wait_with_output().unwrap()
            );
        }
        thread::sleep(Duration::from_millis(50));
    }
    env.json_command(&["stop", "--instance", instance]);
    let output = finish(child);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("stopped before Reverse Ready"));
}

#[cfg(target_os = "linux")]
mod update {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::path::{Path, PathBuf};

    fn stripped_worker(directory: &Path) -> Vec<u8> {
        // Never strip Cargo's shared artifact. Each test owns its temporary ELF.
        let binary = directory.join("stripped-worker");
        fs::copy(assert_cmd::cargo::cargo_bin("devshell-worker"), &binary).unwrap();
        let output = Command::new("strip")
            .arg("--strip-unneeded")
            .arg(&binary)
            .output()
            .expect("strip fixture executable");
        assert!(output.status.success(), "strip failed: {output:?}");
        let bytes = fs::read(&binary).unwrap();
        assert!(
            bytes.starts_with(b"\x7fELF"),
            "fixture must remain a Linux ELF"
        );
        let output = Command::new(&binary).arg("--version").output().unwrap();
        assert!(
            output.status.success(),
            "stripped ELF must execute: {output:?}"
        );
        bytes
    }

    fn stage(home: &Path, base: &[u8], suffix: &[u8]) -> (PathBuf, String) {
        let mut bytes = base.to_vec();
        bytes.extend_from_slice(suffix);
        let sha = format!("{:x}", Sha256::digest(&bytes));
        let target = if cfg!(target_arch = "x86_64") {
            "linux-x64"
        } else {
            "linux-arm64"
        };
        let binary = home
            .join("workers")
            .join(target)
            .join(&sha)
            .join("devshell-worker");
        fs::create_dir_all(binary.parent().unwrap()).unwrap();
        fs::write(&binary, bytes).unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
        (binary, sha)
    }

    fn start_binary(env: &TestEnv, binary: &Path, instance: &str) -> Value {
        let mut command = env.std_command_for(binary);
        command.args(["start", "--instance", instance]);
        let output = run(command);
        assert!(output.status.success(), "{output:?}");
        serde_json::from_slice(&output.stdout).unwrap()
    }

    fn alias_race(rollback: bool) {
        let env = TestEnv::new();
        let home = env.instance_root("a").parent().unwrap().to_path_buf();
        let base = stripped_worker(env.home());
        let (previous, previous_sha) = stage(&home, &base, b"old daemon P");
        let (target, target_sha) = stage(&home, &base, b"");
        let (other, other_sha) = stage(&home, &base, b"other instance U");
        assert_ne!(previous_sha, target_sha);
        assert_ne!(previous_sha, other_sha);
        assert_ne!(target_sha, other_sha);
        let a = start_binary(&env, &previous, "update-a");
        let b = start_binary(&env, &other, "update-b");
        assert_eq!(
            env.json_command(&["status", "--instance", "update-a"])["workerSha256"],
            previous_sha
        );
        assert_eq!(
            env.json_command(&["status", "--instance", "update-b"])["workerSha256"],
            other_sha
        );
        let state_dir = env.instance_root("update-a").join("state");
        fs::write(state_dir.join("reverse-generation"), "7\n").unwrap();
        let alias = home.join("bin/devshell-worker");
        fs::create_dir_all(alias.parent().unwrap()).unwrap();
        // The alias already belongs to B before A even identifies its rollback
        // binary. A must use its daemon's SHA rather than this symlink.
        symlink(&other, &alias).unwrap();

        let reached = env.home().join("before-spawn");
        let release = env.home().join("release-spawn");
        let driver = env.home().join("install-spawn-barrier.sh");
        fs::write(
            &driver,
            r#"if [ ! -f "$1" ]; then
  : > "$1"
  remaining=200
  while [ ! -f "$2" ]; do
    remaining=$((remaining - 1))
    [ "$remaining" -gt 0 ] || exit 33
    sleep 0.05
  done
  if [ "$3" = rollback ]; then
    printf '{"DEVSHELL_WORKER_TEST_FAIL_AFTER_BIND":"1"}'
    exit 0
  fi
fi
printf '{"DEVSHELL_WORKER_TEST_FAIL_AFTER_BIND":null}'
"#,
        )
        .unwrap();
        // An existing daemon environment provider supplies an exact barrier
        // after install and before process spawn, without production test hooks.
        let execution = json!({"environment": [{
            "order": 1, "name": "barrier", "phase": "daemon", "content": {"required": true},
            "driver": {"name": "barrier", "version": 1, "executable": "/bin/sh",
                "args": [driver, reached, release, if rollback {"rollback"} else {"success"}]}
        }]});
        let mut helper = env
            .std_command_for(&target)
            .env("DEVSHELL_WORKER_EXECUTION_CONFIG", execution.to_string())
            .args([
                "_upgrade-restart",
                "--instance",
                "update-a",
                "--expected-pid",
                &a["pid"].to_string(),
                "--expected-generation",
                "7",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        while !reached.exists() {
            let exited = helper.try_wait().unwrap().is_some();
            if exited || Instant::now() >= deadline {
                if !exited {
                    // It may exit between try_wait and kill; keep its actual
                    // error output observable in that race too.
                    helper.kill().ok();
                }
                let output = finish(helper);
                panic!(
                    "helper never reached install/spawn boundary (exited early: {exited}); \
                     status: {}; stdout: {}; stderr: {}; daemon log: {:?}; \
                     recorded PID: {:?}; generation: {:?}; original daemon stat: {:?}",
                    output.status,
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr),
                    fs::read_to_string(env.instance_root("update-a").join("logs/worker.log")),
                    fs::read_to_string(state_dir.join("worker.pid")),
                    fs::read_to_string(state_dir.join("reverse-generation")),
                    fs::read_to_string(format!("/proc/{}/stat", a["pid"])),
                );
            }
            thread::sleep(Duration::from_millis(25));
        }
        assert_eq!(alias.canonicalize().unwrap(), target);
        let next_alias = alias.with_extension("next");
        symlink(&other, &next_alias).unwrap();
        fs::rename(next_alias, &alias).unwrap();
        fs::write(&release, b"continue").unwrap();
        let output = finish(helper);
        assert_eq!(output.status.success(), !rollback, "{output:?}");
        if rollback {
            assert!(
                String::from_utf8_lossy(&output.stderr).contains("previous version restored"),
                "{output:?}"
            );
        }
        let after_a = env.json_command(&["status", "--instance", "update-a"]);
        assert_eq!(after_a["running"], true);
        let handshake = env.rpc(
            "update-a",
            "core",
            &json!({
                "protocol": "rpc", "type": "request", "id": "updated-identity",
                "method": "worker.handshake", "message": {
                    "protocolRange": {"min": "1.0.0", "max": "1.0.0"},
                    "clientName": "update-contract", "clientVersion": "1.0.0"
                }
            }),
        );
        assert_eq!(
            handshake["message"]["workerVersion"],
            env!("CARGO_PKG_VERSION")
        );
        assert_eq!(
            handshake["message"]["workerSha256"],
            after_a["workerSha256"]
        );
        assert_ne!(after_a["pid"], a["pid"]);
        assert_eq!(
            after_a["workerSha256"],
            if rollback { previous_sha } else { target_sha }
        );
        assert_eq!(
            fs::read_to_string(state_dir.join("reverse-generation")).unwrap(),
            "7\n"
        );
        let after_b = env.json_command(&["status", "--instance", "update-b"]);
        assert_eq!(after_b["running"], true);
        assert_eq!(after_b["pid"], b["pid"]);
        assert_eq!(after_b["workerSha256"], other_sha);
        assert_eq!(alias.canonicalize().unwrap(), other);
        env.json_command(&["stop", "--instance", "update-a"]);
        env.json_command(&["stop", "--instance", "update-b"]);
    }

    #[test]
    fn stripped_fixture_preserves_executable_and_distinct_content_identities() {
        let directory = tempfile::tempdir().unwrap();
        let base = stripped_worker(directory.path());
        let source_len = fs::metadata(assert_cmd::cargo::cargo_bin("devshell-worker"))
            .unwrap()
            .len();
        eprintln!("fixture ELF: {source_len} -> {} bytes", base.len());
        let mut identities = std::collections::HashSet::new();
        for suffix in [b"old daemon P".as_slice(), b"", b"other instance U"] {
            let (binary, sha) = stage(directory.path(), &base, suffix);
            assert!(identities.insert(sha.clone()));
            assert_eq!(
                format!("{:x}", Sha256::digest(fs::read(&binary).unwrap())),
                sha
            );
            let output = Command::new(binary).arg("--version").output().unwrap();
            assert!(output.status.success(), "{output:?}");
            assert!(String::from_utf8_lossy(&output.stdout).contains(env!("CARGO_PKG_VERSION")));
        }
    }

    #[test]
    fn helper_starts_target_content_when_other_instance_switches_alias() {
        alias_race(false);
    }

    #[test]
    fn helper_rolls_back_daemon_content_without_clobbering_other_instance_alias() {
        alias_race(true);
    }
}
