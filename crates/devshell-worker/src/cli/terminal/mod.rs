use std::collections::BTreeSet;
use std::io::{self, IsTerminal};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use clap::{Args, Subcommand};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::capability::process::client::ProcessHostClient;
use crate::capability::rpc::bridge::send_request_with_timeout;
use crate::capability::rpc::request::{RpcRequest, RpcRequestContext};
use crate::daemon::process::daemon_is_responsive;
use crate::host::home::devshell_home;
use crate::instance::InstanceName;
use crate::instance::storage::InstancePaths;
use crate::transport::endpoint::channel::EndpointPaths;

mod attach;

const DEFAULT_COLS: u16 = 120;
const DEFAULT_ROWS: u16 = 36;
const RPC_TIMEOUT: Duration = Duration::from_secs(10);
const CLOSE_WAIT_TIMEOUT: Duration = Duration::from_secs(1);
const STATELESS_CONTEXT_ID: &str = "57a7e1e5-5000-8000-8000-000000000000";

#[derive(Args, Debug)]
pub struct TerminalArgs {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// List process tasks and persistent terminals on this machine.
    List {
        /// Filter to a single instance name.
        #[arg(long)]
        instance: Option<String>,
        /// Include completed (non-running, non-persistent) tasks in table output.
        #[arg(long)]
        all: bool,
        /// Force JSON output.
        #[arg(long, conflicts_with = "table")]
        json: bool,
        /// Force human-readable table output even when stdout is not a TTY.
        #[arg(long, conflicts_with = "json")]
        table: bool,
    },
    /// Create a persistent interactive terminal and attach with exclusive control.
    /// Detach (Ctrl-]) or release control (Ctrl-] t) to hand it off to models.
    Create {
        /// Target instance name (auto-selected when only one running instance exists).
        #[arg(long)]
        instance: Option<String>,
        /// Workspace path to bind so models in that workspace see this terminal (defaults to cwd).
        #[arg(long, conflicts_with = "stateless")]
        workspace: Option<PathBuf>,
        /// Bind to the instance's stateless scope instead of a workspace.
        #[arg(long, conflicts_with = "workspace")]
        stateless: bool,
        /// Optional human-readable name (1-64 ASCII alphanumeric or ._-).
        #[arg(long)]
        name: Option<String>,
        /// Initial working directory (defaults to workspace or current directory).
        #[arg(long)]
        cwd: Option<PathBuf>,
        /// Optional shell executable (defaults to user login shell).
        #[arg(long)]
        shell: Option<String>,
        /// Initial terminal columns (defaults to local terminal width or 120).
        #[arg(long)]
        cols: Option<u16>,
        /// Initial terminal rows (defaults to local terminal height or 36).
        #[arg(long)]
        rows: Option<u16>,
        /// Create without attaching interactively.
        #[arg(short, long)]
        detach: bool,
        /// Force JSON output when used with --detach.
        #[arg(long)]
        json: bool,
    },
    /// Attach to a task or terminal by ID, short ID prefix, or name.
    /// Omit TARGET when only one running PTY exists. Ctrl-] detaches; Ctrl-] t toggles takeover.
    Attach {
        /// Process ID, unique ID prefix, or terminal name.
        target: Option<String>,
        /// Filter target lookup to a single instance.
        #[arg(long)]
        instance: Option<String>,
        /// Request exclusive input control on attach (can also be toggled live with Ctrl-] t).
        #[arg(long)]
        takeover: bool,
    },
    /// Inspect the current visible PTY screen without entering attach mode.
    Inspect {
        /// Process ID, unique ID prefix, or terminal name.
        target: String,
        /// Filter target lookup to a single instance.
        #[arg(long)]
        instance: Option<String>,
        /// Force JSON output.
        #[arg(long)]
        json: bool,
    },
    /// Request termination of a task or persistent terminal.
    Close {
        /// Process ID, unique ID prefix, or terminal name.
        target: String,
        /// Filter target lookup to a single instance.
        #[arg(long)]
        instance: Option<String>,
        /// Force JSON output.
        #[arg(long)]
        json: bool,
    },
}

struct DiscoveredResource {
    client: ProcessHostClient,
    descriptor: Value,
}

pub fn run(args: TerminalArgs) -> Result<String, String> {
    match args.command {
        Command::List {
            instance,
            all,
            json,
            table,
        } => run_list(instance.as_deref(), all, json, table),
        Command::Create {
            instance,
            workspace,
            stateless,
            name,
            cwd,
            shell,
            cols,
            rows,
            detach,
            json,
        } => run_create(CreateOptions {
            instance,
            workspace,
            stateless,
            name,
            cwd,
            shell,
            cols,
            rows,
            detach,
            json,
        }),
        Command::Attach {
            target,
            instance,
            takeover,
        } => run_attach(target.as_deref(), instance.as_deref(), takeover),
        Command::Inspect {
            target,
            instance,
            json,
        } => run_inspect(&target, instance.as_deref(), json),
        Command::Close {
            target,
            instance,
            json,
        } => run_close(&target, instance.as_deref(), json),
    }
}

fn run_list(
    instance_filter: Option<&str>,
    all: bool,
    force_json: bool,
    force_table: bool,
) -> Result<String, String> {
    let clients = discover_filtered(instance_filter)?;
    let mut resources = Vec::new();
    for client in clients {
        for mut resource in list(&client)? {
            resource["instance"] = Value::String(client.instance().into());
            resources.push(resource);
        }
    }
    let use_table = force_table || (!force_json && io::stdout().is_terminal());
    if !use_table {
        return serde_json::to_string_pretty(&resources).map_err(|error| error.to_string());
    }
    Ok(format_table(&resources, all))
}

struct CreateOptions {
    instance: Option<String>,
    workspace: Option<PathBuf>,
    stateless: bool,
    name: Option<String>,
    cwd: Option<PathBuf>,
    shell: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    detach: bool,
    json: bool,
}

fn run_create(options: CreateOptions) -> Result<String, String> {
    if let Some(name) = options.name.as_deref() {
        validate_name(name)?;
    }
    if let Some(cols) = options.cols
        && (cols == 0 || cols > 1000)
    {
        return Err("cols must be between 1 and 1000".into());
    }
    if let Some(rows) = options.rows
        && (rows == 0 || rows > 1000)
    {
        return Err("rows must be between 1 and 1000".into());
    }
    if !options.detach && (!io::stdin().is_terminal() || !io::stdout().is_terminal()) {
        return Err(
            "interactive terminal attach requires a TTY; pass --detach to create without attaching"
                .into(),
        );
    }

    let instance = resolve_target_instance(options.instance.as_deref())?;
    let current_dir = std::env::current_dir()
        .map_err(|error| format!("failed to read current directory: {error}"))?;
    let (workspace, cwd) = resolve_create_paths(
        &current_dir,
        options.workspace.as_deref(),
        options.cwd.as_deref(),
        options.stateless,
    )?;

    let (default_cols, default_rows) = if !options.detach && io::stdout().is_terminal() {
        crossterm::terminal::size().unwrap_or((DEFAULT_COLS, DEFAULT_ROWS))
    } else {
        (DEFAULT_COLS, DEFAULT_ROWS)
    };
    let cols = options.cols.unwrap_or(default_cols).clamp(1, 1000);
    let rows = options.rows.unwrap_or(default_rows).clamp(1, 1000);

    let (client, descriptor) = spawn_persistent_terminal(
        &instance,
        workspace.as_deref(),
        &cwd,
        options.name.as_deref(),
        options.shell.as_deref(),
        cols,
        rows,
    )?;

    let id = descriptor["id"]
        .as_str()
        .ok_or_else(|| "created terminal descriptor missing id".to_string())?
        .to_string();
    let label = display_label(&descriptor);

    if options.detach {
        let mut summary = descriptor.clone();
        summary["instance"] = Value::String(instance.as_str().into());
        if options.json || !io::stdout().is_terminal() {
            return serde_json::to_string_pretty(&summary).map_err(|error| error.to_string());
        }
        let scope = workspace
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "(stateless)".to_string());
        return Ok(format!(
            "Created persistent terminal {label}\n  instance:  {instance}\n  id:        {id}\n  workspace: {scope}\n  attach:    devshell-worker terminal attach {} --takeover",
            options.name.as_deref().unwrap_or(&short_id(&id))
        ));
    }

    let scope = workspace
        .as_ref()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| "(stateless)".to_string());
    eprintln!(
        "[created {label} on {instance} · workspace: {scope} · Ctrl+] t: hand off to model · Ctrl+] d: detach]"
    );
    attach::run(client, &id, &label, true, true)?;
    Ok(String::new())
}

fn run_attach(
    target: Option<&str>,
    instance_filter: Option<&str>,
    takeover: bool,
) -> Result<String, String> {
    let found = match target {
        Some(query) => resolve_resource(query, instance_filter)?,
        None => resolve_sole_running_pty(instance_filter)?,
    };
    let id = found.descriptor["id"]
        .as_str()
        .ok_or_else(|| "resource descriptor missing id".to_string())?
        .to_string();
    let label = display_label(&found.descriptor);
    let tty = found.descriptor["tty"] == true || found.descriptor["pty"] == true;
    attach::run(found.client, &id, &label, tty, takeover)?;
    Ok(String::new())
}

fn run_inspect(
    target: &str,
    instance_filter: Option<&str>,
    force_json: bool,
) -> Result<String, String> {
    let found = resolve_resource(target, instance_filter)?;
    let id = found.descriptor["id"]
        .as_str()
        .ok_or_else(|| "resource descriptor missing id".to_string())?;
    let snapshot = found
        .client
        .call("process.v1.inspect", json!({ "id": id }), RPC_TIMEOUT)?;
    if force_json || !io::stdout().is_terminal() {
        return serde_json::to_string_pretty(&json!({
            "instance": found.client.instance(),
            "task": id,
            "name": found.descriptor.get("name").cloned().unwrap_or(Value::Null),
            "state": found.descriptor["state"],
            "humanControl": found.descriptor["humanControl"],
            "seq": snapshot["seq"],
            "cols": snapshot["cols"],
            "rows": snapshot["rows"],
            "cursorRow": snapshot["cursorRow"],
            "cursorCol": snapshot["cursorCol"],
            "alternateScreen": snapshot["alternateScreen"],
            "text": snapshot["text"],
        }))
        .map_err(|error| error.to_string());
    }
    Ok(snapshot["text"].as_str().unwrap_or_default().to_string())
}

fn run_close(
    target: &str,
    instance_filter: Option<&str>,
    force_json: bool,
) -> Result<String, String> {
    let found = resolve_resource(target, instance_filter)?;
    let id = found.descriptor["id"]
        .as_str()
        .ok_or_else(|| "resource descriptor missing id".to_string())?
        .to_string();
    let label = display_label(&found.descriptor);
    found
        .client
        .call("process.v1.kill", json!({ "id": id }), RPC_TIMEOUT)?;
    let mut descriptor = found.descriptor;
    let deadline = Instant::now() + CLOSE_WAIT_TIMEOUT;
    let mut seq = descriptor["latestSeq"].as_u64().unwrap_or(0);
    while descriptor["state"] == "running" && Instant::now() < deadline {
        let remaining = deadline
            .saturating_duration_since(Instant::now())
            .as_millis() as u64;
        if remaining == 0 {
            break;
        }
        let page = found.client.call(
            "process.v1.read",
            json!({ "id": id, "fromSeq": seq, "waitMs": remaining.min(100) }),
            RPC_TIMEOUT,
        )?;
        descriptor = page["process"].clone();
        seq = descriptor["latestSeq"].as_u64().unwrap_or(seq);
    }
    let state = descriptor["state"]
        .as_str()
        .unwrap_or("unknown")
        .to_string();
    if force_json || !io::stdout().is_terminal() {
        return serde_json::to_string_pretty(&json!({
            "instance": found.client.instance(),
            "taskId": id,
            "killRequested": true,
            "state": state,
        }))
        .map_err(|error| error.to_string());
    }
    if state == "running" {
        Ok(format!(
            "Termination requested for {label} ({id}); state is still running — check with `devshell-worker terminal list`"
        ))
    } else {
        Ok(format!("Closed {label} ({id}; state: {state})"))
    }
}

fn resolve_create_paths(
    current_dir: &Path,
    workspace: Option<&Path>,
    cwd: Option<&Path>,
    stateless: bool,
) -> Result<(Option<PathBuf>, PathBuf), String> {
    let abs = |path: &Path| -> PathBuf {
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            current_dir.join(path)
        }
    };
    if stateless {
        let raw_cwd = cwd.map(abs).unwrap_or_else(|| current_dir.to_path_buf());
        let canonical_cwd = raw_cwd
            .canonicalize()
            .map_err(|error| format!("invalid cwd {}: {error}", raw_cwd.display()))?;
        if !canonical_cwd.is_dir() {
            return Err(format!("cwd is not a directory: {}", canonical_cwd.display()));
        }
        return Ok((None, canonical_cwd));
    }

    let raw_workspace = workspace
        .map(abs)
        .or_else(|| cwd.map(abs))
        .unwrap_or_else(|| current_dir.to_path_buf());
    let canonical_workspace = raw_workspace
        .canonicalize()
        .map_err(|error| format!("invalid workspace {}: {error}", raw_workspace.display()))?;
    if !canonical_workspace.is_dir() {
        return Err(format!(
            "workspace is not a directory: {}",
            canonical_workspace.display()
        ));
    }

    let raw_cwd = if workspace.is_some() {
        match cwd {
            Some(path) if path.is_absolute() => path.to_path_buf(),
            Some(path) => canonical_workspace.join(path),
            None => canonical_workspace.clone(),
        }
    } else {
        canonical_workspace.clone()
    };
    let canonical_cwd = raw_cwd
        .canonicalize()
        .map_err(|error| format!("invalid cwd {}: {error}", raw_cwd.display()))?;
    if !canonical_cwd.is_dir() {
        return Err(format!("cwd is not a directory: {}", canonical_cwd.display()));
    }
    Ok((Some(canonical_workspace), canonical_cwd))
}

fn resolve_target_instance(explicit: Option<&str>) -> Result<InstanceName, String> {
    if let Some(raw) = explicit {
        return InstanceName::parse(raw);
    }
    let mut names = BTreeSet::new();
    for client in ProcessHostClient::discover()? {
        names.insert(client.instance().to_string());
    }
    for name in discover_running_daemons()? {
        names.insert(name);
    }
    match names.len() {
        0 => Err(
            "no running instance found on this host; start an instance first or pass --instance <name>"
                .into(),
        ),
        1 => InstanceName::parse(names.iter().next().expect("single instance")),
        _ => Err(format!(
            "multiple running instances found ({}); specify --instance <name>",
            names.into_iter().collect::<Vec<_>>().join(", ")
        )),
    }
}

fn discover_running_daemons() -> Result<Vec<String>, String> {
    let root = devshell_home()?;
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let mut running = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Ok(instance) = InstanceName::parse(&name) else {
            continue;
        };
        let Ok(endpoints) = EndpointPaths::resolve(&instance) else {
            continue;
        };
        if daemon_is_responsive(&endpoints) {
            running.push(name);
        }
    }
    running.sort();
    Ok(running)
}

fn spawn_persistent_terminal(
    instance: &InstanceName,
    workspace: Option<&Path>,
    cwd: &Path,
    name: Option<&str>,
    shell: Option<&str>,
    cols: u16,
    rows: u16,
) -> Result<(ProcessHostClient, Value), String> {
    let paths = InstancePaths::resolve(instance)?;
    let endpoints = EndpointPaths::resolve(instance)?;

    // Prefer an already-running Process Host directly so we inherit its exact
    // security mode and execution configuration without touching the Worker.
    if let Some(client) = ProcessHostClient::connect(instance, &paths, &endpoints)? {
        let cwd_arg = workspace
            .and_then(|root| cwd.strip_prefix(root).ok())
            .map(|relative| {
                if relative.as_os_str().is_empty() {
                    "./".to_string()
                } else {
                    format!("./{}", relative.display())
                }
            })
            .unwrap_or_else(|| cwd.to_string_lossy().into_owned());
        let descriptor = client.call(
            "process.v1.spawn",
            json!({
                "command": shell.unwrap_or_default(),
                "interactive": true,
                "persistent": true,
                "tty": true,
                "name": name,
                "cwd": cwd_arg,
                "workspace": workspace,
                "cols": cols,
                "rows": rows,
            }),
            RPC_TIMEOUT,
        )?;
        return Ok((client, descriptor));
    }

    // Otherwise, ask the running Worker daemon to create the terminal via
    // task_manage so Process Host starts under the daemon's own security mode
    // and execution identity (preventing execution_identity mismatches).
    if !daemon_is_responsive(&endpoints) {
        return Err(format!(
            "instance '{instance}' is not running; start it first with 'devshell instance start {instance}' or 'devshell-worker start --instance {instance}'"
        ));
    }

    let mut params = serde_json::Map::new();
    params.insert("command".into(), json!("create"));
    if let Some(name) = name {
        params.insert("name".into(), json!(name));
    }
    if let Some(shell) = shell {
        params.insert("shell".into(), json!(shell));
    }
    params.insert("cols".into(), json!(cols));
    params.insert("rows".into(), json!(rows));
    let (cwd_value, context) = match workspace {
        Some(root) => {
            let cwd_arg = cwd
                .strip_prefix(root)
                .ok()
                .map(|relative| {
                    if relative.as_os_str().is_empty() {
                        "./".to_string()
                    } else {
                        format!("./{}", relative.display())
                    }
                })
                .unwrap_or_else(|| cwd.to_string_lossy().into_owned());
            (
                cwd_arg,
                RpcRequestContext {
                    source: Some("cli".into()),
                    workspace: Some(root.to_string_lossy().into_owned()),
                    ..RpcRequestContext::default()
                },
            )
        }
        None => (
            cwd.to_string_lossy().into_owned(),
            RpcRequestContext {
                ctx_id: Some(STATELESS_CONTEXT_ID.into()),
                context_mode: Some("stateless".into()),
                source: Some("mcp".into()),
                ..RpcRequestContext::default()
            },
        ),
    };
    params.insert("cwd".into(), json!(cwd_value));

    let request = RpcRequest {
        message_type: "request".into(),
        id: format!("cli-terminal-create-{}", Uuid::new_v4()),
        method: "task_manage".into(),
        params: Value::Object(params),
        context: Some(context),
    };
    let response = send_request_with_timeout(&endpoints.socket_file, &request, RPC_TIMEOUT)?;
    if !response.ok {
        return Err(response.error.map_or_else(
            || "failed to create terminal through Worker daemon".into(),
            |error| format!("{}: {}", error.code, error.message),
        ));
    }
    let created = response
        .result
        .ok_or_else(|| "Worker daemon returned no create result".to_string())?;
    let id = created["task"]["id"]
        .as_str()
        .ok_or_else(|| "Worker daemon response missing task.id".to_string())?;
    let client = ProcessHostClient::connect(instance, &paths, &endpoints)?
        .ok_or_else(|| "Process Host was not available after terminal creation".to_string())?;
    let descriptor = client.call("process.v1.describe", json!({ "id": id }), RPC_TIMEOUT)?;
    Ok((client, descriptor))
}

fn discover_filtered(instance_filter: Option<&str>) -> Result<Vec<ProcessHostClient>, String> {
    let clients = ProcessHostClient::discover()?;
    match instance_filter {
        Some(filter) => Ok(clients
            .into_iter()
            .filter(|client| client.instance() == filter)
            .collect()),
        None => Ok(clients),
    }
}

fn collect_resources(instance_filter: Option<&str>) -> Result<Vec<DiscoveredResource>, String> {
    let mut resources = Vec::new();
    for client in discover_filtered(instance_filter)? {
        for descriptor in list(&client)? {
            resources.push(DiscoveredResource {
                client: client.clone(),
                descriptor,
            });
        }
    }
    Ok(resources)
}

fn resolve_resource(
    query: &str,
    instance_filter: Option<&str>,
) -> Result<DiscoveredResource, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("target cannot be empty".into());
    }
    let resources = collect_resources(instance_filter)?;

    // 1. Exact ID match.
    let exact_id: Vec<usize> = resources
        .iter()
        .enumerate()
        .filter(|(_, item)| item.descriptor["id"].as_str() == Some(query))
        .map(|(idx, _)| idx)
        .collect();
    if exact_id.len() == 1 {
        return Ok(resources.into_iter().nth(exact_id[0]).expect("matched"));
    }

    // 2. Exact name match (prefer running/persistent if an older exited task shares a name).
    let exact_name: Vec<usize> = resources
        .iter()
        .enumerate()
        .filter(|(_, item)| item.descriptor["name"].as_str() == Some(query))
        .map(|(idx, _)| idx)
        .collect();
    if let Some(selected) = select_unique_match(&resources, &exact_name, query)? {
        return Ok(resources.into_iter().nth(selected).expect("matched"));
    }

    // 3. Unique ID prefix match (matches either `process-<prefix>` or bare `<uuid-prefix>`).
    let prefix_matches: Vec<usize> = resources
        .iter()
        .enumerate()
        .filter(|(_, item)| {
            item.descriptor["id"].as_str().is_some_and(|id| {
                id.starts_with(query)
                    || id
                        .strip_prefix("process-")
                        .is_some_and(|uuid| uuid.starts_with(query))
            })
        })
        .map(|(idx, _)| idx)
        .collect();
    if let Some(selected) = select_unique_match(&resources, &prefix_matches, query)? {
        return Ok(resources.into_iter().nth(selected).expect("matched"));
    }

    Err(format!("unknown process {query}"))
}

fn select_unique_match(
    resources: &[DiscoveredResource],
    indices: &[usize],
    query: &str,
) -> Result<Option<usize>, String> {
    match indices.len() {
        0 => Ok(None),
        1 => Ok(Some(indices[0])),
        _ => {
            let active: Vec<usize> = indices
                .iter()
                .copied()
                .filter(|&idx| resources[idx].descriptor["state"] == "running")
                .collect();
            if active.len() == 1 {
                return Ok(Some(active[0]));
            }
            let candidates = indices
                .iter()
                .map(|&idx| {
                    let item = &resources[idx];
                    format!(
                        "  {}  {}  {}  {}",
                        item.client.instance(),
                        short_id(item.descriptor["id"].as_str().unwrap_or("")),
                        item.descriptor["name"].as_str().unwrap_or("-"),
                        item.descriptor["state"].as_str().unwrap_or("unknown"),
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            Err(format!(
                "ambiguous target '{query}' matches multiple resources (use a longer ID prefix or --instance):\n{candidates}"
            ))
        }
    }
}

fn resolve_sole_running_pty(instance_filter: Option<&str>) -> Result<DiscoveredResource, String> {
    let resources = collect_resources(instance_filter)?;
    let running_ptys: Vec<usize> = resources
        .iter()
        .enumerate()
        .filter(|(_, item)| {
            item.descriptor["state"] == "running"
                && (item.descriptor["tty"] == true || item.descriptor["pty"] == true)
        })
        .map(|(idx, _)| idx)
        .collect();
    match running_ptys.len() {
        0 => Err(
            "no running PTY terminal found; create one with `devshell-worker terminal create` or pass an ID"
                .into(),
        ),
        1 => Ok(resources.into_iter().nth(running_ptys[0]).expect("matched")),
        _ => {
            let list_text = running_ptys
                .iter()
                .map(|&idx| {
                    let item = &resources[idx];
                    format!(
                        "  {}  {}  {}  {}",
                        item.client.instance(),
                        short_id(item.descriptor["id"].as_str().unwrap_or("")),
                        item.descriptor["name"].as_str().unwrap_or("-"),
                        item.descriptor["workspace"]
                            .as_str()
                            .unwrap_or("(stateless)"),
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            Err(format!(
                "multiple running PTY terminals found; pass a target name or ID prefix:\n{list_text}"
            ))
        }
    }
}

fn format_table(resources: &[Value], show_all: bool) -> String {
    let mut active = Vec::new();
    let mut completed = Vec::new();
    for resource in resources {
        if resource["state"] == "running" || resource["persistent"] == true {
            active.push(resource);
        } else {
            completed.push(resource);
        }
    }
    active.sort_by(|left, right| {
        (right["state"] == "running")
            .cmp(&(left["state"] == "running"))
            .then_with(|| (right["persistent"] == true).cmp(&(left["persistent"] == true)))
            .then_with(|| {
                right["createdAtMs"]
                    .as_u64()
                    .cmp(&left["createdAtMs"].as_u64())
            })
    });
    completed.sort_by(|left, right| {
        right["createdAtMs"]
            .as_u64()
            .cmp(&left["createdAtMs"].as_u64())
    });

    let hidden_completed = if show_all { 0 } else { completed.len() };
    let mut visible = active;
    if show_all {
        visible.extend(completed);
    }

    if visible.is_empty() {
        if hidden_completed > 0 {
            return format!(
                "No active terminals or tasks ({hidden_completed} completed hidden; pass --all to show all)."
            );
        }
        return "No terminals or tasks found.".into();
    }

    let headers = [
        "INSTANCE",
        "ID",
        "NAME",
        "KIND",
        "STATE",
        "CTRL",
        "WORKSPACE",
        "COMMAND",
    ];
    let rows: Vec<[String; 8]> = visible
        .iter()
        .map(|entry| {
            let instance = entry["instance"].as_str().unwrap_or("-").to_string();
            let id = short_id(entry["id"].as_str().unwrap_or(""));
            let name = entry["name"].as_str().unwrap_or("-").to_string();
            let kind = if entry["persistent"] == true {
                "terminal"
            } else if entry["tty"] == true || entry["pty"] == true {
                "pty"
            } else {
                "pipe"
            }
            .to_string();
            let state = match entry["state"].as_str().unwrap_or("unknown") {
                "exited" => match entry["exit"]["exitCode"].as_i64() {
                    Some(code) => format!("exited({code})"),
                    None => "exited".into(),
                },
                other => other.to_string(),
            };
            let ctrl = if entry["humanControl"] == true {
                "human"
            } else if entry["tty"] == true || entry["pty"] == true {
                "model"
            } else {
                "-"
            }
            .to_string();
            let workspace = entry["workspace"]
                .as_str()
                .map(|path| truncate_middle(path, 32))
                .unwrap_or_else(|| "(stateless)".into());
            let command = entry["command"]
                .as_str()
                .map(|cmd| truncate_end(cmd, 36))
                .unwrap_or_else(|| "-".into());
            [instance, id, name, kind, state, ctrl, workspace, command]
        })
        .collect();

    let mut widths = [0usize; 8];
    for (idx, header) in headers.iter().enumerate() {
        widths[idx] = header.len();
    }
    for row in &rows {
        for (idx, cell) in row.iter().enumerate() {
            widths[idx] = widths[idx].max(cell.chars().count());
        }
    }

    let format_row = |cells: &[&str; 8]| -> String {
        let mut line = String::new();
        for (idx, cell) in cells.iter().enumerate() {
            if idx > 0 {
                line.push_str("  ");
            }
            line.push_str(cell);
            if idx < 7 {
                let pad = widths[idx].saturating_sub(cell.chars().count());
                for _ in 0..pad {
                    line.push(' ');
                }
            }
        }
        line
    };

    let mut lines = Vec::with_capacity(rows.len() + 2);
    lines.push(format_row(&headers));
    for row in &rows {
        let refs: [&str; 8] = [
            &row[0], &row[1], &row[2], &row[3], &row[4], &row[5], &row[6], &row[7],
        ];
        lines.push(format_row(&refs));
    }
    if hidden_completed > 0 {
        lines.push(format!(
            "({hidden_completed} completed hidden; pass --all to show all)"
        ));
    }
    lines.join("\n")
}

fn display_label(descriptor: &Value) -> String {
    let id = descriptor["id"].as_str().unwrap_or("");
    match descriptor["name"].as_str() {
        Some(name) if !name.is_empty() => format!("{name} ({})", short_id(id)),
        _ => short_id(id),
    }
}

fn short_id(id: &str) -> String {
    let rest = id.strip_prefix("process-").unwrap_or(id);
    rest.chars().take(8).collect()
}

fn truncate_end(text: &str, max_chars: usize) -> String {
    let count = text.chars().count();
    if count <= max_chars {
        return text.to_string();
    }
    let keep = max_chars.saturating_sub(1);
    let prefix: String = text.chars().take(keep).collect();
    format!("{prefix}…")
}

fn truncate_middle(text: &str, max_chars: usize) -> String {
    let count = text.chars().count();
    if count <= max_chars {
        return text.to_string();
    }
    let tail_len = max_chars.saturating_sub(2);
    let tail: String = text.chars().skip(count - tail_len).collect();
    format!("…{tail}")
}

fn validate_name(name: &str) -> Result<(), String> {
    let bytes = name.as_bytes();
    if bytes.is_empty()
        || bytes.len() > 64
        || !bytes[0].is_ascii_alphanumeric()
        || !bytes[1..]
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    {
        return Err(
            "name must be 1-64 ASCII alphanumeric or ._- characters starting with alphanumeric"
                .into(),
        );
    }
    Ok(())
}

fn list(client: &ProcessHostClient) -> Result<Vec<Value>, String> {
    serde_json::from_value(client.list()?).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[derive(Parser)]
    struct Wrapper {
        #[command(flatten)]
        terminal: TerminalArgs,
    }

    #[test]
    fn parses_create_attach_close_inspect_and_list_flags() {
        let create = Wrapper::try_parse_from([
            "terminal",
            "create",
            "--instance",
            "demo-local",
            "--workspace",
            "/tmp/ws",
            "--name",
            "debug",
            "--cols",
            "100",
            "--rows",
            "30",
            "--detach",
        ])
        .unwrap();
        assert!(matches!(create.terminal.command, Command::Create { .. }));

        let attach_default = Wrapper::try_parse_from(["terminal", "attach"]).unwrap();
        assert!(matches!(
            attach_default.terminal.command,
            Command::Attach {
                target: None,
                takeover: false,
                ..
            }
        ));

        let close = Wrapper::try_parse_from(["terminal", "close", "debug", "--json"]).unwrap();
        assert!(matches!(
            close.terminal.command,
            Command::Close { json: true, .. }
        ));

        let inspect = Wrapper::try_parse_from(["terminal", "inspect", "debug"]).unwrap();
        assert!(matches!(inspect.terminal.command, Command::Inspect { .. }));
    }

    #[test]
    fn format_table_hides_completed_by_default_and_shows_with_all() {
        let resources = vec![
            json!({
                "instance": "demo-local",
                "id": "process-11111111-2222-3333-4444-555555555555",
                "name": "dev",
                "persistent": true,
                "tty": true,
                "state": "running",
                "humanControl": false,
                "workspace": "/home/user/project",
                "command": "/bin/zsh",
                "createdAtMs": 200
            }),
            json!({
                "instance": "demo-local",
                "id": "process-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                "persistent": false,
                "tty": false,
                "state": "exited",
                "exit": { "exitCode": 0 },
                "humanControl": false,
                "workspace": "/home/user/project",
                "command": "echo hi",
                "createdAtMs": 100
            }),
        ];
        let active_only = format_table(&resources, false);
        assert!(active_only.contains("11111111"));
        assert!(active_only.contains("dev"));
        assert!(!active_only.contains("aaaaaaaa"));
        assert!(active_only.contains("1 completed hidden"));

        let all = format_table(&resources, true);
        assert!(all.contains("11111111"));
        assert!(all.contains("aaaaaaaa"));
        assert!(all.contains("exited(0)"));
    }

    #[test]
    fn resolve_create_paths_handles_relative_cwd_without_double_join() {
        let root = tempfile::tempdir().unwrap();
        let subdir = root.path().join("subdir");
        std::fs::create_dir_all(&subdir).unwrap();
        let canonical_root = root.path().canonicalize().unwrap();
        let canonical_subdir = subdir.canonicalize().unwrap();

        let (ws, cwd) =
            resolve_create_paths(root.path(), None, Some(Path::new("subdir")), false).unwrap();
        assert_eq!(ws, Some(canonical_subdir.clone()));
        assert_eq!(cwd, canonical_subdir);

        let (ws, cwd) = resolve_create_paths(
            root.path(),
            Some(Path::new(".")),
            Some(Path::new("subdir")),
            false,
        )
        .unwrap();
        assert_eq!(ws, Some(canonical_root));
        assert_eq!(cwd, canonical_subdir);

        let (ws, cwd) =
            resolve_create_paths(root.path(), None, Some(Path::new("subdir")), true).unwrap();
        assert_eq!(ws, None);
        assert_eq!(cwd, canonical_subdir);
    }
}
