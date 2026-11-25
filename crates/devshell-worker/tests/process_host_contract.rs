#![cfg(unix)]

mod support;

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::time::{Duration, Instant};

use base64::{Engine, engine::general_purpose::STANDARD};
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

struct WorkerFixture {
    env: TestEnv,
}

impl WorkerFixture {
    fn start() -> Self {
        let fixture = Self {
            env: TestEnv::new(),
        };
        fixture.env.json_command(&["start", "--instance", INSTANCE]);
        fixture
    }

    fn tool(&self, method: &str, input: Value) -> Value {
        let result = self.env.rpc(
            INSTANCE,
            "tool",
            &json!({
                "protocol": "rpc",
                "type": "request",
                "id": uuid::Uuid::new_v4().to_string(),
                "method": method,
                "message": {
                    "input": input,
                    "context": {"workspace": self.env.protocol_workspace()}
                }
            }),
        );
        assert_eq!(result["type"], "reply", "{method}: {result}");
        result["message"].clone()
    }

    fn wait_task(&self, task: &str, cursor: Value) -> Value {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut cursor = cursor;
        let mut stdout = String::new();
        let mut stderr = String::new();
        loop {
            let mut result = self.tool(
                "task_read",
                json!({
                    "task": task, "cursor": cursor, "timeMs": 500,
                }),
            );
            stdout.push_str(result["stdout"].as_str().unwrap());
            stderr.push_str(result["stderr"].as_str().unwrap());
            if result["termination"] != "running" {
                result["stdout"] = json!(stdout);
                result["stderr"] = json!(stderr);
                return result;
            }
            cursor = result["cursor"].clone();
            assert!(Instant::now() < deadline, "task did not exit: {result}");
        }
    }
}

impl Drop for WorkerFixture {
    fn drop(&mut self) {
        let _ = self
            .env
            .std_command()
            .args(["stop", "--instance", INSTANCE])
            .output();
        let _ = self
            .env
            .std_command()
            .args(["retire", "--instance", INSTANCE])
            .output();
    }
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
            .args(["terminal", "attach", task])
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
    let fixture = WorkerFixture::start();
    assert_eq!(fixture.env.json_command(&["terminal", "list"]), json!([]));
    let started = fixture.tool("bash_run", json!({
        "command": "stty -echo; printf 'attach-ready\\n'; IFS= read -r human; printf 'human:%s\\n' \"$human\"; IFS= read -r model; printf 'model:%s\\n' \"$model\"",
        "tty": true, "waitMs": 20,
    }));
    assert_eq!(started["termination"], "running");
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
    attach.input(b"operator\n");
    attach.expect("human:operator");
    attach.detach();
    let inspected = fixture.tool("terminal_inspect", json!({"terminal": task}));
    assert!(
        inspected["text"]
            .as_str()
            .unwrap()
            .contains("human:operator")
    );
    fixture.tool("task_input", json!({"task": task, "input": "agent\n"}));
    let finished = fixture.wait_task(&task, json!({}));
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
    let fixture = WorkerFixture::start();
    let task = fixture.tool("bash_run", json!({
        "command": "IFS= read -r data; printf 'out:%s\\n' \"$data\"; printf 'error\\n' >&2; exit 7",
        "waitMs": 0, "keepStdin": true,
    }));
    assert_eq!(task["termination"], "running");
    let id = task["task"]["id"].as_str().unwrap();
    fixture.tool("task_input", json!({"task": id, "input": "pipe\n"}));
    let result = fixture.wait_task(id, task["cursor"].clone());
    assert_eq!(result["exitCode"], 7);
    assert_eq!(result["stdout"], "out:pipe\n");
    assert_eq!(result["stderr"], "error\n");
    let timeout = fixture.tool(
        "bash_run",
        json!({
            "command": "sleep 30", "waitMs": 0, "timeoutMs": 100,
        }),
    );
    let result = fixture.wait_task(timeout["task"]["id"].as_str().unwrap(), json!({}));
    assert_eq!(result["termination"], "timeout");
    assert_eq!(result["timedOut"], true);
    let large = fixture.tool(
        "bash_run",
        json!({
            "command": "head -c 6291456 /dev/zero | tr '\\000' x",
            "waitMs": 10000, "maxCaptureBytes": 1024,
        }),
    );
    assert_eq!(large["exitCode"], 0, "{large}");
    assert_eq!(large["stdoutBytes"], 6291456);
    assert_eq!(large["stdoutTruncated"], true);
    assert_eq!(large["stdoutArtifact"]["storedBytes"], 6291456);
}
