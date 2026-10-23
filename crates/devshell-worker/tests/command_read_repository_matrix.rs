#![cfg(unix)]
mod support;
use serde_json::{Value, json};
use std::fs;
use std::path::Path;
use std::process::Command;
use support::TestEnv;

#[derive(Clone, Copy)]
struct Case {
    label: &'static str,
    shell: &'static str,
    should_credit_target: bool,
}

fn rpc(env: &TestEnv, id: usize, ctx: &str, method: &str, params: Value) -> Value {
    env.rpc(
        "read-matrix-worker",
        "tool",
        &json!({
            "protocol": "rpc", "type": "request", "id": id.to_string(), "method": method,
            "message": {
                "input": params,
                "context": { "ctxId": ctx, "source": "mcp", "workspace": env.workspace() }
            }
        }),
    )
}

#[test]
#[ignore = "independent local Git repository source fixture is required"]
fn classify_real_shell_commands_without_false_coverage() {
    let source = std::env::var("DEVSHELL_READ_BENCH_REPO").expect("local git repository path");
    assert!(Path::new(&source).join(".git").is_dir());
    let env = TestEnv::new();
    assert!(
        Command::new("git")
            .args(["clone", "--quiet", "--no-hardlinks", "--", &source])
            .arg(env.workspace())
            .status()
            .unwrap()
            .success()
    );
    let cases: &[Case] = &[
        Case {
            label: "cat",
            shell: "cat {file}",
            should_credit_target: true,
        },
        Case {
            label: "cat-end-options",
            shell: "cat -- {file}",
            should_credit_target: true,
        },
        Case {
            label: "head-separate",
            shell: "head -n 3 {file}",
            should_credit_target: true,
        },
        Case {
            label: "head-attached",
            shell: "head -n3 {file}",
            should_credit_target: true,
        },
        Case {
            label: "tail-separate",
            shell: "tail -n 2 {file}",
            should_credit_target: true,
        },
        Case {
            label: "tail-attached",
            shell: "tail -n2 {file}",
            should_credit_target: true,
        },
        Case {
            label: "sed-range",
            shell: "sed -n '2,3p' {file}",
            should_credit_target: true,
        },
        Case {
            label: "sed-single",
            shell: "sed -n '3p' {file}",
            should_credit_target: true,
        },
        Case {
            label: "grep-text",
            shell: "grep target {file}",
            should_credit_target: true,
        },
        Case {
            label: "grep-numbered",
            shell: "grep -n target {file}",
            should_credit_target: true,
        },
        Case {
            label: "rg-text",
            shell: "rg target {file}",
            should_credit_target: true,
        },
        Case {
            label: "rg-numbered",
            shell: "rg -n target {file}",
            should_credit_target: true,
        },
        Case {
            label: "rg-head",
            shell: "rg -n target {file} | head -n 1",
            should_credit_target: true,
        },
        Case {
            label: "cat-grep",
            shell: "cat {file} | grep target",
            should_credit_target: true,
        },
        Case {
            label: "cat-grep-exclude",
            shell: "cat {file} | grep -v '^alpha'",
            should_credit_target: true,
        },
        Case {
            label: "cat-rg",
            shell: "cat {file} | rg target",
            should_credit_target: true,
        },
        Case {
            label: "cat-grep-head",
            shell: "cat {file} | grep target | head -n 1",
            should_credit_target: true,
        },
        Case {
            label: "sed-grep",
            shell: "sed -n '1,4p' {file} | grep target",
            should_credit_target: true,
        },
        Case {
            label: "cat-head",
            shell: "cat {file} | head -n 3",
            should_credit_target: true,
        },
        Case {
            label: "cat-tail",
            shell: "cat {file} | tail -n 2",
            should_credit_target: true,
        },
        Case {
            label: "cat-sort",
            shell: "cat {file} | sort",
            should_credit_target: true,
        },
        Case {
            label: "cat-sort-head",
            shell: "cat {file} | sort -r | head -n 4",
            should_credit_target: true,
        },
        Case {
            label: "cat-uniq",
            shell: "cat {file} | uniq",
            should_credit_target: true,
        },
        Case {
            label: "nl-b-all",
            shell: "nl -ba {file}",
            should_credit_target: true,
        },
        Case {
            label: "cat-numbered",
            shell: "cat -n {file}",
            should_credit_target: true,
        },
        Case {
            label: "grep-ignore-case",
            shell: "grep -i TARGET {file}",
            should_credit_target: true,
        },
        Case {
            label: "grep-fixed",
            shell: "grep -F target {file}",
            should_credit_target: true,
        },
        Case {
            label: "grep-pattern-option",
            shell: "grep -e target {file}",
            should_credit_target: true,
        },
        Case {
            label: "grep-inverted",
            shell: "grep -v alpha {file}",
            should_credit_target: true,
        },
        Case {
            label: "rg-word",
            shell: "rg -w target {file}",
            should_credit_target: true,
        },
        Case {
            label: "rg-pattern-option",
            shell: "rg -e target {file}",
            should_credit_target: true,
        },
        Case {
            label: "rg-inverted",
            shell: "rg -v alpha {file}",
            should_credit_target: true,
        },
        Case {
            label: "sort-uniq",
            shell: "cat {file} | sort | uniq",
            should_credit_target: true,
        },
        Case {
            label: "sort-unique",
            shell: "cat {file} | sort -u",
            should_credit_target: true,
        },
        Case {
            label: "head-not-seen",
            shell: "head -n 2 {file}",
            should_credit_target: false,
        },
        Case {
            label: "tail-not-seen",
            shell: "tail -n 1 {file}",
            should_credit_target: false,
        },
        Case {
            label: "sed-not-seen",
            shell: "sed -n '1,2p' {file}",
            should_credit_target: false,
        },
        Case {
            label: "grep-not-seen",
            shell: "grep alpha {file}",
            should_credit_target: false,
        },
        Case {
            label: "printf-not-source",
            shell: "printf 'target\\n'",
            should_credit_target: false,
        },
        Case {
            label: "numbered-filter-not-whitelisted",
            shell: "cat {file} | grep -n target",
            should_credit_target: false,
        },
        Case {
            label: "rg-numbered-filter-not-whitelisted",
            shell: "cat {file} | rg -n target",
            should_credit_target: false,
        },
        Case {
            label: "uniq-count-not-whitelisted",
            shell: "cat {file} | uniq -c",
            should_credit_target: false,
        },
        Case {
            label: "cut-not-whitelisted",
            shell: "cat {file} | cut -c 1-6",
            should_credit_target: false,
        },
        Case {
            label: "wc-not-whitelisted",
            shell: "cat {file} | wc -l",
            should_credit_target: false,
        },
        Case {
            label: "python-not-whitelisted",
            shell: "python3 -c 'print(\"target\")'",
            should_credit_target: false,
        },
        Case {
            label: "compound-command-not-whitelisted",
            shell: "cat {file}; echo done",
            should_credit_target: false,
        },
        Case {
            label: "filename-prefixed-not-whitelisted",
            shell: "grep -H target {file}",
            should_credit_target: false,
        },
        Case {
            label: "tee-not-whitelisted",
            shell: "cat {file} | tee /dev/null",
            should_credit_target: false,
        },
        Case {
            label: "combined-command-not-whitelisted",
            shell: "echo ready && cat {file}",
            should_credit_target: false,
        },
    ];

    fs::create_dir_all(env.workspace().join("cases")).unwrap();
    env.command()
        .current_dir(env.workspace())
        .args(["start", "--instance", "read-matrix-worker"])
        .assert()
        .success();
    let mut true_positive = 0;
    let mut false_negative = 0;
    let mut false_positive = 0;
    let mut true_negative = 0;
    for (index, case) in cases.iter().enumerate() {
        let filename = format!("cases/case_{index:03}.txt");
        fs::write(
            env.workspace().join(&filename),
            "alpha\nbeta\ntarget\ngamma\n",
        )
        .unwrap();
        let command = case.shell.replace("{file}", &filename);
        let ctx = format!("matrix-{index}");
        let shell = rpc(
            &env,
            index * 2 + 1,
            &ctx,
            "bash_run",
            json!({"command": command, "timeoutMs": 5000}),
        );
        assert_eq!(shell["type"], "reply", "case={} {shell}", case.label);
        let edit = rpc(
            &env,
            index * 2 + 2,
            &ctx,
            "file_edit",
            json!({
                "changes": format!("*** Begin Edit\n*** Patch File: ./{filename}\n@@\n-target\n+TARGET_CHANGED\n*** End Edit")
            }),
        );
        let credited = edit["message"]["operations"][0]["status"] == "applied";
        match (case.should_credit_target, credited) {
            (true, true) => true_positive += 1,
            (true, false) => {
                false_negative += 1;
                eprintln!(
                    "MATRIX_FALSE_NEGATIVE label={} stdout={:?} edit={edit}",
                    case.label, shell["message"]["stdout"]
                );
            }
            (false, true) => {
                false_positive += 1;
                eprintln!(
                    "MATRIX_FALSE_POSITIVE label={} stdout={:?}",
                    case.label, shell["message"]["stdout"]
                );
            }
            (false, false) => true_negative += 1,
        }
    }
    eprintln!(
        "MATRIX total={} tp={} fn={} fp={} tn={} precision_percent={:.2} recall_percent={:.2}",
        cases.len(),
        true_positive,
        false_negative,
        false_positive,
        true_negative,
        100.0 * true_positive as f64 / (true_positive + false_positive).max(1) as f64,
        100.0 * true_positive as f64 / (true_positive + false_negative).max(1) as f64
    );
    env.json_command(&["stop", "--instance", "read-matrix-worker"]);
    assert_eq!(false_positive, 0, "must never credit a line not observed");
    assert_eq!(
        false_negative, 0,
        "expected whitelisted source-line observations should map"
    );
}
