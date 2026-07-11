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

fn start_with_mode(env: &TestEnv, instance: &str, mode: &str) {
    env.command_with_env("DEVSHELL_WORKER_INTERNAL_FILE_EDIT_MODE", mode)
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

fn patch(path: &str, snapshot: &Value, commands: &str) -> Value {
    json!({
        "input": format!("[{path}#{}]\n{commands}", snapshot.as_str().unwrap())
    })
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
fn file_tools_omit_absent_optional_output_fields() {
    let env = TestEnv::new();
    let instance = "aromatic-file-optional-output";
    fs::write(env.workspace().join("document.txt"), "needle\n").unwrap();
    start(&env, instance);

    let read = call(
        &env,
        instance,
        "1",
        "file_read",
        json!({ "path": "./document.txt", "selector": "1-1:raw" }),
    );
    assert_eq!(read["ok"], true, "{read}");
    assert!(read["result"].get("nextSelector").is_none());

    let found = call(&env, instance, "2", "file_find", json!({ "paths": ["./"] }));
    assert_eq!(found["ok"], true, "{found}");
    assert!(found["result"].get("nextCursor").is_none());

    let searched = call(
        &env,
        instance,
        "3",
        "file_search",
        json!({ "pattern": "needle", "syntax": "literal" }),
    );
    assert_eq!(searched["ok"], true, "{searched}");
    assert!(searched["result"].get("nextCursor").is_none());

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
        patch(
            "./document.txt",
            &read["result"]["snapshotId"],
            "SWAP 3:
+updated",
        ),
    );
    assert_eq!(edited["ok"], true, "{edited}");
    assert_eq!(edited["result"]["files"][0]["firstChangedLine"], 3);

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

    let found = call(&env, instance, "1", "file_find", json!({ "paths": ["./"] }));
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
            "paths": ["./**/*.txt"]
        }),
    );
    assert_eq!(searched["ok"], true);
    assert_eq!(searched["result"]["files"].as_array().unwrap().len(), 2);
    assert_eq!(searched["result"]["files"][0]["path"], "./match.txt");
    assert!(searched["result"].get("nextCursor").is_none());

    let content = searched["result"]["files"][0]["content"].as_str().unwrap();
    assert!(content.starts_with("[./match.txt#"));
    assert!(content.contains("*1:needle"));

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
        json!({ "paths": ["./dangling-link"] }),
    );
    assert_eq!(info["ok"], true);
    assert_eq!(info["result"]["entries"][0]["type"], "symlink");
    assert!(info["result"]["entries"][0].get("targetType").is_none());

    env.json_command(&["stop", "--instance", instance]);
}

#[cfg(unix)]
#[test]
fn file_write_create_rejects_a_dangling_symlink_as_existing() {
    use std::os::unix::fs::symlink;

    let env = TestEnv::new();
    let instance = "aromatic-file-write-symlink";
    symlink("missing-target", env.workspace().join("dangling-link")).unwrap();
    start(&env, instance);

    let response = call(
        &env,
        instance,
        "1",
        "file_write",
        json!({
            "path": "./dangling-link",
            "content": "replacement",
        }),
    );
    assert_eq!(response["ok"], false, "{response}");
    assert_eq!(response["error"]["code"], "file.alreadyExists");
    assert!(
        env.workspace()
            .join("dangling-link")
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_symlink()
    );

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
        json!({ "path": "./document.txt", "content": "first\n" }),
    );
    assert_eq!(created["ok"], true);
    let rejected = call(
        &env,
        instance,
        "2",
        "file_write",
        json!({ "path": "./document.txt", "content": "second\n" }),
    );
    assert_eq!(rejected["ok"], false);
    assert_eq!(rejected["error"]["code"], "file.alreadyExists");

    let overwritten = call(
        &env,
        instance,
        "3",
        "file_write",
        json!({
            "path": "./document.txt",
            "content": "second\n",
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
        patch(
            "./document.txt",
            &read["result"]["snapshotId"],
            "SWAP 1:
+updated",
        ),
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
        json!({ "path": "./large.txt", "selector": "1-1:raw" }),
    );
    assert_eq!(read["ok"], true);
    let edited = call(
        &env,
        instance,
        "2",
        "file_edit",
        patch(
            "./large.txt",
            &read["result"]["snapshotId"],
            "SWAP 1:
+updated line",
        ),
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
        patch(
            "./document.txt",
            &document["result"]["snapshotId"],
            "INS.POST 1:
+two",
        ),
    );
    assert_eq!(inserted["ok"], true, "{inserted}");
    assert_eq!(
        fs::read(env.workspace().join("document.txt")).unwrap(),
        b"one\ntwo\n"
    );

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
        json!({ "input": format!("[./empty.txt#{}]
INS.HEAD:", empty["result"]["snapshotId"].as_str().unwrap()) }),
    );
    assert_eq!(empty_insert["ok"], false, "{empty_insert}");
    assert_eq!(empty_insert["error"]["code"], "file.emptyOperation");

    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn file_read_selector_returns_copyable_header_and_expands_context() {
    let env = TestEnv::new();
    let instance = "aromatic-read-selector";
    fs::write(
        env.workspace().join("document.txt"),
        "one\ntwo\nthree\nfour\nfive\nsix\n",
    )
    .unwrap();
    start(&env, instance);
    let read = call(
        &env,
        instance,
        "1",
        "file_read",
        json!({ "path": "./document.txt", "selector": "3-3" }),
    );
    assert_eq!(read["ok"], true, "{read}");
    let content = read["result"]["content"].as_str().unwrap();
    assert!(content.starts_with("[./document.txt#"));
    assert!(content.contains("2:two"));
    assert!(content.contains("6:six"));
    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn file_read_uses_tree_sitter_structure_summary_for_source_files() {
    let env = TestEnv::new();
    let instance = "aromatic-read-structure";
    fs::write(env.workspace().join("main.rs"), "use std::fs;\n\nfn first() {\n    println!(\"hidden body\");\n}\n\nstruct Item { value: usize }\n").unwrap();
    start(&env, instance);
    let read = call(
        &env,
        instance,
        "1",
        "file_read",
        json!({ "path": "./main.rs" }),
    );
    assert_eq!(read["ok"], true, "{read}");
    let content = read["result"]["content"].as_str().unwrap();
    assert!(content.contains("1:use std::fs;"));
    assert!(content.contains("3:fn first() {"));
    assert!(content.contains("7:struct Item"));
    assert!(!content.contains("hidden body"));
    assert!(read["result"]["nextSelector"].is_string());
    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn file_info_returns_missing_entries_without_failing_the_batch() {
    let env = TestEnv::new();
    let instance = "aromatic-info-batch";
    fs::write(env.workspace().join("present.txt"), "present\n").unwrap();
    start(&env, instance);
    let info = call(
        &env,
        instance,
        "1",
        "file_info",
        json!({ "paths": ["./present.txt", "./missing.txt"] }),
    );
    assert_eq!(info["ok"], true, "{info}");
    assert_eq!(info["result"]["entries"][0]["exists"], true);
    assert_eq!(info["result"]["entries"][1]["exists"], false);
    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn file_write_expected_revision_requires_an_existing_file() {
    let env = TestEnv::new();
    let instance = "aromatic-write-update-only";
    start(&env, instance);
    let result = call(
        &env,
        instance,
        "1",
        "file_write",
        json!({
            "path": "./missing.txt",
            "content": "content\n",
            "expectedRevision": "deadbeef"
        }),
    );
    assert_eq!(result["ok"], false, "{result}");
    assert_eq!(result["error"]["code"], "file.notFound");
    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn file_edit_validates_all_sections_before_writing_any_file() {
    let env = TestEnv::new();
    let instance = "aromatic-edit-batch-validation";
    fs::write(env.workspace().join("a.txt"), "alpha\n").unwrap();
    fs::write(env.workspace().join("b.txt"), "beta\n").unwrap();
    start(&env, instance);
    let a = call(
        &env,
        instance,
        "1",
        "file_read",
        json!({ "path": "./a.txt", "selector": "raw" }),
    );
    let b = call(
        &env,
        instance,
        "2",
        "file_read",
        json!({ "path": "./b.txt", "selector": "raw" }),
    );
    fs::write(env.workspace().join("b.txt"), "changed externally\n").unwrap();
    let input = format!(
        "[./a.txt#{}]\nSWAP 1:\n+updated alpha\n\n[./b.txt#{}]\nSWAP 1:\n+updated beta",
        a["result"]["snapshotId"].as_str().unwrap(),
        b["result"]["snapshotId"].as_str().unwrap()
    );
    let edited = call(&env, instance, "3", "file_edit", json!({ "input": input }));
    assert_eq!(edited["ok"], false, "{edited}");
    assert_eq!(
        fs::read_to_string(env.workspace().join("a.txt")).unwrap(),
        "alpha\n"
    );
    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn file_edit_applies_multiple_files_and_returns_fresh_headers() {
    let env = TestEnv::new();
    let instance = "aromatic-edit-batch";
    fs::write(env.workspace().join("a.txt"), "alpha\n").unwrap();
    fs::write(env.workspace().join("b.txt"), "beta\n").unwrap();
    start(&env, instance);
    let a = call(
        &env,
        instance,
        "1",
        "file_read",
        json!({ "path": "./a.txt", "selector": "raw" }),
    );
    let b = call(
        &env,
        instance,
        "2",
        "file_read",
        json!({ "path": "./b.txt", "selector": "raw" }),
    );
    let input = format!(
        "[./a.txt#{}]\nSWAP 1:\n+updated alpha\n\n[./b.txt#{}]\nSWAP 1:\n+updated beta",
        a["result"]["snapshotId"].as_str().unwrap(),
        b["result"]["snapshotId"].as_str().unwrap()
    );
    let edited = call(&env, instance, "3", "file_edit", json!({ "input": input }));
    assert_eq!(edited["ok"], true, "{edited}");
    assert_eq!(edited["result"]["files"].as_array().unwrap().len(), 2);
    assert!(
        edited["result"]["files"][0]["header"]
            .as_str()
            .unwrap()
            .starts_with("[./a.txt#")
    );
    assert_eq!(
        fs::read_to_string(env.workspace().join("a.txt")).unwrap(),
        "updated alpha\n"
    );
    assert_eq!(
        fs::read_to_string(env.workspace().join("b.txt")).unwrap(),
        "updated beta\n"
    );
    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn file_edit_block_operations_use_tree_sitter_and_require_full_seen_lines() {
    let env = TestEnv::new();
    let instance = "aromatic-edit-block";
    fs::write(
        env.workspace().join("main.rs"),
        "fn old() {\n    println!(\"old\");\n}\n",
    )
    .unwrap();
    start(&env, instance);
    let summary = call(
        &env,
        instance,
        "1",
        "file_read",
        json!({ "path": "./main.rs" }),
    );
    let rejected = call(
        &env,
        instance,
        "2",
        "file_edit",
        patch(
            "./main.rs",
            &summary["result"]["snapshotId"],
            "SWAP.BLK 1:\n+fn new() {}",
        ),
    );
    assert_eq!(rejected["ok"], false, "{rejected}");
    assert_eq!(rejected["error"]["code"], "file.invalidRange");
    let full = call(
        &env,
        instance,
        "3",
        "file_read",
        json!({ "path": "./main.rs", "selector": "raw" }),
    );
    let edited = call(
        &env,
        instance,
        "4",
        "file_edit",
        patch(
            "./main.rs",
            &full["result"]["snapshotId"],
            "SWAP.BLK 1:\n+fn new() {}",
        ),
    );
    assert_eq!(edited["ok"], true, "{edited}");
    assert_eq!(
        fs::read_to_string(env.workspace().join("main.rs")).unwrap(),
        "fn new() {}\n"
    );
    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn file_edit_recovers_a_full_snapshot_only_when_the_anchor_maps_exactly() {
    let env = TestEnv::new();
    let instance = "aromatic-edit-recovery";
    fs::write(env.workspace().join("document.txt"), "alpha\nbeta\ngamma\n").unwrap();
    start(&env, instance);
    let read = call(
        &env,
        instance,
        "1",
        "file_read",
        json!({ "path": "./document.txt", "selector": "raw" }),
    );
    fs::write(
        env.workspace().join("document.txt"),
        "prefix\nalpha\nbeta\ngamma\n",
    )
    .unwrap();
    let edited = call(
        &env,
        instance,
        "2",
        "file_edit",
        patch(
            "./document.txt",
            &read["result"]["snapshotId"],
            "SWAP 2:\n+updated beta",
        ),
    );
    assert_eq!(edited["ok"], true, "{edited}");
    assert_eq!(
        fs::read_to_string(env.workspace().join("document.txt")).unwrap(),
        "prefix\nalpha\nupdated beta\ngamma\n"
    );
    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn file_edit_replace_mode_is_strict_and_covered() {
    let env = TestEnv::new();
    let instance = "aromatic-replace-mode";
    fs::write(env.workspace().join("document.txt"), "alpha  beta\n").unwrap();
    start_with_mode(&env, instance, "replace");

    let read = call(
        &env,
        instance,
        "1",
        "file_read",
        json!({ "path": "./document.txt", "selector": "raw" }),
    );
    assert_eq!(read["ok"], true, "{read}");

    let rejected = call(
        &env,
        instance,
        "2",
        "file_edit",
        json!({
            "path": "./document.txt",
            "edits": [{ "oldText": "alpha beta", "newText": "changed" }]
        }),
    );
    assert_eq!(rejected["ok"], false, "{rejected}");
    assert_eq!(rejected["error"]["code"], "file.textNotFound");

    let edited = call(
        &env,
        instance,
        "3",
        "file_edit",
        json!({
            "path": "./document.txt",
            "edits": [{ "oldText": "alpha  beta", "newText": "changed" }]
        }),
    );
    assert_eq!(edited["ok"], true, "{edited}");
    assert_eq!(
        fs::read_to_string(env.workspace().join("document.txt")).unwrap(),
        "changed\n"
    );
    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn file_edit_patch_mode_applies_standard_unified_diff() {
    let env = TestEnv::new();
    let instance = "aromatic-patch-mode";
    fs::write(env.workspace().join("document.txt"), "before\n").unwrap();
    start_with_mode(&env, instance, "patch");
    let read = call(
        &env,
        instance,
        "1",
        "file_read",
        json!({ "path": "./document.txt", "selector": "raw" }),
    );
    assert_eq!(read["ok"], true, "{read}");

    let edited = call(
        &env,
        instance,
        "2",
        "file_edit",
        json!({
            "path": "./document.txt",
            "edits": [{
                "op": "update",
                "diff": "--- a/document.txt\n+++ b/document.txt\n@@ -1 +1 @@\n-before\n+after\n"
            }]
        }),
    );
    assert_eq!(edited["ok"], true, "{edited}");
    assert_eq!(
        fs::read_to_string(env.workspace().join("document.txt")).unwrap(),
        "after\n"
    );
    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn file_edit_apply_patch_mode_handles_create_move_and_delete() {
    let env = TestEnv::new();
    let instance = "aromatic-apply-patch-mode";
    fs::write(env.workspace().join("old.txt"), "old\n").unwrap();
    fs::write(env.workspace().join("delete.txt"), "delete\n").unwrap();
    start_with_mode(&env, instance, "apply_patch");
    let old = call(
        &env,
        instance,
        "1",
        "file_read",
        json!({ "path": "./old.txt", "selector": "raw" }),
    );
    let deleted = call(
        &env,
        instance,
        "2",
        "file_read",
        json!({ "path": "./delete.txt", "selector": "raw" }),
    );
    assert_eq!(old["ok"], true, "{old}");
    assert_eq!(deleted["ok"], true, "{deleted}");

    let input = concat!(
        "diff --git a/new.txt b/new.txt\n",
        "new file mode 100644\n",
        "--- /dev/null\n",
        "+++ b/new.txt\n",
        "@@ -0,0 +1 @@\n",
        "+new\n",
        "diff --git a/old.txt b/moved.txt\n",
        "similarity index 50%\n",
        "rename from old.txt\n",
        "rename to moved.txt\n",
        "--- a/old.txt\n",
        "+++ b/moved.txt\n",
        "@@ -1 +1 @@\n",
        "-old\n",
        "+moved\n",
        "diff --git a/delete.txt b/delete.txt\n",
        "deleted file mode 100644\n",
        "--- a/delete.txt\n",
        "+++ /dev/null\n",
        "@@ -1 +0,0 @@\n",
        "-delete\n"
    );
    let edited = call(&env, instance, "3", "file_edit", json!({ "input": input }));
    assert_eq!(edited["ok"], true, "{edited}");
    assert_eq!(
        fs::read_to_string(env.workspace().join("new.txt")).unwrap(),
        "new\n"
    );
    assert_eq!(
        fs::read_to_string(env.workspace().join("moved.txt")).unwrap(),
        "moved\n"
    );
    assert!(!env.workspace().join("old.txt").exists());
    assert!(!env.workspace().join("delete.txt").exists());
    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn file_edit_partial_commit_returns_rpc_error_with_batch_details() {
    let env = TestEnv::new();
    let instance = "aromatic-partial-commit";
    fs::write(env.workspace().join("a.txt"), "alpha\n").unwrap();
    fs::write(env.workspace().join("b.txt"), "beta\n").unwrap();
    start(&env, instance);
    let a = call(
        &env,
        instance,
        "1",
        "file_read",
        json!({ "path": "./a.txt", "selector": "raw" }),
    );
    let b = call(
        &env,
        instance,
        "2",
        "file_read",
        json!({ "path": "./b.txt", "selector": "raw" }),
    );
    let input = format!(
        "[./a.txt#{}]\nSWAP 1:\n+updated\n\n[./b.txt#{}]\nMV /proc/portable-devshell-forbidden",
        a["result"]["snapshotId"].as_str().unwrap(),
        b["result"]["snapshotId"].as_str().unwrap()
    );
    let edited = call(&env, instance, "3", "file_edit", json!({ "input": input }));
    assert_eq!(edited["ok"], false, "{edited}");
    assert_eq!(edited["error"]["code"], "file.writeFailed");
    assert_eq!(
        edited["error"]["details"]["appliedFiles"],
        json!(["./a.txt"])
    );
    assert_eq!(edited["error"]["details"]["failedFile"], "./b.txt");
    assert_eq!(edited["error"]["details"]["skippedFiles"], json!([]));
    assert_eq!(
        fs::read_to_string(env.workspace().join("a.txt")).unwrap(),
        "updated\n"
    );
    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn file_edit_empty_file_ins_head_honors_eof_sentinel() {
    let env = TestEnv::new();
    let instance = "aromatic-empty-head";
    fs::write(env.workspace().join("empty.txt"), "").unwrap();
    start(&env, instance);
    let read = call(
        &env,
        instance,
        "1",
        "file_read",
        json!({ "path": "./empty.txt", "selector": "raw" }),
    );
    let edited = call(
        &env,
        instance,
        "2",
        "file_edit",
        patch(
            "./empty.txt",
            &read["result"]["snapshotId"],
            "INS.HEAD:\n+first\n+",
        ),
    );
    assert_eq!(edited["ok"], true, "{edited}");
    assert_eq!(
        fs::read(env.workspace().join("empty.txt")).unwrap(),
        b"first\n"
    );
    assert_eq!(edited["result"]["files"][0]["totalLines"], 1);
    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn non_hashline_edit_modes_reject_files_over_four_mib() {
    for (index, mode) in ["replace", "patch", "apply_patch"].into_iter().enumerate() {
        let env = TestEnv::new();
        let instance = format!("aromatic-large-{}", mode.replace('_', ""));
        fs::write(
            env.workspace().join("large.txt"),
            "x\n".repeat(2 * 1024 * 1024 + 1),
        )
        .unwrap();
        start_with_mode(&env, &instance, mode);
        let read = call(
            &env,
            &instance,
            "1",
            "file_read",
            json!({ "path": "./large.txt", "selector": "1-1:raw" }),
        );
        assert_eq!(read["ok"], true, "{read}");
        let params = match mode {
            "replace" => {
                json!({ "path": "./large.txt", "edits": [{ "oldText": "x", "newText": "y" }] })
            }
            "patch" => {
                json!({ "path": "./large.txt", "edits": [{ "op": "update", "diff": "--- a/large.txt\n+++ b/large.txt\n@@ -1 +1 @@\n-x\n+y\n" }] })
            }
            "apply_patch" => {
                json!({ "input": "--- large.txt\n+++ large.txt\n@@ -1 +1 @@\n-x\n+y\n" })
            }
            _ => unreachable!(),
        };
        let edited = call(
            &env,
            &instance,
            &(index + 2).to_string(),
            "file_edit",
            params,
        );
        assert_eq!(edited["ok"], false, "{mode}: {edited}");
        assert_eq!(edited["error"]["code"], "file.tooLarge");
        env.json_command(&["stop", "--instance", &instance]);
    }
}

#[test]
fn file_search_keeps_serialized_result_within_one_mib_budget() {
    let env = TestEnv::new();
    let instance = "aromatic-search-budget";
    let line = format!("needle {}\n", "\\\"".repeat(2000));
    for index in 0..40 {
        fs::write(
            env.workspace().join(format!("file-{index:02}.txt")),
            line.repeat(20),
        )
        .unwrap();
    }
    start(&env, instance);
    let searched = call(
        &env,
        instance,
        "1",
        "file_search",
        json!({ "pattern": "needle", "syntax": "literal" }),
    );
    assert_eq!(searched["ok"], true, "{searched}");
    assert!(serde_json::to_vec(&searched["result"]).unwrap().len() <= 1024 * 1024);
    assert!(searched["result"]["nextCursor"].is_string());
    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn file_read_raw_description_mentions_output_pagination_budget() {
    let env = TestEnv::new();
    let instance = "aromatic-read-description";
    start(&env, instance);
    let listed = call(&env, instance, "1", "tools.list", json!({}));
    assert_eq!(listed["ok"], true, "{listed}");
    let description = listed["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == "file_read")
        .unwrap()["description"]
        .as_str()
        .unwrap();
    assert!(description.contains("output byte limit"), "{description}");
    assert!(description.contains("nextSelector"), "{description}");
    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn file_edit_hashline_remove_and_move_are_covered() {
    let env = TestEnv::new();
    let instance = "aromatic-rem-mv";
    fs::write(env.workspace().join("move.txt"), "move\n").unwrap();
    fs::write(env.workspace().join("remove.txt"), "remove\n").unwrap();
    start(&env, instance);
    let moved = call(
        &env,
        instance,
        "1",
        "file_read",
        json!({ "path": "./move.txt", "selector": "raw" }),
    );
    let removed = call(
        &env,
        instance,
        "2",
        "file_read",
        json!({ "path": "./remove.txt", "selector": "raw" }),
    );
    let input = format!(
        "[./move.txt#{}]\nSWAP 1:\n+moved\nMV ./moved.txt\n\n[./remove.txt#{}]\nREM",
        moved["result"]["snapshotId"].as_str().unwrap(),
        removed["result"]["snapshotId"].as_str().unwrap()
    );
    let edited = call(&env, instance, "3", "file_edit", json!({ "input": input }));
    assert_eq!(edited["ok"], true, "{edited}");
    assert_eq!(
        fs::read_to_string(env.workspace().join("moved.txt")).unwrap(),
        "moved\n"
    );
    assert!(!env.workspace().join("move.txt").exists());
    assert!(!env.workspace().join("remove.txt").exists());
    assert_eq!(edited["result"]["files"][0]["operation"], "move");
    assert_eq!(edited["result"]["files"][1]["operation"], "delete");
    env.json_command(&["stop", "--instance", instance]);
}

#[cfg(unix)]
#[test]
fn file_edit_rejects_duplicate_canonical_source_paths() {
    use std::os::unix::fs::symlink;

    let env = TestEnv::new();
    let instance = "aromatic-canonical-duplicate";
    fs::write(env.workspace().join("real.txt"), "real\n").unwrap();
    symlink("real.txt", env.workspace().join("alias.txt")).unwrap();
    start(&env, instance);
    let real = call(
        &env,
        instance,
        "1",
        "file_read",
        json!({ "path": "./real.txt", "selector": "raw" }),
    );
    let alias = call(
        &env,
        instance,
        "2",
        "file_read",
        json!({ "path": "./alias.txt", "selector": "raw" }),
    );
    let input = format!(
        "[./real.txt#{}]\nSWAP 1:\n+first\n\n[./alias.txt#{}]\nSWAP 1:\n+second",
        real["result"]["snapshotId"].as_str().unwrap(),
        alias["result"]["snapshotId"].as_str().unwrap()
    );
    let edited = call(&env, instance, "3", "file_edit", json!({ "input": input }));
    assert_eq!(edited["ok"], false, "{edited}");
    assert_eq!(edited["error"]["code"], "file.operationConflict");
    assert_eq!(
        fs::read_to_string(env.workspace().join("real.txt")).unwrap(),
        "real\n"
    );
    env.json_command(&["stop", "--instance", instance]);
}
