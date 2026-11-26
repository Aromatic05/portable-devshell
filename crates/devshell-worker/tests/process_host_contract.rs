#![cfg(unix)]

#[path = "support/process.rs"]
mod process_fixture;
mod support;

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::time::{Duration, Instant};

use base64::{Engine, engine::general_purpose::STANDARD};
use process_fixture::WorkerFixture;
use serde_json::{Value, json};
use support::TestEnv;

const INSTANCE: &str = "process-host";

struct Fixture {
    child: Child,
    socket: PathBuf,
    generation: String,
    env: TestEnv,
}

impl Fixture {
    fn start() -> Self {
        let env = TestEnv::new();
        let instance = INSTANCE;
        let child = env
            .std_command()
            .args(["_process-host", "--instance", instance])
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let mut fixture = Self {
            child,
            socket: env.socket_file(instance).with_file_name("process.sock"),
            env,
            generation: String::new(),
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Ok(response) = request(&fixture.socket, "process.handshake", json!({})) {
                if response["ok"] == true {
                    fixture.generation = response["result"]["generation"]
                        .as_str()
                        .unwrap()
                        .to_owned();
                    break;
                }
            }
            assert!(
                Instant::now() < deadline,
                "process host did not become ready"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        fixture
    }

    fn call(&self, method: &str, mut input: Value) -> Value {
        if method != "process.handshake" {
            input["generation"] = json!(self.generation);
        }
        let result = request(&self.socket, method, input).unwrap();
        assert_eq!(result["ok"], true, "{result}");
        result["result"].clone()
    }

    fn spawn(&self, command: &str, tty: bool, stdin: Option<&str>, keep_stdin: bool) -> String {
        self.call(
            "process.v1.spawn",
            json!({
                "command": command, "cwd": self.env.protocol_workspace(),
                "tty": tty, "stdin": stdin, "keepStdin": keep_stdin,
            }),
        )["id"]
            .as_str()
            .unwrap()
            .to_string()
    }

    fn read(&self, id: &str, from_seq: u64, wait_ms: u64) -> Value {
        self.call(
            "process.v1.read",
            json!({
                "id": id, "fromSeq": from_seq, "waitMs": wait_ms,
            }),
        )
    }

    fn input(&self, id: &str, bytes: &[u8]) {
        self.call(
            "process.v1.input",
            json!({
                "id": id, "dataBase64": STANDARD.encode(bytes),
            }),
        );
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_some() {
            return;
        }
        let retired = request(
            &self.socket,
            "process.v1.retire",
            json!({"generation": self.generation}),
        )
        .is_ok_and(|response| response["ok"] == true);
        if !retired {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}

fn request(socket: &Path, method: &str, params: Value) -> std::io::Result<Value> {
    let mut stream = UnixStream::connect(socket)?;
    stream.set_read_timeout(Some(Duration::from_secs(15)))?;
    stream.set_write_timeout(Some(Duration::from_secs(15)))?;
    let body = serde_json::to_vec(&json!({
        "type": "request", "id": "fixture", "method": method, "params": params,
    }))
    .unwrap();
    stream.write_all(&(body.len() as u32).to_be_bytes())?;
    stream.write_all(&body)?;
    let mut length = [0; 4];
    stream.read_exact(&mut length)?;
    let mut body = vec![0; u32::from_be_bytes(length) as usize];
    stream.read_exact(&mut body)?;
    Ok(serde_json::from_slice(&body)?)
}

fn output(page: &Value, channel: &str) -> String {
    let bytes: Vec<u8> = page["frames"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|frame| frame["channel"] == channel)
        .flat_map(|frame| {
            STANDARD
                .decode(frame["dataBase64"].as_str().unwrap())
                .unwrap()
        })
        .collect();
    String::from_utf8(bytes).unwrap()
}

fn wait_for_output(fixture: &Fixture, id: &str, channel: &str, marker: &str) {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut cursor = 0;
    let mut received = String::new();
    loop {
        let page = fixture.read(id, cursor, 500);
        received.push_str(&output(&page, channel));
        if received.contains(marker) {
            return;
        }
        if let Some(last) = page["frames"].as_array().unwrap().last() {
            cursor = last["seq"].as_u64().unwrap();
        }
        assert!(
            Instant::now() < deadline,
            "missing output: {received:?}, {page}"
        );
    }
}

fn finish(fixture: &Fixture, id: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut cursor = 0;
    loop {
        let page = fixture.read(id, cursor, 500);
        if page["process"]["state"] != "running" {
            return fixture.read(id, 0, 0);
        }
        if let Some(last) = page["frames"].as_array().unwrap().last() {
            cursor = last["seq"].as_u64().unwrap();
        }
        assert!(Instant::now() < deadline, "process did not finish: {page}");
    }
}

#[test]
fn independent_host_owns_pipe_and_pty_across_request_disconnects() {
    let fixture = Fixture::start();
    let pid = fixture.call("process.handshake", json!({}))["pid"]
        .as_u64()
        .unwrap();
    assert_eq!(pid, u64::from(fixture.child.id()));

    let pipe = fixture.spawn(
        "printf 'ready\\n'; IFS= read -r value; printf 'out:%s\\n' \"$value\"; printf 'error\\n' >&2; exit 7",
        false, None, true,
    );
    wait_for_output(&fixture, &pipe, "stdout", "ready");
    fixture.input(&pipe, b"hello\n");
    let finished = finish(&fixture, &pipe);
    assert_eq!(finished["process"]["state"], "exited");
    assert_eq!(finished["process"]["exit"]["exitCode"], 7);
    assert_eq!(output(&finished, "stdout"), "ready\nout:hello\n");
    assert_eq!(output(&finished, "stderr"), "error\n");
    // A separate reader sees the same output; no global cursor is consumed.
    assert_eq!(finished, fixture.read(&pipe, 0, 0));

    let eof = fixture.spawn("cat", false, Some("initial stdin\n"), false);
    let finished = finish(&fixture, &eof);
    assert_eq!(finished["process"]["exit"]["exitCode"], 0);
    assert_eq!(output(&finished, "stdout"), "initial stdin\n");

    let pty = fixture.spawn(
        "test -t 0 && test -t 1 || exit 12; stty -echo; printf 'ready\\n'; IFS= read -r value; printf 'received:%s\\n' \"$value\"; exit 9",
        true, None, true,
    );
    wait_for_output(&fixture, &pty, "terminal", "ready");
    let before = fixture.read(&pty, 0, 0);
    let screen = fixture.call("process.v1.inspect", json!({"id": pty}));
    assert_eq!(screen["seq"], before["process"]["latestSeq"]);
    assert!(screen["text"].as_str().unwrap().contains("ready"));
    assert_eq!(fixture.read(&pty, 0, 0), before);
    fixture.call(
        "process.v1.resize",
        json!({ "id": pty, "cols": 100, "rows": 40 }),
    );
    let resized = fixture.call("process.v1.inspect", json!({"id": pty}));
    assert_eq!(resized["cols"], 100);
    assert_eq!(resized["rows"], 40);
    fixture.input(&pty, b"world\n");
    let finished = finish(&fixture, &pty);
    assert_eq!(finished["process"]["state"], "exited");
    assert_eq!(finished["process"]["exit"]["exitCode"], 9);
    assert!(output(&finished, "terminal").contains("received:world"));
    let final_screen = fixture.call("process.v1.inspect", json!({"id": pty}));
    assert_eq!(final_screen["seq"], finished["process"]["latestSeq"]);
    assert!(
        final_screen["text"]
            .as_str()
            .unwrap()
            .contains("received:world")
    );
    assert_eq!(
        fixture
            .call("process.v1.list", json!({}))
            .as_array()
            .unwrap()
            .len(),
        3
    );

    let running = fixture.spawn("sleep 30", false, None, false);
    fixture.call("process.v1.kill", json!({ "id": running }));
    let killed = finish(&fixture, &running);
    assert_eq!(killed["process"]["exit"]["signal"], 9);
    // Retiring this isolated host also terminates any remaining live task.
    let _ = fixture.spawn("sleep 30", true, None, true);
    fixture.call("process.v1.retire", json!({}));
}

#[test]
fn worker_restart_preserves_process_host_and_retirement_releases_it() {
    let fixture = Fixture::start();
    let before = fixture.call("process.handshake", json!({}));
    assert_eq!(before["instance"], INSTANCE);
    assert_eq!(before["version"], 1);
    let task = fixture.spawn(
        "printf 'ready\\n'; IFS= read -r value; printf 'received:%s\\n' \"$value\"",
        false,
        None,
        true,
    );
    wait_for_output(&fixture, &task, "stdout", "ready");
    let listed = fixture.env.json_command(&["terminal", "list"]);
    assert!(
        listed
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["id"] == task)
    );
    let start = fixture.env.json_command(&["start", "--instance", INSTANCE]);
    assert_eq!(start["started"], true);
    assert_eq!(
        fixture.env.json_command(&["stop", "--instance", INSTANCE])["stopped"],
        true
    );
    assert_eq!(
        fixture.env.json_command(&["start", "--instance", INSTANCE])["started"],
        true
    );
    let after = fixture.call("process.handshake", json!({}));
    assert_eq!(after, before);
    assert_eq!(fixture.read(&task, 0, 0)["process"]["state"], "running");
    let wrong_generation = request(
        &fixture.socket,
        "process.v1.kill",
        json!({"id": task, "generation": "previous-generation"}),
    )
    .unwrap();
    assert_eq!(wrong_generation["error"]["code"], "process.staleGeneration");
    fixture.input(&task, b"reconnected\n");
    let finished = finish(&fixture, &task);
    assert!(output(&finished, "stdout").contains("received:reconnected"));
    let _running = fixture.spawn("sleep 30", true, None, true);
    fixture.env.json_command(&["stop", "--instance", INSTANCE]);
    assert_eq!(
        fixture
            .env
            .json_command(&["retire", "--instance", INSTANCE])["retired"],
        true
    );
    assert!(request(&fixture.socket, "process.handshake", json!({})).is_err());
    assert_eq!(fixture.env.json_command(&["terminal", "list"]), json!([]));
}

struct LocalAttach {
    child: Child,
    master: std::fs::File,
    received: Vec<u8>,
}

impl LocalAttach {
    fn start(env: &TestEnv, task: &str) -> Self {
        use std::os::fd::AsRawFd;
        use std::os::unix::process::CommandExt;
        let opened = nix::pty::openpty(
            Some(&nix::pty::Winsize {
                ws_row: 24,
                ws_col: 80,
                ws_xpixel: 0,
                ws_ypixel: 0,
            }),
            None,
        )
        .unwrap();
        let slave = opened.slave;
        let mut command = env.std_command();
        command
            .args(["terminal", "attach", task, "--takeover"])
            .stdin(Stdio::from(slave.try_clone().unwrap()))
            .stdout(Stdio::from(slave.try_clone().unwrap()))
            .stderr(Stdio::from(slave));
        unsafe {
            command.pre_exec(|| {
                nix::unistd::setsid().map_err(std::io::Error::other)?;
                if nix::libc::ioctl(0, nix::libc::TIOCSCTTY, 0) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = command.spawn().unwrap();
        let master = std::fs::File::from(opened.master);
        // Bound the read deadline without blocking on the attached terminal.
        unsafe {
            let fd = master.as_raw_fd();
            let flags = nix::libc::fcntl(fd, nix::libc::F_GETFL);
            assert_ne!(
                nix::libc::fcntl(fd, nix::libc::F_SETFL, flags | nix::libc::O_NONBLOCK),
                -1
            );
        }
        Self {
            child,
            master,
            received: Vec::new(),
        }
    }

    fn expect(&mut self, marker: &str) {
        let deadline = Instant::now() + Duration::from_secs(8);
        let mut buffer = [0; 8192];
        loop {
            if self
                .received
                .windows(marker.len())
                .any(|bytes| bytes == marker.as_bytes())
            {
                return;
            }
            match self.master.read(&mut buffer) {
                Ok(n) if n != 0 => self.received.extend_from_slice(&buffer[..n]),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                other => panic!(
                    "attach read ended: {other:?}; output={}",
                    String::from_utf8_lossy(&self.received)
                ),
            }
            assert!(
                Instant::now() < deadline,
                "missing {marker}: {}",
                String::from_utf8_lossy(&self.received)
            );
        }
    }

    fn input(&mut self, bytes: &[u8]) {
        self.master.write_all(bytes).unwrap();
    }

    fn detach(&mut self) {
        self.input(&[0x1d]);
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert!(status.success(), "{status}");
                return;
            }
            assert!(Instant::now() < deadline, "attach did not detach");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for LocalAttach {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

#[test]
fn worker_command_and_native_attach_share_one_pty() {
    let fixture = WorkerFixture::start(INSTANCE);
    assert_eq!(fixture.env.json_command(&["terminal", "list"]), json!([]));
    let started = fixture.tool("bash_run", json!({
        "command": "stty -echo; printf 'attach-ready\\n'; IFS= read -r human; printf 'human:%s\\n' \"$human\"; printf '\\033]2;raw-title\\007'; IFS= read -r model; printf 'model:%s\\n' \"$model\"",
        "pty": true, "waitMs": 20,
    }));
    assert_eq!(started["termination"], "running");
    assert_eq!(started["task"]["pty"], true);
    let task = started["task"]["id"].as_str().unwrap().to_owned();
    let listed = fixture.env.json_command(&["terminal", "list"]);
    assert!(
        listed
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["id"] == task && item["instance"] == INSTANCE)
    );
    let mut attach = LocalAttach::start(&fixture.env, &task);
    attach.expect("attach-ready");
    let rejected = fixture.env.rpc(
        INSTANCE,
        "tool",
        &json!({
            "protocol": "rpc", "type": "request", "id": "model-during-takeover",
            "method": "task_input",
            "message": {"input": {"task": task, "input": "unwanted\n"},
                "context": {"workspace": fixture.env.protocol_workspace()}}
        }),
    );
    assert_eq!(rejected["type"], "error", "{rejected}");
    let observed_during_takeover = fixture.tool("task_input", json!({"task": task, "waitMs": 0}));
    assert_eq!(
        observed_during_takeover["task"]["humanControl"], true,
        "{observed_during_takeover}"
    );
    assert!(
        rejected["error"]["message"]
            .as_str()
            .unwrap()
            .contains("controlled by another participant")
    );
    attach.input(b"operator\n");
    attach.expect("human:operator");
    // The live client must receive the original OSC control sequence,
    // which cannot be reconstructed from the visible screen.
    attach.expect("\x1b]2;raw-title\x07");
    attach.detach();
    let inspected = fixture.tool("task_inspect", json!({"task": task}));
    assert_eq!(inspected["task"], task);
    assert_eq!(inspected["state"], "running");
    assert_eq!(inspected["humanControl"], false);
    assert!(inspected.get("formatted").is_none(), "{inspected}");
    assert!(inspected.get("restore").is_none(), "{inspected}");
    assert!(
        inspected["text"]
            .as_str()
            .unwrap()
            .contains("human:operator")
    );
    fixture.tool("task_input", json!({"task": task, "input": "agent\n"}));
    let finished = fixture.wait_task(&task, Value::Null);
    assert_eq!(finished["exitCode"], 0);
    assert!(
        finished["stdout"]
            .as_str()
            .unwrap()
            .contains("human:operator")
    );
    assert!(finished["stdout"].as_str().unwrap().contains("model:agent"));
}

#[test]
fn hosted_pipe_wait_deadline_and_retained_output() {
    let fixture = WorkerFixture::start(INSTANCE);
    let task = fixture.tool("bash_run", json!({
        "command": "sleep 0.1; printf 'out:pipe\\n'; printf 'error\\n' >&2; exit 7",
        "waitMs": 0,
    }));
    assert_eq!(task["termination"], "running");
    assert_eq!(task["task"]["pty"], false);
    let id = task["task"]["id"].as_str().unwrap();
    let write_denied = fixture.tool_raw("task_input", json!({"task": id, "input": "pipe\n"}));
    assert_eq!(write_denied["type"], "error", "{write_denied}");
    assert_eq!(write_denied["error"]["code"], "process.stdinClosed");
    assert_eq!(
        write_denied["error"]["message"],
        "stdin is closed for non-PTY tasks; use task_manage(command=\"close\", task=...) to stop a running task, or rerun bash_run with pty=true for interactive input"
    );
    let result = fixture.wait_task(id, task["cursor"].clone());
    assert_eq!(result["exitCode"], 7);
    assert_eq!(result["stdout"], "out:pipe\n");
    assert_eq!(result["stderr"], "error\n");

    let large = fixture.tool(
        "bash_run",
        json!({
            "command": "head -c 6291456 /dev/zero | tr '\\000' x",
            "waitMs": 10000,
        }),
    );
    assert_eq!(large["exitCode"], 0, "{large}");
    assert_eq!(large["stdoutBytes"], 6291456);
    assert_eq!(large["stdoutTruncated"], true);
    assert_eq!(large["stdoutArtifact"]["storedBytes"], 6291456);
}

#[test]
fn remote_terminal_rpc_controls_the_model_pty_and_releases_it() {
    let fixture = WorkerFixture::start(INSTANCE);
    let started = fixture.tool("bash_run", json!({
        "command": "stty -echo; printf 'ready\\n'; IFS= read -r human; printf 'remote:%s\\n' \"$human\"; IFS= read -r model; printf 'model:%s\\n' \"$model\"",
        "pty": true, "waitMs": 20,
    }));
    let id = started["task"]["id"].as_str().unwrap();
    let call = |method: &str, message: Value| {
        fixture.env.rpc(INSTANCE, "terminal", &json!({
        "protocol": "rpc", "type": "request", "id": method, "method": method, "message": message
    }))
    };
    let listed = call("terminal.list", json!({}));
    assert_eq!(listed["type"], "reply", "{listed}");
    let descriptor = listed["message"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["terminalId"] == id)
        .unwrap();
    let taken = call(
        "terminal.control",
        json!({"terminalId": id, "generation": descriptor["generation"]}),
    );
    assert_eq!(taken["type"], "reply", "{taken}");
    let token = taken["message"]["controller"].as_str().unwrap();
    let rejected = fixture.env.rpc(INSTANCE, "tool", &json!({
        "protocol": "rpc", "type": "request", "id": "model-during-remote-control", "method": "task_input",
        "message": {"input": {"task": id, "input": "unwanted\n"}, "context": {"workspace": fixture.env.protocol_workspace()}}
    }));
    assert_eq!(rejected["type"], "error", "{rejected}");
    let observed_during_takeover = fixture.tool("task_input", json!({"task": id, "waitMs": 0}));
    assert_eq!(
        observed_during_takeover["task"]["humanControl"], true,
        "{observed_during_takeover}"
    );
    let resized = call(
        "terminal.resize",
        json!({"terminalId": id, "generation": descriptor["generation"], "version": taken["message"]["session"]["version"], "clientSeq": 1, "controller": token, "cols": 101, "rows": 31}),
    );
    assert_eq!(resized["type"], "reply", "{resized}");
    let written = call(
        "terminal.write",
        json!({"terminalId": id, "generation": descriptor["generation"], "version": resized["message"]["version"], "clientSeq": 2, "controller": token, "data": STANDARD.encode("operator\n")}),
    );
    assert_eq!(written["type"], "reply", "{written}");
    let released = call(
        "terminal.control",
        json!({"terminalId": id, "generation": descriptor["generation"], "controller": token}),
    );
    assert_eq!(released["type"], "reply", "{released}");
    fixture.tool("task_input", json!({"task": id, "input": "agent\n"}));
    let result = fixture.wait_task(id, Value::Null);
    assert_eq!(result["exitCode"], 0, "{result}");
    assert!(
        result["stdout"]
            .as_str()
            .unwrap()
            .contains("remote:operator")
    );
    assert!(result["stdout"].as_str().unwrap().contains("model:agent"));
}

#[test]
fn persistent_terminal_auto_respawns_after_exit_and_closes_cleanly() {
    let fixture = WorkerFixture::start("process-persistent");
    let created = fixture.tool(
        "task_manage",
        json!({
            "command": "create",
            "name": "dev-shell",
            "cwd": "./",
            "shell": "/bin/sh",
            "cols": 90,
            "rows": 30
        }),
    );
    assert!(
        created["cursor"]
            .as_str()
            .is_some_and(|cursor| cursor.starts_with("tc2_")),
        "task_manage(create) must return an initial opaque cursor: {created}"
    );
    let summary = &created["task"];
    assert_eq!(summary["kind"], "terminal", "{created}");
    assert_eq!(summary["persistent"], true, "{created}");
    assert_eq!(summary["pty"], true, "{created}");
    assert_eq!(summary["state"], "running", "{created}");
    assert_eq!(summary["name"], "dev-shell", "{created}");
    assert_eq!(summary["command"], "/bin/sh", "{created}");
    assert!(summary["cwd"].as_str().is_some(), "{created}");
    assert!(summary["createdAtMs"].as_u64().unwrap_or(0) > 0, "{created}");
    let id = summary["id"].as_str().unwrap().to_owned();

    // Also start a non-persistent task to verify task_manage(list) distinguishes both kinds.
    let job = fixture.tool("bash_run", json!({"command": "printf listed-job"}));
    let job_id = job["task"]["id"].as_str().unwrap().to_owned();

    let listed = fixture.tool("task_manage", json!({"command": "list"}));
    let tasks = listed["tasks"].as_array().unwrap();
    let term_entry = tasks.iter().find(|entry| entry["id"] == id).expect("terminal in list");
    assert_eq!(term_entry["kind"], "terminal");
    assert_eq!(term_entry["persistent"], true);
    assert_eq!(term_entry["name"], "dev-shell");
    assert_eq!(term_entry["command"], "/bin/sh");
    assert!(term_entry["cwd"].as_str().is_some());
    let job_entry = tasks.iter().find(|entry| entry["id"] == job_id).expect("task in list");
    assert_eq!(job_entry["kind"], "task");
    assert_eq!(job_entry["persistent"], false);
    assert_eq!(job_entry["command"], "printf listed-job");
    assert!(job_entry["cwd"].as_str().is_some());

    // Write a command and verify PTY echo settle captures both echo and command output.
    let extract_pid = |text: &str, marker: &str| -> Option<String> {
        text.split(marker).skip(1).find_map(|rest| {
            let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            (!digits.is_empty()).then_some(digits)
        })
    };
    let first = fixture.tool(
        "task_input",
        json!({
            "task": id,
            "input": "printf '\\nFIRST-PID:%s\\n' \"$$\"\n",
            "waitMs": 5000
        }),
    );
    assert_eq!(first["termination"], "running", "{first}");
    let first_stdout = first["stdout"].as_str().unwrap();
    let first_pid = extract_pid(first_stdout, "FIRST-PID:")
        .unwrap_or_else(|| panic!("missing FIRST-PID in {first_stdout:?}"));
    let cursor = first["cursor"].as_str().unwrap().to_owned();
    assert!(cursor.starts_with("tc2_"), "{cursor}");

    // Exit the interactive shell; persistent terminal must automatically respawn a fresh shell.
    let after_exit = fixture.tool(
        "task_input",
        json!({
            "task": id,
            "input": "printf '\\033[?1049h'; exit\n",
            "cursor": cursor,
            "waitMs": 1500
        }),
    );
    assert_eq!(after_exit["termination"], "running", "{after_exit}");
    let mut cursor = after_exit["cursor"].as_str().unwrap().to_owned();
    let mut respawn_output = after_exit["stdout"].as_str().unwrap().to_owned();

    // Send a command to the respawned shell (retry briefly if shell is still initializing).
    let deadline = Instant::now() + Duration::from_secs(5);
    let second_pid = loop {
        let reply = fixture.tool_raw(
            "task_input",
            json!({
                "task": id,
                "input": "printf '\\nSECOND-PID:%s\\n' \"$$\"\n",
                "cursor": cursor,
                "waitMs": 2000
            }),
        );
        if reply["type"] == "reply" {
            let msg = &reply["message"];
            assert_eq!(msg["termination"], "running", "{msg}");
            cursor = msg["cursor"].as_str().unwrap().to_owned();
            let chunk = msg["stdout"].as_str().unwrap();
            respawn_output.push_str(chunk);
            if let Some(pid) = extract_pid(chunk, "SECOND-PID:") {
                break pid;
            }
        }
        assert!(Instant::now() < deadline, "respawned shell did not respond: {reply}");
        std::thread::sleep(Duration::from_millis(50));
    };
    assert_ne!(first_pid, second_pid, "respawned shell must have a new PID");
    assert!(
        respawn_output.contains("[shell restarted]"),
        "expected respawn reset banner in output: {respawn_output:?}"
    );

    let inspected = fixture.tool("task_inspect", json!({"task": id}));
    assert_eq!(inspected["task"], id);
    assert_eq!(inspected["state"], "running");
    assert_eq!(inspected["cols"], 90);
    assert_eq!(inspected["rows"], 30);
    assert_eq!(inspected["alternateScreen"], false, "{inspected}");
    assert!(inspected.get("formatted").is_none(), "{inspected}");
    assert!(inspected.get("restore").is_none(), "{inspected}");
    assert!(
        inspected["text"]
            .as_str()
            .unwrap()
            .contains(&format!("SECOND-PID:{second_pid}")),
        "{inspected}"
    );

    // untilExit is rejected on persistent interactive terminals (they auto-respawn).
    let until_exit_denied = fixture.tool_raw(
        "task_input",
        json!({
            "task": id,
            "untilExit": true,
            "waitMs": 500
        }),
    );
    assert_eq!(until_exit_denied["type"], "error", "{until_exit_denied}");
    assert_eq!(
        until_exit_denied["error"]["code"],
        "tool.invalidArguments"
    );

    // Writing input without cursor starts at the current tail, not from byte 0.
    let tail_only = fixture.tool(
        "task_input",
        json!({
            "task": id,
            "input": "printf '\\nTAIL-ONLY-MARKER\\n'\n",
            "waitMs": 2000
        }),
    );
    assert_eq!(tail_only["termination"], "running", "{tail_only}");
    let tail_stdout = tail_only["stdout"].as_str().unwrap();
    assert!(tail_stdout.contains("TAIL-ONLY-MARKER"), "{tail_only}");
    assert!(
        !tail_stdout.contains(&format!("FIRST-PID:{first_pid}")),
        "omitting cursor while writing input must not replay earlier transcript: {tail_stdout:?}"
    );
    cursor = tail_only["cursor"].as_str().unwrap().to_owned();

    // Explicitly close the persistent terminal; it must NOT respawn and must exit cleanly.
    let closed = fixture.tool("task_manage", json!({"command": "close", "task": id}));
    assert_eq!(closed["closedTask"], id, "{closed}");
    assert_eq!(closed["accepted"], true, "{closed}");
    assert_eq!(closed["state"], "exited", "{closed}");

    // Wait for the terminal after closing; already-closed persistent terminal allows reading final state.
    let final_state = fixture.tool(
        "task_input",
        json!({
            "task": id,
            "cursor": cursor,
            "waitMs": 1000
        }),
    );
    assert_ne!(final_state["termination"], "running", "{final_state}");
}

#[test]
fn task_input_opaque_cursor_and_manage_validation() {
    let fixture = WorkerFixture::start("process-cursor-validation");
    let started = fixture.tool(
        "bash_run",
        json!({
            "command": "printf 'line-1\\n'; sleep 0.15; printf 'line-2\\n'",
            "waitMs": 0
        }),
    );
    let id = started["task"]["id"].as_str().unwrap().to_owned();
    let cursor1 = started["cursor"].as_str().unwrap().to_owned();
    assert!(cursor1.starts_with("tc2_"), "{started}");

    // Invalid cursor must fail with tool.invalidArguments.
    let bad_cursor = fixture.tool_raw(
        "task_input",
        json!({"task": id, "cursor": "not-a-cursor", "waitMs": 100}),
    );
    assert_eq!(bad_cursor["type"], "error", "{bad_cursor}");
    assert_eq!(bad_cursor["error"]["code"], "tool.invalidArguments");
    assert_eq!(bad_cursor["error"]["message"], "invalid task cursor");

    // Incremental polling via opaque cursor collects remaining output without duplication.
    let mut combined = started["stdout"].as_str().unwrap().to_owned();
    let rest = fixture.tool(
        "task_input",
        json!({
            "task": id,
            "cursor": cursor1,
            "waitMs": 5000,
            "untilExit": true
        }),
    );
    assert_eq!(rest["termination"], "exited", "{rest}");
    assert_eq!(rest["untilExit"], true, "{rest}");
    combined.push_str(rest["stdout"].as_str().unwrap());
    assert_eq!(combined, "line-1\nline-2\n");

    let other = fixture.tool("bash_run", json!({"command": "printf 12345678901234567890"}));
    let mixed = fixture.tool_raw(
        "task_input",
        json!({"task": other["task"]["id"], "cursor": rest["cursor"], "waitMs": 0}),
    );
    assert_eq!(mixed["type"], "error", "{mixed}");
    assert_eq!(mixed["error"]["code"], "tool.invalidArguments", "{mixed}");
    assert_eq!(mixed["error"]["message"], "task cursor does not belong to task", "{mixed}");

    // task_manage validation checks.
    for invalid in [
        json!({"command": "list", "task": id}),
        json!({"command": "close"}),
        json!({"command": "create", "task": id}),
        json!({"command": "create", "name": "-invalid-start"}),
    ] {
        let response = fixture.tool_raw("task_manage", invalid.clone());
        assert_eq!(response["type"], "error", "{invalid}: {response}");
    }
}

#[test]
fn persistent_terminal_rapid_exit_breaks_respawn_loop() {
    let fixture = WorkerFixture::start("process-respawn-circuit");
    let created = fixture.tool(
        "task_manage",
        json!({
            "command": "create",
            "name": "broken-shell",
            "cwd": "./",
            "shell": "/bin/false"
        }),
    );
    let id = created["task"]["id"].as_str().unwrap().to_owned();
    let deadline = Instant::now() + Duration::from_secs(6);
    loop {
        let listed = fixture.tool("task_manage", json!({"command": "list"}));
        let entry = listed["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == id)
            .expect("terminal listed");
        if entry["state"] == "failed" {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "broken persistent shell never tripped circuit breaker: {entry}"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    for input in [json!({"task": id, "waitMs": 0}), json!({"task": id, "input": "\n", "waitMs": 0})] {
        let reply = fixture.tool_raw("task_input", input);
        assert_eq!(reply["type"], "error", "{reply}");
        assert_eq!(reply["error"]["code"], "process.taskFailed", "{reply}");
        assert_eq!(reply["error"]["message"], "persistent terminal shell exited repeatedly", "{reply}");
    }
    let healthy = fixture.tool("bash_run", json!({"command": "printf healthy"}));
    assert_eq!(healthy["stdout"], "healthy", "{healthy}");
}

#[test]
fn task_input_without_cursor_reports_timeout_when_no_new_output_follows_input() {
    let fixture = WorkerFixture::start("process-input-timeout-reason");
    let started = fixture.tool(
        "bash_run",
        json!({
            "command": "stty -echo; printf 'READY\\n'; IFS= read -r line; printf 'GOT:%s\\n' \"$line\"",
            "pty": true,
            "waitMs": 300
        }),
    );
    let id = started["task"]["id"].as_str().unwrap().to_owned();
    assert_eq!(started["termination"], "running", "{started}");
    assert!(
        started["stdout"].as_str().unwrap().contains("READY"),
        "{started}"
    );

    // Send a character without newline while echo is disabled and cursor is omitted:
    // latestSeq is already > 0 from READY, yet no new output arrives after input.
    let no_response = fixture.tool(
        "task_input",
        json!({
            "task": id,
            "input": "a",
            "waitMs": 200
        }),
    );
    assert_eq!(no_response["termination"], "running", "{no_response}");
    assert_eq!(no_response["waitReason"], "timeout", "{no_response}");

    let done = fixture.tool(
        "task_input",
        json!({
            "task": id,
            "input": "bc\n",
            "cursor": no_response["cursor"],
            "waitMs": 3000,
            "untilExit": true
        }),
    );
    assert_eq!(done["termination"], "exited", "{done}");
    assert!(done["stdout"].as_str().unwrap().contains("GOT:abc"), "{done}");
}
