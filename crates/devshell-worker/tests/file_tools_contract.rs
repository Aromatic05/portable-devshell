mod support;

use std::fs;

use serde_json::{Value, json};
use support::TestEnv;

fn start(env: &TestEnv, instance: &str) {
    env.command()
        .current_dir(env.workspace())
        .args(["start", "--instance", instance])
        .assert()
        .success();
}

fn call(env: &TestEnv, instance: &str, id: &str, method: &str, params: Value) -> Value {
    env.rpc(
        instance,
        &json!({
            "type": "request",
            "id": id,
            "method": method,
            "params": params,
        }),
    )
}

#[test]
fn file_tools_reject_intermediate_dot_segments() {
    let env = TestEnv::new();
    let instance = "aromatic-file-path";
    fs::write(env.workspace().join("document.txt"), "document\n").unwrap();
    start(&env, instance);

    let response = call(
        &env,
        instance,
        "1",
        "file_read",
        json!({ "path": "././document.txt" }),
    );
    assert_eq!(response["ok"], false);
    assert_eq!(response["error"]["code"], "file.invalidPath");

    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn file_edit_reports_the_actual_first_changed_line() {
    let env = TestEnv::new();
    let instance = "aromatic-file-edit";
    fs::write(env.workspace().join("document.txt"), "one\ntwo\nthree\n").unwrap();
    start(&env, instance);

    let read = call(
        &env,
        instance,
        "1",
        "file_read",
        json!({ "path": "./document.txt" }),
    );
    let edited = call(
        &env,
        instance,
        "2",
        "file_edit",
        json!({
            "path": "./document.txt",
            "snapshotId": read["result"]["snapshotId"],
            "operations": [{
                "op": "replace",
                "startLine": 3,
                "endLine": 3,
                "lines": ["updated"],
            }],
        }),
    );
    assert_eq!(edited["ok"], true, "{edited}");
    assert_eq!(edited["result"]["firstChangedLine"], 3);

    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn file_find_respects_gitignore_by_default() {
    let env = TestEnv::new();
    let instance = "aromatic-file-find";
    fs::write(env.workspace().join(".gitignore"), "ignored.txt\n").unwrap();
    fs::write(env.workspace().join("ignored.txt"), "ignored\n").unwrap();
    fs::write(env.workspace().join("visible.txt"), "visible\n").unwrap();
    start(&env, instance);

    let found = call(&env, instance, "1", "file_find", json!({}));
    assert_eq!(found["ok"], true);
    let paths = found["result"]["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["path"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert!(paths.contains(&"./visible.txt"));
    assert!(!paths.contains(&"./ignored.txt"));

    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn file_search_honors_include_and_returns_a_query_bound_cursor() {
    let env = TestEnv::new();
    let instance = "aromatic-file-search";
    fs::write(env.workspace().join("match.txt"), "needle\n").unwrap();
    fs::write(env.workspace().join("more.txt"), "needle\n").unwrap();
    fs::write(env.workspace().join("match.log"), "needle\n").unwrap();
    start(&env, instance);

    let searched = call(
        &env,
        instance,
        "1",
        "file_search",
        json!({
            "pattern": "needle",
            "syntax": "literal",
            "include": ["**/*.txt"],
            "maxFiles": 1,
        }),
    );
    assert_eq!(searched["ok"], true);
    assert_eq!(searched["result"]["files"].as_array().unwrap().len(), 1);
    assert_eq!(searched["result"]["files"][0]["path"], "./match.txt");
    assert!(searched["result"]["nextCursor"].is_string());

    let cursor = searched["result"]["nextCursor"].as_str().unwrap();
    let mismatched = call(
        &env,
        instance,
        "2",
        "file_search",
        json!({
            "pattern": "other",
            "syntax": "literal",
            "cursor": cursor,
        }),
    );
    assert_eq!(mismatched["ok"], false);
    assert_eq!(mismatched["error"]["code"], "file.invalidCursor");

    env.json_command(&["stop", "--instance", instance]);
}

#[cfg(unix)]
#[test]
fn file_info_reports_a_dangling_symlink() {
    use std::os::unix::fs::symlink;

    let env = TestEnv::new();
    let instance = "aromatic-file-info";
    symlink("missing-target", env.workspace().join("dangling-link")).unwrap();
    start(&env, instance);

    let info = call(
        &env,
        instance,
        "1",
        "file_info",
        json!({ "path": "./dangling-link" }),
    );
    assert_eq!(info["ok"], true);
    assert_eq!(info["result"]["type"], "symlink");
    assert!(info["result"].get("targetType").is_none());

    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn bash_run_rejects_values_over_worker_hard_limits() {
    let env = TestEnv::new();
    let instance = "aromatic-bash-limits";
    start(&env, instance);

    let response = call(
        &env,
        instance,
        "1",
        "bash_run",
        json!({
            "command": "true",
            "timeoutMs": 300_001,
        }),
    );
    assert_eq!(response["ok"], false);
    assert_eq!(response["error"]["code"], "tool.invalidArguments");

    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn file_write_requires_a_matching_revision_to_overwrite() {
    let env = TestEnv::new();
    let instance = "aromatic-file-write";
    start(&env, instance);

    let created = call(
        &env,
        instance,
        "1",
        "file_write",
        json!({ "path": "./document.txt", "content": "first\n", "mode": "create" }),
    );
    assert_eq!(created["ok"], true);
    let rejected = call(
        &env,
        instance,
        "2",
        "file_write",
        json!({ "path": "./document.txt", "content": "second\n", "mode": "overwrite" }),
    );
    assert_eq!(rejected["ok"], false);
    assert_eq!(rejected["error"]["code"], "file.invalidArguments");

    let overwritten = call(
        &env,
        instance,
        "3",
        "file_write",
        json!({
            "path": "./document.txt",
            "content": "second\n",
            "mode": "overwrite",
            "expectedRevision": created["result"]["revision"],
        }),
    );
    assert_eq!(overwritten["ok"], true);

    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn file_edit_uses_the_first_actual_line_ending_when_writing_back() {
    let env = TestEnv::new();
    let instance = "aromatic-file-ending";
    fs::write(env.workspace().join("document.txt"), b"first\nsecond\r\n").unwrap();
    start(&env, instance);

    let read = call(
        &env,
        instance,
        "1",
        "file_read",
        json!({ "path": "./document.txt" }),
    );
    let edited = call(
        &env,
        instance,
        "2",
        "file_edit",
        json!({
            "path": "./document.txt",
            "snapshotId": read["result"]["snapshotId"],
            "operations": [{
                "op": "replace",
                "startLine": 1,
                "endLine": 1,
                "lines": ["updated"],
            }],
        }),
    );
    assert_eq!(edited["ok"], true);
    assert_eq!(
        fs::read(env.workspace().join("document.txt")).unwrap(),
        b"updated\nsecond\n"
    );

    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn file_edit_updates_a_sparse_snapshot_without_losing_the_file_shape() {
    let env = TestEnv::new();
    let instance = "aromatic-sparse-edit";
    let mut content = String::with_capacity(16 * 1024 * 1024 + 1024);
    content.push_str("first line\n");
    while content.len() <= 16 * 1024 * 1024 {
        content.push_str("unchanged sparse snapshot line\n");
    }
    fs::write(env.workspace().join("large.txt"), content).unwrap();
    start(&env, instance);

    let read = call(
        &env,
        instance,
        "1",
        "file_read",
        json!({ "path": "./large.txt", "ranges": [{ "startLine": 1, "lineCount": 1 }] }),
    );
    assert_eq!(read["ok"], true);
    let edited = call(
        &env,
        instance,
        "2",
        "file_edit",
        json!({
            "path": "./large.txt",
            "snapshotId": read["result"]["snapshotId"],
            "operations": [{
                "op": "replace",
                "startLine": 1,
                "endLine": 1,
                "lines": ["updated line"],
            }],
        }),
    );
    assert_eq!(edited["ok"], true, "{edited}");
    assert_eq!(
        fs::read_to_string(env.workspace().join("large.txt"))
            .unwrap()
            .lines()
            .next(),
        Some("updated line")
    );

    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn file_edit_applies_eof_sentinel_to_all_eof_operations() {
    let env = TestEnv::new();
    let instance = "aromatic-file-eof";
    fs::write(env.workspace().join("document.txt"), "one\n").unwrap();
    fs::write(env.workspace().join("empty.txt"), "").unwrap();
    start(&env, instance);

    let document = call(
        &env,
        instance,
        "1",
        "file_read",
        json!({ "path": "./document.txt" }),
    );
    let inserted = call(
        &env,
        instance,
        "2",
        "file_edit",
        json!({
            "path": "./document.txt",
            "snapshotId": document["result"]["snapshotId"],
            "operations": [{
                "op": "insert",
                "at": "after",
                "line": 1,
                "lines": ["two", ""],
            }],
        }),
    );
    assert_eq!(inserted["ok"], true, "{inserted}");
    assert_eq!(fs::read(env.workspace().join("document.txt")).unwrap(), b"one\ntwo\n");

    let empty = call(
        &env,
        instance,
        "3",
        "file_read",
        json!({ "path": "./empty.txt" }),
    );
    let empty_insert = call(
        &env,
        instance,
        "4",
        "file_edit",
        json!({
            "path": "./empty.txt",
            "snapshotId": empty["result"]["snapshotId"],
            "operations": [{
                "op": "insert",
                "at": "head",
                "lines": [""],
            }],
        }),
    );
    assert_eq!(empty_insert["ok"], false, "{empty_insert}");
    assert_eq!(empty_insert["error"]["code"], "file.emptyOperation");

    env.json_command(&["stop", "--instance", instance]);
}
