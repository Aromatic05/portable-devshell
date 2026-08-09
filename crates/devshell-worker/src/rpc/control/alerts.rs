use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::rpc::error::RpcError;
use crate::rpc::router::{ControlHandler, control_handler, parse_params, serialize};

const DEFAULT_INTERVAL_MS: u64 = 30_000;
const DEFAULT_SCRIPT_TIMEOUT_MS: u64 = 5_000;
const MIN_INTERVAL_MS: u64 = 1_000;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AlertConfig {
    interval_ms: Option<u64>,
    max_uncommitted_changes: Option<usize>,
    scripts: Option<Vec<AlertScript>>,
    worker_memory_bytes: Option<u64>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AlertScript {
    command: Vec<String>,
    id: String,
    timeout_ms: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AlertsReadInput {
    config: Option<AlertConfig>,
    workspace: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Advice {
    code: String,
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AlertsReadResult {
    advice: Vec<Advice>,
}

struct WorkspaceAlerts {
    advice: Vec<Advice>,
    config: AlertConfig,
    last_run: Option<Instant>,
}

pub struct AlertService {
    state: Arc<Mutex<HashMap<PathBuf, WorkspaceAlerts>>>,
}

impl AlertService {
    pub fn new() -> Self {
        let state = Arc::new(Mutex::new(HashMap::<PathBuf, WorkspaceAlerts>::new()));
        let polling_state = Arc::clone(&state);
        thread::spawn(move || loop {
            poll_due(&polling_state);
            thread::sleep(Duration::from_millis(250));
        });
        Self { state }
    }

    fn read(&self, input: AlertsReadInput) -> Result<AlertsReadResult, RpcError> {
        let workspace = Path::new(&input.workspace).canonicalize().map_err(|error| {
            RpcError::new("workspace.invalid", format!("failed to resolve workspace {}: {error}", input.workspace))
        })?;
        let Some(config) = input.config else { return Ok(AlertsReadResult { advice: Vec::new() }); };
        validate_config(&config)?;
        {
            let mut state = self.state.lock().map_err(|_| RpcError::new("alerts.unavailable", "alert state lock poisoned"))?;
            state.insert(workspace.clone(), WorkspaceAlerts {
                advice: Vec::new(), config, last_run: None
            });
        }
        poll_workspace(&self.state, &workspace);
        let state = self.state.lock().map_err(|_| RpcError::new("alerts.unavailable", "alert state lock poisoned"))?;
        Ok(AlertsReadResult { advice: state.get(&workspace).map(|entry| entry.advice.clone()).unwrap_or_default() })
    }
}

pub fn handler(service: Arc<AlertService>) -> Arc<dyn ControlHandler> {
    control_handler(move |request| {
        let input: AlertsReadInput = parse_params(request)?;
        serialize(service.read(input)?)
    })
}

fn validate_config(config: &AlertConfig) -> Result<(), RpcError> {
    if config.interval_ms.is_some_and(|value| value < MIN_INTERVAL_MS) {
        return Err(RpcError::new("alerts.invalidConfig", "intervalMs must be at least 1000"));
    }
    for script in config.scripts.as_deref().unwrap_or_default() {
        if script.id.trim().is_empty() || script.command.is_empty() || script.command.iter().any(|part| part.is_empty()) {
            return Err(RpcError::new("alerts.invalidConfig", "scripts require a non-empty id and command"));
        }
        if script.timeout_ms.is_some_and(|value| value == 0) {
            return Err(RpcError::new("alerts.invalidConfig", "script timeoutMs must be positive"));
        }
    }
    Ok(())
}

fn poll_due(state: &Arc<Mutex<HashMap<PathBuf, WorkspaceAlerts>>>) {
    let workspaces: Vec<PathBuf> = state.lock().ok().map(|entries| entries.iter()
        .filter(|(_, entry)| entry.last_run.is_none_or(|last| last.elapsed() >= interval(&entry.config)))
        .map(|(workspace, _)| workspace.clone()).collect()).unwrap_or_default();
    for workspace in workspaces { poll_workspace(state, &workspace); }
}

fn poll_workspace(state: &Arc<Mutex<HashMap<PathBuf, WorkspaceAlerts>>>, workspace: &Path) {
    let config = state.lock().ok().and_then(|entries| entries.get(workspace).map(|entry| entry.config.clone()));
    let Some(config) = config else { return; };
    let advice = collect_advice(workspace, &config);
    if let Ok(mut entries) = state.lock() {
        if let Some(entry) = entries.get_mut(workspace) {
            entry.advice = advice;
            entry.last_run = Some(Instant::now());
        }
    }
}

fn interval(config: &AlertConfig) -> Duration { Duration::from_millis(config.interval_ms.unwrap_or(DEFAULT_INTERVAL_MS)) }

fn collect_advice(workspace: &Path, config: &AlertConfig) -> Vec<Advice> {
    let mut advice = Vec::new();
    if let (Some(limit), Some(used)) = (config.worker_memory_bytes, worker_rss_bytes()) {
        if used >= limit { advice.push(Advice { code: "worker.memory.high".to_string(), text: format!("Worker RSS is {} MiB, at or above its {} MiB alert threshold. Stop high-memory work and clean up child processes before continuing.", used / 1024 / 1024, limit / 1024 / 1024) }); }
    }
    if let Some(limit) = config.max_uncommitted_changes {
        match uncommitted_changes(workspace) {
            Ok(count) if count >= limit => advice.push(Advice { code: "git.uncommittedChanges.high".to_string(), text: format!("This workspace has {count} uncommitted changes, at or above its alert threshold. Inspect and split the work before expanding the diff.") }),
            Err(error) => advice.push(Advice { code: "git.status.failed".to_string(), text: format!("Could not inspect uncommitted changes: {error}") }),
            _ => {}
        }
    }
    for script in config.scripts.as_deref().unwrap_or_default() { advice.extend(run_script(workspace, script)); }
    advice
}

#[cfg(target_os = "linux")]
fn worker_rss_bytes() -> Option<u64> {
    std::fs::read_to_string("/proc/self/status").ok()?.lines().find_map(|line| line.strip_prefix("VmRSS:")?.split_whitespace().next()?.parse::<u64>().ok().map(|value| value * 1024))
}

#[cfg(all(unix, not(target_os = "linux")))]
fn worker_rss_bytes() -> Option<u64> {
    let output = Command::new("ps").args(["-o", "rss=", "-p", &std::process::id().to_string()]).output().ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().parse::<u64>().ok().map(|value| value * 1024))?
}

#[cfg(windows)]
fn worker_rss_bytes() -> Option<u64> {
    use std::mem::size_of;
    use windows_sys::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    let mut counters: PROCESS_MEMORY_COUNTERS = unsafe { std::mem::zeroed() };
    counters.cb = size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
    (unsafe { GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.cb) } != 0).then_some(counters.WorkingSetSize as u64)
}

#[cfg(not(any(unix, windows)))]
fn worker_rss_bytes() -> Option<u64> { None }

fn uncommitted_changes(workspace: &Path) -> Result<usize, String> {
    let output = Command::new("git").args(["status", "--porcelain"]).current_dir(workspace).output().map_err(|error| error.to_string())?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    Ok(String::from_utf8_lossy(&output.stdout).lines().count())
}

fn run_script(workspace: &Path, script: &AlertScript) -> Vec<Advice> {
    let mut command = Command::new(&script.command[0]);
    command.args(&script.command[1..]).current_dir(workspace).env("DEVSHELL_ALERT_WORKSPACE", workspace).stdout(Stdio::piped());
    let mut child = match command.spawn() { Ok(child) => child, Err(error) => return vec![script_failure(script, error.to_string())] };
    let timeout = Duration::from_millis(script.timeout_ms.unwrap_or(DEFAULT_SCRIPT_TIMEOUT_MS));
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(status)) => return vec![script_failure(script, format!("exited with {status}"))],
            Ok(None) if started.elapsed() >= timeout => { let _ = child.kill(); let _ = child.wait(); return vec![script_failure(script, "timed out".to_string())]; }
            Ok(None) => thread::sleep(Duration::from_millis(10)),
            Err(error) => return vec![script_failure(script, error.to_string())]
        }
    }
    match child.wait_with_output().ok().and_then(|output| serde_json::from_slice::<Vec<Advice>>(&output.stdout).ok()) {
        Some(advice) => advice.into_iter().filter(|entry| valid_advice(entry)).collect(),
        None => vec![script_failure(script, "did not emit a JSON advice array".to_string())]
    }
}

fn script_failure(script: &AlertScript, reason: String) -> Advice { Advice { code: format!("alert.script.{}.failed", script.id), text: format!("Alert script {} failed: {reason}", script.id) } }
fn valid_advice(advice: &Advice) -> bool { !advice.text.trim().is_empty() && advice.code.chars().all(|character| character.is_ascii_alphanumeric() || character == '.' || character == '_' || character == '-') }

#[cfg(test)]
mod tests {
    use super::{AlertScript, run_script};

    #[cfg(unix)]
    #[test]
    fn custom_script_emits_valid_advice() {
        let workspace = crate::testing::temp_dir();
        let advice = run_script(workspace.path(), &AlertScript {
            command: vec!["sh".to_string(), "-c".to_string(), "printf '%s' '[{\"code\":\"custom.ready\",\"text\":\"custom alert\"}]'".to_string()],
            id: "custom".to_string(),
            timeout_ms: Some(1_000)
        });
        assert_eq!(advice.len(), 1);
        assert_eq!(advice[0].code, "custom.ready");
        assert_eq!(advice[0].text, "custom alert");
    }
}
