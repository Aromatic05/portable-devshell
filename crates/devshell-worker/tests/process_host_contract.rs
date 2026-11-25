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
    fixture.call(
        "process.v1.resize",
        json!({ "id": pty, "cols": 100, "rows": 40 }),
    );
    fixture.input(&pty, b"world\n");
    let finished = finish(&fixture, &pty);
    assert_eq!(finished["process"]["state"], "exited");
    assert_eq!(finished["process"]["exit"]["exitCode"], 9);
    assert!(output(&finished, "terminal").contains("received:world"));
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
    let listed = fixture
        .env
        .json_command(&["terminal", "list", "--instance", INSTANCE]);
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
    assert_eq!(
        fixture
            .env
            .json_command(&["terminal", "list", "--instance", INSTANCE]),
        json!([])
    );
}
