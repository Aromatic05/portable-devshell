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

fn call(
    env: &TestEnv,
    instance: &str,
    id: &str,
    ctx_id: &str,
    method: &str,
    params: Value,
) -> Value {
    env.rpc(
        instance,
        &json!({
            "type": "request",
            "id": id,
            "method": method,
            "params": params,
            "context": {
                "ctxId": ctx_id,
                "source": "mcp"
            }
        }),
    )
}

#[test]
fn tools_list_exposes_only_the_new_file_edit() {
    let env = TestEnv::new();
    let instance = "aromatic-file-catalog-v2";
    start(&env, instance);

    let response = call(&env, instance, "1", "ctx-a", "tools.list", json!({}));
    let names = response["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect::<Vec<_>>();

    assert!(names.contains(&"file_edit"));
    assert!(!names.contains(&"file_write"));

    let file_edit = response["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == "file_edit")
        .unwrap();
    assert_eq!(file_edit["inputSchema"]["required"], json!(["changes"]));
    assert!(
        file_edit["description"]
            .as_str()
            .unwrap()
            .contains("Move File requires a following *** To: target line")
    );
    assert!(
        file_edit["inputSchema"]["properties"]["changes"]["description"]
            .as_str()
            .unwrap()
            .contains("*** Begin Edit / *** End Edit")
    );

    let file_read = response["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == "file_read")
        .unwrap();
    assert!(
        file_read["description"]
            .as_str()
            .unwrap()
            .contains(":raw for exact lines")
    );
    assert!(
        file_read["inputSchema"]["properties"]["selector"]["description"]
            .as_str()
            .unwrap()
            .contains("one preceding line and up to three following lines")
    );

    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn file_read_auto_returns_content_for_small_files_without_snapshot_tokens() {
    let env = TestEnv::new();
    let instance = "aromatic-file-read-small";
    fs::write(
        env.workspace().join("small.rs"),
        "fn main() {\n    println!(\"hello\");\n}\n",
    )
    .unwrap();
    start(&env, instance);

    let response = call(
        &env,
        instance,
        "1",
        "ctx-a",
        "file_read",
        json!({ "path": "./small.rs" }),
    );

    assert_eq!(response["ok"], true, "{response}");
    assert_eq!(response["result"]["view"], "content");
    assert!(
        response["result"]["content"]
            .as_str()
            .unwrap()
            .starts_with("1:fn main")
    );
    assert!(response["result"].get("snapshotId").is_none());
    assert!(response["result"].get("snapshotTag").is_none());
    assert!(response["result"].get("revision").is_none());

    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn file_read_outline_reports_symbol_ranges_and_hierarchy() {
    let env = TestEnv::new();
    let instance = "aromatic-file-read-outline";
    let mut source = String::from(
        "pub struct Demo;\n\nimpl Demo {\n    pub fn first() {}\n    pub fn second() {}\n}\n",
    );
    for index in 0..400 {
        source.push_str(&format!("fn filler_{index}() {{}}\n"));
    }
    fs::write(env.workspace().join("large.rs"), source).unwrap();
    start(&env, instance);

    let response = call(
        &env,
        instance,
        "1",
        "ctx-a",
        "file_read",
        json!({ "path": "./large.rs" }),
    );

    assert_eq!(response["ok"], true, "{response}");
    assert_eq!(response["result"]["view"], "outline");
    let content = response["result"]["content"].as_str().unwrap();
    assert!(content.contains("1-1 struct Demo"), "{content}");
    assert!(content.contains("3-6 impl Demo"), "{content}");
    assert!(content.contains("  4-4 fn first"), "{content}");
    assert_eq!(response["result"]["parseStatus"], "complete");
    assert!(response["result"].get("nextSelector").is_none());

    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn file_edit_uses_context_scoped_implicit_snapshots() {
    let env = TestEnv::new();
    let instance = "aromatic-file-context-snapshot";
    fs::write(env.workspace().join("document.txt"), "one\ntwo\n").unwrap();
    start(&env, instance);

    let read = call(
        &env,
        instance,
        "1",
        "ctx-a",
        "file_read",
        json!({ "path": "./document.txt", "view": "content" }),
    );
    assert_eq!(read["ok"], true, "{read}");

    let denied = call(
        &env,
        instance,
        "2",
        "ctx-b",
        "file_edit",
        json!({
            "changes": "*** Begin Edit\n*** Patch File: ./document.txt\n@@\n one\n-two\n+changed\n*** End Edit"
        }),
    );
    assert_eq!(denied["ok"], false, "{denied}");
    assert_eq!(denied["error"]["code"], "file.snapshotRequired");

    let edited = call(
        &env,
        instance,
        "3",
        "ctx-a",
        "file_edit",
        json!({
            "changes": "*** Begin Edit\n*** Patch File: ./document.txt\n@@\n one\n-two\n+changed\n*** End Edit"
        }),
    );
    assert_eq!(edited["ok"], true, "{edited}");
    assert_eq!(
        fs::read_to_string(env.workspace().join("document.txt")).unwrap(),
        "one\nchanged\n"
    );

    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn file_search_establishes_edit_coverage() {
    let env = TestEnv::new();
    let instance = "aromatic-file-search-snapshot";
    fs::write(
        env.workspace().join("document.txt"),
        "before\nneedle\nafter\n",
    )
    .unwrap();
    start(&env, instance);

    let searched = call(
        &env,
        instance,
        "1",
        "ctx-a",
        "file_search",
        json!({ "paths": ["./document.txt"], "pattern": "needle", "syntax": "literal" }),
    );
    assert_eq!(searched["ok"], true, "{searched}");
    assert!(searched["result"]["files"][0].get("snapshotId").is_none());

    let edited = call(
        &env,
        instance,
        "2",
        "ctx-a",
        "file_edit",
        json!({
            "changes": "*** Begin Edit\n*** Patch File: ./document.txt\n@@\n before\n-needle\n+changed\n after\n*** End Edit"
        }),
    );
    assert_eq!(edited["ok"], true, "{edited}");

    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn file_search_snapshots_only_files_returned_in_the_current_page() {
    let env = TestEnv::new();
    let instance = "aromatic-file-search-page";
    let paths = (1..=21)
        .map(|index| {
            let name = format!("result-{index:02}.txt");
            fs::write(env.workspace().join(&name), "needle\n").unwrap();
            format!("./{name}")
        })
        .collect::<Vec<_>>();
    start(&env, instance);

    let searched = call(
        &env,
        instance,
        "1",
        "ctx-a",
        "file_search",
        json!({ "paths": paths.clone(), "pattern": "needle", "syntax": "literal" }),
    );
    assert_eq!(searched["ok"], true, "{searched}");
    assert_eq!(searched["result"]["files"].as_array().unwrap().len(), 20);
    assert!(searched["result"]["nextCursor"].is_string());

    let returned_edit = call(
        &env,
        instance,
        "2",
        "ctx-a",
        "file_edit",
        json!({
            "changes": "*** Begin Edit\n*** Rewrite File: ./result-01.txt\nreturned needle\n*** End Edit"
        }),
    );
    assert_eq!(returned_edit["ok"], true, "{returned_edit}");

    let hidden_edit = call(
        &env,
        instance,
        "3",
        "ctx-a",
        "file_edit",
        json!({
            "changes": "*** Begin Edit\n*** Rewrite File: ./result-21.txt\nhidden\n*** End Edit"
        }),
    );
    assert_eq!(hidden_edit["ok"], false, "{hidden_edit}");
    assert_eq!(hidden_edit["error"]["code"], "file.snapshotRequired");
    assert_eq!(
        fs::read_to_string(env.workspace().join("result-21.txt")).unwrap(),
        "needle\n"
    );

    let cursor = searched["result"]["nextCursor"]
        .as_str()
        .unwrap()
        .to_string();
    let second_page = call(
        &env,
        instance,
        "4",
        "ctx-a",
        "file_search",
        json!({
            "paths": paths,
            "pattern": "needle",
            "syntax": "literal",
            "cursor": cursor
        }),
    );
    assert_eq!(second_page["ok"], true, "{second_page}");
    assert_eq!(second_page["result"]["files"].as_array().unwrap().len(), 1);
    assert_eq!(second_page["result"]["files"][0]["path"], "./result-21.txt");

    let second_page_edit = call(
        &env,
        instance,
        "5",
        "ctx-a",
        "file_edit",
        json!({
            "changes": "*** Begin Edit\n*** Rewrite File: ./result-21.txt\nvisible\n*** End Edit"
        }),
    );
    assert_eq!(second_page_edit["ok"], true, "{second_page_edit}");

    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn file_edit_static_preflight_prevents_partial_changes() {
    let env = TestEnv::new();
    let instance = "aromatic-file-preflight-v2";
    fs::write(env.workspace().join("existing.txt"), "old\n").unwrap();
    start(&env, instance);

    let response = call(
        &env,
        instance,
        "1",
        "ctx-a",
        "file_edit",
        json!({
            "changes": "*** Begin Edit\n*** Write File: ./created.txt\ncreated\n*** Rewrite File: ./existing.txt\nupdated\n*** End Edit"
        }),
    );

    assert_eq!(response["ok"], false, "{response}");
    assert_eq!(response["error"]["code"], "file.snapshotRequired");
    assert!(!env.workspace().join("created.txt").exists());
    assert_eq!(
        fs::read_to_string(env.workspace().join("existing.txt")).unwrap(),
        "old\n"
    );

    env.json_command(&["stop", "--instance", instance]);
}

#[cfg(unix)]
#[test]
fn file_edit_keeps_applied_operations_and_stops_after_runtime_failure() {
    let env = TestEnv::new();
    let instance = "aromatic-file-partial-v2";
    start(&env, instance);
    let unavailable = format!("/proc/portable-devshell-test-{}", std::process::id());
    let changes = format!(
        "*** Begin Edit\n*** Write File: ./created.txt\ncreated\n*** Move File: ./created.txt\n*** To: {unavailable}\n*** Write File: ./never.txt\nnever\n*** End Edit"
    );

    let response = call(
        &env,
        instance,
        "1",
        "ctx-a",
        "file_edit",
        json!({ "changes": changes }),
    );

    assert_eq!(response["ok"], true, "{response}");
    assert_eq!(response["result"]["complete"], false);
    assert_eq!(response["result"]["operations"][0]["status"], "applied");
    assert_eq!(response["result"]["operations"][1]["status"], "failed");
    assert_eq!(response["result"]["operations"][2]["status"], "notExecuted");
    assert_eq!(
        fs::read_to_string(env.workspace().join("created.txt")).unwrap(),
        "created\n"
    );
    assert!(!env.workspace().join("never.txt").exists());

    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn file_edit_applies_all_five_operations_in_order() {
    let env = TestEnv::new();
    let instance = "aromatic-file-all-actions";
    fs::write(env.workspace().join("patch.txt"), "one\ntwo\n").unwrap();
    fs::write(env.workspace().join("rewrite.txt"), "old generated\n").unwrap();
    fs::write(env.workspace().join("move.txt"), "move me\n").unwrap();
    fs::write(env.workspace().join("delete.txt"), "delete me\n").unwrap();
    start(&env, instance);

    for (index, path) in ["patch.txt", "rewrite.txt", "move.txt", "delete.txt"]
        .into_iter()
        .enumerate()
    {
        let read = call(
            &env,
            instance,
            &format!("read-{index}"),
            "ctx-a",
            "file_read",
            json!({ "path": format!("./{path}"), "view": "content" }),
        );
        assert_eq!(read["ok"], true, "{read}");
    }

    let edited = call(
        &env,
        instance,
        "edit",
        "ctx-a",
        "file_edit",
        json!({
            "changes": concat!(
                "*** Begin Edit\n",
                "*** Write File: ./new.txt\n",
                "new file\n",
                "*** Patch File: ./patch.txt\n",
                "@@\n",
                " one\n",
                "-two\n",
                "+second\n",
                "*** Rewrite File: ./rewrite.txt\n",
                "new generated\n",
                "*** Move File: ./move.txt\n",
                "*** To: ./moved.txt\n",
                "*** Delete File: ./delete.txt\n",
                "*** End Edit"
            )
        }),
    );

    assert_eq!(edited["ok"], true, "{edited}");
    assert_eq!(edited["result"]["complete"], true);
    assert_eq!(edited["result"]["operations"].as_array().unwrap().len(), 5);
    assert!(
        edited["result"]["operations"]
            .as_array()
            .unwrap()
            .iter()
            .all(|operation| operation["status"] == "applied")
    );
    assert_eq!(
        fs::read_to_string(env.workspace().join("new.txt")).unwrap(),
        "new file\n"
    );
    assert_eq!(
        fs::read_to_string(env.workspace().join("patch.txt")).unwrap(),
        "one\nsecond\n"
    );
    assert_eq!(
        fs::read_to_string(env.workspace().join("rewrite.txt")).unwrap(),
        "new generated\n"
    );
    assert!(!env.workspace().join("move.txt").exists());
    assert_eq!(
        fs::read_to_string(env.workspace().join("moved.txt")).unwrap(),
        "move me\n"
    );
    assert!(!env.workspace().join("delete.txt").exists());

    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn file_edit_rejects_patch_context_outside_read_coverage() {
    let env = TestEnv::new();
    let instance = "aromatic-file-unread-range";
    fs::write(
        env.workspace().join("document.txt"),
        "one\ntwo\nthree\nfour\n",
    )
    .unwrap();
    start(&env, instance);

    let read = call(
        &env,
        instance,
        "1",
        "ctx-a",
        "file_read",
        json!({ "path": "./document.txt", "view": "content", "selector": "1-1:raw" }),
    );
    assert_eq!(read["ok"], true, "{read}");

    let edited = call(
        &env,
        instance,
        "2",
        "ctx-a",
        "file_edit",
        json!({
            "changes": "*** Begin Edit\n*** Patch File: ./document.txt\n@@\n-three\n+third\n*** End Edit"
        }),
    );
    assert_eq!(edited["ok"], true, "{edited}");
    assert_eq!(edited["result"]["complete"], false);
    assert_eq!(
        edited["result"]["operations"][0]["error"]["code"],
        "file.unreadRange"
    );
    assert_eq!(
        fs::read_to_string(env.workspace().join("document.txt")).unwrap(),
        "one\ntwo\nthree\nfour\n"
    );

    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn file_edit_three_way_merges_non_conflicting_external_changes() {
    let env = TestEnv::new();
    let instance = "aromatic-file-three-way-v2";
    fs::write(env.workspace().join("document.txt"), "one\ntwo\nthree\n").unwrap();
    start(&env, instance);

    let read = call(
        &env,
        instance,
        "1",
        "ctx-a",
        "file_read",
        json!({ "path": "./document.txt", "view": "content" }),
    );
    assert_eq!(read["ok"], true, "{read}");
    fs::write(
        env.workspace().join("document.txt"),
        "external\none\ntwo\nthree\n",
    )
    .unwrap();

    let edited = call(
        &env,
        instance,
        "2",
        "ctx-a",
        "file_edit",
        json!({
            "changes": "*** Begin Edit\n*** Patch File: ./document.txt\n@@\n one\n-two\n+second\n three\n*** End Edit"
        }),
    );
    assert_eq!(edited["ok"], true, "{edited}");
    assert_eq!(edited["result"]["complete"], true);
    assert_eq!(edited["result"]["operations"][0]["merged"], true);
    assert_eq!(
        fs::read_to_string(env.workspace().join("document.txt")).unwrap(),
        "external\none\nsecond\nthree\n"
    );

    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn closing_transport_session_does_not_release_context_snapshots() {
    let env = TestEnv::new();
    let instance = "aromatic-context-session-close";
    fs::write(env.workspace().join("document.txt"), "old\n").unwrap();
    start(&env, instance);

    let read = call(
        &env,
        instance,
        "1",
        "ctx-a",
        "file_read",
        json!({ "path": "./document.txt" }),
    );
    assert_eq!(read["ok"], true, "{read}");
    let closed = call(
        &env,
        instance,
        "2",
        "control",
        "tool.session.close",
        json!({ "sessionId": "ctx-a" }),
    );
    assert_eq!(closed["ok"], true, "{closed}");

    let edited = call(
        &env,
        instance,
        "3",
        "ctx-a",
        "file_edit",
        json!({
            "changes": "*** Begin Edit\n*** Rewrite File: ./document.txt\nnew\n*** End Edit"
        }),
    );
    assert_eq!(edited["ok"], true, "{edited}");
    assert_eq!(
        fs::read_to_string(env.workspace().join("document.txt")).unwrap(),
        "new\n"
    );

    env.json_command(&["stop", "--instance", instance]);
}

#[test]
fn file_edit_keeps_a_call_local_snapshot_chain_for_dependent_operations() {
    let env = TestEnv::new();
    let instance = "aromatic-file-local-chain";
    start(&env, instance);

    let edited = call(
        &env,
        instance,
        "1",
        "ctx-a",
        "file_edit",
        json!({
            "changes": concat!(
                "*** Begin Edit\n",
                "*** Write File: ./first.txt\n",
                "one\n",
                "*** Patch File: ./first.txt\n",
                "@@\n",
                "-one\n",
                "+two\n",
                "*** Move File: ./first.txt\n",
                "*** To: ./second.txt\n",
                "*** Patch File: ./second.txt\n",
                "@@\n",
                "-two\n",
                "+three\n",
                "*** End Edit"
            )
        }),
    );

    assert_eq!(edited["ok"], true, "{edited}");
    assert_eq!(edited["result"]["complete"], true, "{edited}");
    assert!(!env.workspace().join("first.txt").exists());
    assert_eq!(
        fs::read_to_string(env.workspace().join("second.txt")).unwrap(),
        "three\n"
    );

    env.json_command(&["stop", "--instance", instance]);
}
