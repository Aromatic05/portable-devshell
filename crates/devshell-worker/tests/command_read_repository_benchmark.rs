#![cfg(unix)]
mod support;

use serde_json::{Value, json};
use std::fs;
use std::path::Path;
use std::process::Command;
use std::time::Instant;
use support::TestEnv;

fn call(env: &TestEnv, id: usize, command: &str) -> Value {
    env.rpc(
        "readbench-worker",
        "tool",
        &json!({
            "protocol": "rpc", "type": "request", "id": format!("bench-{id}"), "method": "bash_run",
            "message": {
                "input": { "command": command, "timeoutMs": 8000 },
                "context": { "ctxId": "bench", "source": "mcp", "workspace": env.workspace() }
            }
        }),
    )
}

fn median_and_p95(mut times: Vec<u64>) -> (u64, u64) {
    times.sort_unstable();
    (
        times[times.len() / 2],
        times[(times.len() * 95 / 100).min(times.len() - 1)],
    )
}

fn run_pair(
    env: &TestEnv,
    id: &mut usize,
    label: &str,
    tracked: &str,
    baseline: &str,
    repetitions: usize,
) {
    let mut measured = Vec::with_capacity(repetitions);
    let mut control = Vec::with_capacity(repetitions);
    for index in 0..repetitions {
        let first = if index % 2 == 0 { tracked } else { baseline };
        let second = if index % 2 == 0 { baseline } else { tracked };
        let start = Instant::now();
        let response = call(env, *id, first);
        *id += 1;
        let elapsed = start.elapsed().as_micros() as u64;
        assert_eq!(response["type"], "reply", "{response}");
        if first == tracked {
            measured.push(elapsed)
        } else {
            control.push(elapsed)
        };
        let start = Instant::now();
        let response2 = call(env, *id, second);
        *id += 1;
        let elapsed2 = start.elapsed().as_micros() as u64;
        assert_eq!(response2["type"], "reply", "{response2}");
        assert_eq!(
            response["message"]["stdout"], response2["message"]["stdout"],
            "comparator output differs"
        );
        if second == tracked {
            measured.push(elapsed2)
        } else {
            control.push(elapsed2)
        };
    }
    let (med, p95) = median_and_p95(measured);
    let (baseline_med, baseline_p95) = median_and_p95(control);
    eprintln!(
        "BENCH label={label} iterations={} tracked_median_us={med} tracked_p95_us={p95} control_median_us={baseline_med} control_p95_us={baseline_p95} median_delta_us={}",
        repetitions,
        med as i64 - baseline_med as i64
    );
}

#[test]
#[ignore = "opt-in reproducible measurement against a local clone of DevShell"]
fn measure_shell_read_on_independent_devshell_repository() {
    let source = std::env::var("DEVSHELL_READ_BENCH_REPO")
        .expect("path to independent local git repository");
    assert!(Path::new(&source).join(".git").exists());
    let env = TestEnv::new();
    let clone = Command::new("git")
        .args(["clone", "--quiet", "--no-hardlinks", "--", &source])
        .arg(env.workspace())
        .status()
        .expect("clone source fixture");
    assert!(clone.success(), "local clone failed");
    assert!(
        env.workspace()
            .join("crates/devshell-worker/src/tool/file/observation.rs")
            .is_file()
    );
    env.command()
        .current_dir(env.workspace())
        .args(["start", "--instance", "readbench-worker"])
        .assert()
        .success();
    let mut id = 0;
    // Warm up Worker subprocesses and file caches.
    for _ in 0..12 {
        let result = call(&env, id, "cat crates/devshell-worker/Cargo.toml");
        id += 1;
        assert_eq!(result["type"], "reply", "{result}");
    }
    run_pair(
        &env,
        &mut id,
        "whole-small",
        "cat crates/devshell-worker/Cargo.toml",
        "\\cat crates/devshell-worker/Cargo.toml",
        60,
    );
    run_pair(
        &env,
        &mut id,
        "partial-source",
        "cat crates/devshell-worker/src/tool/file/observation.rs | head -n 40",
        "\\cat crates/devshell-worker/src/tool/file/observation.rs | head -n 40",
        60,
    );
    run_pair(
        &env,
        &mut id,
        "recursive-rg",
        "rg -n 'FileToolState' crates/devshell-worker/src | sort | head -n 12",
        "\\rg -n 'FileToolState' crates/devshell-worker/src | sort | head -n 12",
        60,
    );

    fs::write(
        env.workspace().join("repeated.txt"),
        "same\n".repeat(100_000),
    )
    .unwrap();
    run_pair(
        &env,
        &mut id,
        "repeated-lines",
        "cat repeated.txt | head -n 1000",
        "\\cat repeated.txt | head -n 1000",
        3,
    );
    env.json_command(&["stop", "--instance", "readbench-worker"]);
}
