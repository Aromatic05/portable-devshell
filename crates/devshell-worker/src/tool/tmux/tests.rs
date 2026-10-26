use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use serde_json::{Value, json};

use super::{TmuxBackend, TmuxStateRegistry, register_tools};
use crate::daemon::process::registry::ActiveProcessRegistry;
use crate::instance::runtime::{PlatformInfo, WorkerRuntimeContext};
use crate::instance::sandbox::path::FilesystemCapability;
use crate::instance::sandbox::policy::{DisabledSecurityPolicy, SecurityError};
use crate::instance::sandbox::{SecurityMode, SecurityPolicy};
use crate::instance::storage::InstancePaths;
use crate::instance::InstanceName;
use crate::tool::file::FileToolState;
use crate::tool::{ToolCall, ToolCancellation, ToolCommandEnvironment, ToolCommandEnvironmentProvider,
    ToolName, ToolProgressEmitter, ToolRegistry};
use crate::transport::endpoint::channel::EndpointPaths;

struct EmptyEnvironment;

impl ToolCommandEnvironmentProvider for EmptyEnvironment {
    fn environment(&self, _: &ToolCall, _: Option<&str>, _: Option<&str>) -> Option<ToolCommandEnvironment> {
        None
    }
}

struct DenyCapability(FilesystemCapability);

impl SecurityPolicy for DenyCapability {
    fn check_capability(&self, capability: FilesystemCapability) -> Result<(), SecurityError> {
        if capability == self.0 {
            return Err(SecurityError::new("security.denied", "fixture capability denied"));
        }
        Ok(())
    }
}

fn paths(root: &Path) -> (InstancePaths, EndpointPaths, WorkerRuntimeContext) {
    let paths = InstancePaths {
        instance_root: root.join("instance"), artifacts_dir: root.join("artifacts"),
        config_file: root.join("config.toml"), logs_dir: root.join("logs"),
        log_file: root.join("worker.log"), state_dir: root.join("state"),
        pid_file: root.join("worker.pid"), lock_file: root.join("worker.lock"),
        daemon_lock_file: root.join("daemon.lock"),
    };
    let endpoints = EndpointPaths {
        instance_runtime_dir: root.join("runtime"), socket_file: root.join("worker.sock"),
        transport_socket_file: root.join("transport.sock"), tmux_socket_file: root.join("tmux.sock"),
    };
    let runtime = WorkerRuntimeContext {
        instance: InstanceName::parse("discovery-fixture").unwrap(),
        platform: PlatformInfo { os: std::env::consts::OS, arch: std::env::consts::ARCH },
        security_mode: SecurityMode::Disabled, worker_sha256: None,
    };
    (paths, endpoints, runtime)
}

fn call(workspace: &Path, params: Value) -> ToolCall {
    ToolCall {
        workspace: workspace.to_path_buf(), params, ctx_id: "fixture-context".into(),
        operation_id: uuid::Uuid::new_v4().to_string(), source: Some("tui".into()),
        policy: Arc::new(DisabledSecurityPolicy), process_registry: Arc::new(ActiveProcessRegistry::new()),
        cancellation: ToolCancellation::default(), progress: ToolProgressEmitter::new(|_| {}),
    }
}

// Spawn only this unit-test executable with a fixture-only PATH. No daemon,
// Worker or real tmux executable can be started by this regression.
#[test]
fn instance_discovery_cold_registry_routes_identical_pane_ids() {
    let root = crate::testing::temp_dir();
    let bin = root.path().join("bin");
    fs::create_dir(&bin).unwrap();
    let executable = bin.join("tmux");
    fs::write(&executable, r##"#!/bin/sh
set -eu
if [ "$1" = '-V' ]; then printf 'tmux fixture\n'; exit 0; fi
[ "$1" = '-S' ]
endpoint=$2
shift 2
name=${endpoint##*/}
name=${name#devshell-}
fixture=$TMUX_DISCOVERY_FIXTURE
printf '%s|%s\n' "$name" "$*" >> "$fixture/commands"
case "$1" in
  has-session) [ -f "$fixture/$name.panes" ] ;;
  show-options)
    case "$*" in
      *@devshell_worker_instance) printf 'discovery-fixture\n' ;;
      *@devshell_worker_schema) printf '4\n' ;;
      *) exit 93 ;;
    esac ;;
  list-panes) /bin/cat "$fixture/$name.panes" ;;
  capture-pane) /bin/cat "$fixture/$name.screen" ;;
  send-keys) printf '%s\n' "$*" >> "$fixture/$name.input" ;;
  set-option|list-windows) : ;;
  *) printf 'Unexpected tmux command: %s\n' "$*" >&2; exit 94 ;;
esac
"##).unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "tool::tmux::tests::instance_discovery_fixture_scenario", "--ignored", "--nocapture"])
        .env("PATH", &bin)
        .env("TMUX_DISCOVERY_FIXTURE", root.path())
        .output().unwrap();
    assert!(output.status.success(), "{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
}

#[test]
#[ignore = "run exclusively through instance_discovery_cold_registry_routes_identical_pane_ids with fake tmux"]
fn instance_discovery_fixture_scenario() {
    let root = PathBuf::from(std::env::var_os("TMUX_DISCOVERY_FIXTURE").expect("isolated fixture root"));
    let (paths, endpoints, runtime) = paths(&root);
    let home = root.join("home");
    let old = root.join("departed-context-workspace");
    let inactive = root.join("inactive-workspace");
    for workspace in [&home, &old, &inactive] {
        fs::create_dir(workspace).unwrap();
        // Persist precisely the identity that production Backend::new writes.
        drop(TmuxBackend::new(&paths, &endpoints, &runtime, workspace).unwrap());
    }
    let workspaces = paths.instance_root.join("tmux/workspaces");
    for entry in fs::read_dir(&workspaces).unwrap() {
        let entry = entry.unwrap();
        let identity: Value = serde_json::from_slice(&fs::read(entry.path().join("workspace.json")).unwrap()).unwrap();
        let workspace = PathBuf::from(identity["workspace"].as_str().unwrap());
        if workspace == inactive {
            continue;
        }
        let name = format!("tmux-{}.sock", entry.file_name().to_str().unwrap());
        fs::write(root.join(format!("{name}.panes")), format!("%0|pane-shared|persistent|incarnation|1|80|24|{}/changed|bash|0||||0\n", workspace.display())).unwrap();
        fs::write(root.join(format!("{name}.screen")), format!("screen for {}\n", workspace.display())).unwrap();
        fs::write(entry.path().join("status/pane-shared.json"), r#"{"state":"idle"}"#).unwrap();
    }
    // Neither Contexts nor tool-call history are inputs to Worker discovery.
    // The original directory may disappear while its session remains alive.
    fs::remove_dir(&old).unwrap();
    let mut registry = ToolRegistry::new();
    register_tools(&mut registry, &paths, &endpoints, &runtime, Arc::new(EmptyEnvironment), FileToolState::new()).unwrap();
    let manage = registry.find(&ToolName::parse("tmux_manage").unwrap()).unwrap();
    let list_call = call(&home, json!({"command":"list", "scope":"instance"}));
    let first = manage.call(list_call.clone()).unwrap();
    let panes = first["panes"].as_array().unwrap();
    assert_eq!(panes.len(), 2);
    let owners: Vec<_> = panes.iter().map(|pane| pane["workspace"].as_str().unwrap()).collect();
    assert_eq!(owners, vec![old.to_str().unwrap(), home.to_str().unwrap()]);
    assert_eq!(panes[0]["id"], "pane-shared");
    assert_eq!(panes[1]["id"], "pane-shared");
    assert_eq!(panes[0]["cwd"], format!("{}/changed", old.display()));
    let inspect = registry.find(&ToolName::parse("tmux_inspect").unwrap()).unwrap();
    let detail = inspect.call(call(&old, json!({"pane":"pane-shared"}))).unwrap();
    assert_eq!(detail["panes"][0]["lines"], json!([format!("screen for {}", old.display())]));
    let input = registry.find(&ToolName::parse("tmux_input").unwrap()).unwrap();
    input.call(call(&old, json!({"pane":"pane-shared", "input":"hello"}))).unwrap();
    let inputs: Vec<_> = fs::read_dir(&root).unwrap().map(Result::unwrap)
        .filter(|entry| entry.file_name().to_str().unwrap().ends_with(".input")).collect();
    assert_eq!(inputs.len(), 1);
    assert_eq!(fs::read_to_string(inputs[0].path()).unwrap(), "send-keys -t %0 -l hello\n");
    let old_key = workspaces.read_dir().unwrap().map(Result::unwrap).find(|entry| {
        let identity: Value = serde_json::from_slice(&fs::read(entry.path().join("workspace.json")).unwrap()).unwrap();
        identity["workspace"] == old.to_str().unwrap()
    }).unwrap().file_name();
    assert_eq!(inputs[0].file_name().to_str().unwrap(), format!("tmux-{}.sock.input", old_key.to_str().unwrap()));
    drop(input);
    drop(inspect);
    drop(manage);
    drop(registry);
    // A new registry has no warm states. Its result comes from durable identities.
    let restarted = TmuxStateRegistry::new(&paths, &endpoints, &runtime, Arc::new(EmptyEnvironment), FileToolState::new());
    assert!(restarted.states.lock().unwrap().is_empty());
    let second = restarted.manage(&list_call, list_call.parse_params().unwrap()).unwrap();
    assert_eq!(serde_json::to_value(second).unwrap(), first);
    // Preserve both original capability gates and cancellation before discovery.
    for denied in [FilesystemCapability::ProcessExecute, FilesystemCapability::WorkspaceRead] {
        let mut denied_call = list_call.clone();
        denied_call.policy = Arc::new(DenyCapability(denied));
        assert_eq!(restarted.manage(&denied_call, denied_call.parse_params().unwrap()).unwrap_err().code, "security.denied");
    }
    let cancelled = list_call.clone();
    cancelled.cancellation.cancel();
    assert_eq!(restarted.manage(&cancelled, cancelled.parse_params().unwrap()).unwrap_err().code, "tool.cancelled");
    let invalid = call(&home, json!({"command":"create", "name":"x", "scope":"instance"}));
    assert_eq!(restarted.manage(&invalid, invalid.parse_params().unwrap()).unwrap_err().code, "tool.invalidArguments");
    let commands = fs::read_to_string(root.join("commands")).unwrap();
    assert!(!commands.contains("new-session"));
    assert!(!commands.contains("kill-session"));
    assert!(!commands.contains("kill-server"));
}

#[test]
fn workspace_discovery_legacy_identity_requires_original_workspace_registration() {
    let root = crate::testing::temp_dir();
    let (paths, endpoints, runtime) = paths(root.path());
    let workspace = root.path().join("original");
    drop(TmuxBackend::new(&paths, &endpoints, &runtime, &workspace).unwrap());
    let storage = fs::read_dir(paths.instance_root.join("tmux/workspaces")).unwrap()
        .next().unwrap().unwrap().path();
    let identity = storage.join("workspace.json");
    fs::remove_file(&identity).unwrap();
    fs::write(storage.join("status/existing.json"), "existing status").unwrap();
    let error = TmuxBackend::discover_workspaces(&paths).unwrap_err();
    assert_eq!(error.code, "tmux.workspaceUnresolved");
    assert!(error.message.contains(storage.to_str().unwrap()));
    // Re-opening the known original workspace backfills identity in place.
    drop(TmuxBackend::new(&paths, &endpoints, &runtime, &workspace).unwrap());
    assert_eq!(TmuxBackend::discover_workspaces(&paths).unwrap(), vec![workspace]);
    assert_eq!(fs::read_to_string(storage.join("status/existing.json")).unwrap(), "existing status");
    assert_eq!(fs::metadata(identity).unwrap().permissions().mode() & 0o777, 0o600);
}

#[test]
fn workspace_discovery_rejects_identity_from_a_different_backend_key() {
    let root = crate::testing::temp_dir();
    let (paths, endpoints, runtime) = paths(root.path());
    let workspace = root.path().join("original");
    drop(TmuxBackend::new(&paths, &endpoints, &runtime, &workspace).unwrap());
    let storage = fs::read_dir(paths.instance_root.join("tmux/workspaces")).unwrap()
        .next().unwrap().unwrap().path();
    let identity = storage.join("workspace.json");
    let wrong = serde_json::to_vec(&json!({"workspace": root.path().join("different")})).unwrap();
    fs::write(&identity, &wrong).unwrap();
    assert_eq!(TmuxBackend::discover_workspaces(&paths).unwrap_err().code, "tmux.storageFailed");
    let result = TmuxBackend::new(&paths, &endpoints, &runtime, &workspace);
    assert_eq!(result.err().expect("conflicting identity must fail").code, "tmux.storageFailed");
    assert_eq!(fs::read(identity).unwrap(), wrong);
}
