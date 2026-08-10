use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::rpc::error::RpcError;
use crate::rpc::router::{ControlHandler, control_handler, parse_params, serialize};

const DEFAULT_INTERVAL_MS: u64 = 30_000;
const DEFAULT_SCRIPT_TIMEOUT_MS: u64 = 5_000;
const CACHE_IDLE_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const MIN_INTERVAL_MS: u64 = 1_000;

#[derive(Clone, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AlertConfig {
    interval_ms: Option<u64>,
    max_uncommitted_changes: Option<usize>,
    scripts: Option<Vec<AlertScript>>,
    worker_memory_bytes: Option<u64>,
}

#[derive(Clone, Deserialize, Eq, PartialEq)]
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AlertsConfigureInput {
    config: Option<AlertConfig>,
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
    active_probe: Option<u64>,
    advice: Vec<Advice>,
    config: AlertConfig,
    last_run: Option<Instant>,
    last_seen: Instant,
}

pub struct AlertService {
    next_probe_id: Arc<AtomicU64>,
    state: Arc<Mutex<HashMap<PathBuf, WorkspaceAlerts>>>,
}

impl AlertService {
    pub fn new() -> Self {
        let state = Arc::new(Mutex::new(HashMap::new()));
        let next_probe_id = Arc::new(AtomicU64::new(1));
        let polling_state = Arc::clone(&state);
        let polling_probe_id = Arc::clone(&next_probe_id);
        thread::spawn(move || loop {
            poll_due(&polling_state, &polling_probe_id);
            thread::sleep(Duration::from_millis(250));
        });
        Self { next_probe_id, state }
    }

    fn read(&self, input: AlertsReadInput) -> Result<AlertsReadResult, RpcError> {
        let workspace = Path::new(&input.workspace).canonicalize().map_err(|error| {
            RpcError::new("workspace.invalid", format!("failed to resolve workspace {}: {error}", input.workspace))
        })?;
        let Some(config) = input.config else {
            self.state.lock()
                .map_err(|_| RpcError::new("alerts.unavailable", "alert state lock poisoned"))?
                .remove(&workspace);
            return Ok(AlertsReadResult { advice: Vec::new() });
        };
        validate_config(&config)?;
        let now = Instant::now();
        let probe_id = self.next_probe_id.fetch_add(1, Ordering::Relaxed);
        {
            let mut state = self.state.lock()
                .map_err(|_| RpcError::new("alerts.unavailable", "alert state lock poisoned"))?;
            state.insert(workspace.clone(), WorkspaceAlerts {
                active_probe: Some(probe_id),
                advice: Vec::new(),
                config: config.clone(),
                last_run: None,
                last_seen: now,
            });
        }
        let advice = collect_advice(&workspace, &config);
        complete_probe(&self.state, &workspace, probe_id, &config, advice);
        let state = self.state.lock()
            .map_err(|_| RpcError::new("alerts.unavailable", "alert state lock poisoned"))?;
        Ok(AlertsReadResult {
            advice: state.get(&workspace).map(|entry| entry.advice.clone()).unwrap_or_default(),
        })
    }

    fn touch(&self, input: AlertsReadInput) -> Result<(), RpcError> {
        let workspace = Path::new(&input.workspace).canonicalize().map_err(|error| {
            RpcError::new("workspace.invalid", format!("failed to resolve workspace {}: {error}", input.workspace))
        })?;
        let Some(config) = input.config else {
            self.state.lock()
                .map_err(|_| RpcError::new("alerts.unavailable", "alert state lock poisoned"))?
                .remove(&workspace);
            return Ok(());
        };
        validate_config(&config)?;
        let now = Instant::now();
        let mut state = self.state.lock()
            .map_err(|_| RpcError::new("alerts.unavailable", "alert state lock poisoned"))?;
        match state.get_mut(&workspace) {
            Some(entry) => {
                if entry.config != config {
                    entry.config = config;
                    entry.advice.clear();
                    entry.last_run = None;
                }
                entry.last_seen = now;
            }
            None => {
                state.insert(workspace, WorkspaceAlerts {
                    active_probe: None,
                    advice: Vec::new(),
                    config,
                    last_run: None,
                    last_seen: now,
                });
            }
        }
        Ok(())
    }

    fn configure(&self, config: Option<AlertConfig>) -> Result<(), RpcError> {
        let Some(config) = config else {
            self.state.lock()
                .map_err(|_| RpcError::new("alerts.unavailable", "alert state lock poisoned"))?
                .clear();
            return Ok(());
        };
        validate_config(&config)?;
        let mut state = self.state.lock()
            .map_err(|_| RpcError::new("alerts.unavailable", "alert state lock poisoned"))?;
        for entry in state.values_mut() {
            if entry.config != config {
                entry.config = config.clone();
                entry.advice.clear();
                entry.last_run = None;
            }
        }
        Ok(())
    }
}

pub fn read_handler(service: Arc<AlertService>) -> Arc<dyn ControlHandler> {
    control_handler(move |request| {
        let input: AlertsReadInput = parse_params(request)?;
        serialize(service.read(input)?)
    })
}

pub fn touch_handler(service: Arc<AlertService>) -> Arc<dyn ControlHandler> {
    control_handler(move |request| {
        let input: AlertsReadInput = parse_params(request)?;
        service.touch(input)?;
        serialize(serde_json::json!({}))
    })
}

pub fn configure_handler(service: Arc<AlertService>) -> Arc<dyn ControlHandler> {
    control_handler(move |request| {
        let input: AlertsConfigureInput = parse_params(request)?;
        service.configure(input.config)?;
        serialize(serde_json::json!({}))
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

fn interval(config: &AlertConfig) -> Duration {
    Duration::from_millis(config.interval_ms.unwrap_or(DEFAULT_INTERVAL_MS))
}

fn poll_due(
    state: &Arc<Mutex<HashMap<PathBuf, WorkspaceAlerts>>>,
    next_probe_id: &Arc<AtomicU64>,
) {
    let now = Instant::now();
    let probes: Vec<(PathBuf, AlertConfig, u64)> = state.lock().ok().map(|mut entries| {
        entries.retain(|_, entry| now.saturating_duration_since(entry.last_seen) < CACHE_IDLE_TTL);
        entries.iter_mut().filter_map(|(workspace, entry)| {
            if entry.active_probe.is_some() ||
                entry.last_run.is_some_and(|last| now.saturating_duration_since(last) < interval(&entry.config))
            {
                return None;
            }
            let probe_id = next_probe_id.fetch_add(1, Ordering::Relaxed);
            entry.active_probe = Some(probe_id);
            Some((workspace.clone(), entry.config.clone(), probe_id))
        }).collect()
    }).unwrap_or_default();
    for (workspace, config, probe_id) in probes {
        let advice = collect_advice(&workspace, &config);
        complete_probe(state, &workspace, probe_id, &config, advice);
    }
}

fn complete_probe(
    state: &Arc<Mutex<HashMap<PathBuf, WorkspaceAlerts>>>,
    workspace: &Path,
    probe_id: u64,
    config: &AlertConfig,
    advice: Vec<Advice>,
) {
    if let Ok(mut entries) = state.lock() {
        if let Some(entry) = entries.get_mut(workspace) {
            if entry.active_probe != Some(probe_id) {
                return;
            }
            entry.active_probe = None;
            if entry.config == *config {
                entry.advice = advice;
                entry.last_run = Some(Instant::now());
            }
        }
    }
}

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
    let repository = Command::new("git").args(["rev-parse", "--is-inside-work-tree"]).current_dir(workspace).output().map_err(|error| error.to_string())?;
    if !repository.status.success() || String::from_utf8_lossy(&repository.stdout).trim() != "true" { return Ok(0); }
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
    use super::{
        AlertConfig, AlertScript, AlertService, AlertsReadInput, CACHE_IDLE_TTL,
        run_script, uncommitted_changes,
    };
    use std::sync::Arc;

    #[test]
    fn non_git_workspace_has_no_uncommitted_changes() {
        let workspace = crate::testing::temp_dir();
        assert_eq!(uncommitted_changes(workspace.path()).unwrap(), 0);
    }

    #[test]
    fn disabling_alerts_clears_registered_workspace_state() {
        let workspace = crate::testing::temp_dir();
        let service = AlertService::new();
        service.read(AlertsReadInput {
            config: Some(AlertConfig {
                interval_ms: Some(1_000),
                max_uncommitted_changes: None,
                scripts: None,
                worker_memory_bytes: None,
            }),
            workspace: workspace.path().display().to_string(),
        }).unwrap();
        assert_eq!(service.state.lock().unwrap().len(), 1);

        service.configure(None).unwrap();

        assert!(service.state.lock().unwrap().is_empty());
    }

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

    #[cfg(unix)]
    #[test]
    fn initial_probe_is_not_scheduled_again_while_it_is_in_flight() {
        let workspace = crate::testing::temp_dir();
        let service = Arc::new(AlertService::new());
        let reader = Arc::clone(&service);
        let workspace_path = workspace.path().to_path_buf();
        let read = std::thread::spawn(move || {
            reader.read(AlertsReadInput {
                config: Some(AlertConfig {
                    interval_ms: Some(1_000),
                    max_uncommitted_changes: None,
                    scripts: Some(vec![AlertScript {
                        command: vec![
                            "sh".to_string(),
                            "-c".to_string(),
                            "printf 'x\\n' >> probe-count; while [ ! -f release-probe ]; do sleep 0.01; done; printf '[]'".to_string(),
                        ],
                        id: "counter".to_string(),
                        timeout_ms: Some(2_000),
                    }]),
                    worker_memory_bytes: None,
                }),
                workspace: workspace_path.display().to_string(),
            }).unwrap();
        });

        let probe_count = workspace.path().join("probe-count");
        let started = std::time::Instant::now();
        while !probe_count.exists() && started.elapsed() < std::time::Duration::from_secs(1) {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(probe_count.exists(), "initial alert probe did not start");
        std::thread::sleep(std::time::Duration::from_millis(350));
        std::fs::write(workspace.path().join("release-probe"), b"release").unwrap();
        read.join().unwrap();

        let probes = std::fs::read_to_string(probe_count).unwrap();
        assert_eq!(probes.lines().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn background_probes_stop_after_the_workspace_lease_expires() {
        let workspace = crate::testing::temp_dir();
        let service = AlertService::new();
        service.read(AlertsReadInput {
            config: Some(AlertConfig {
                interval_ms: Some(1_000),
                max_uncommitted_changes: None,
                scripts: Some(vec![AlertScript {
                    command: vec![
                        "sh".to_string(),
                        "-c".to_string(),
                        "printf 'x\\n' >> probe-count; printf '[]'".to_string(),
                    ],
                    id: "counter".to_string(),
                    timeout_ms: Some(1_000),
                }]),
                worker_memory_bytes: None,
            }),
            workspace: workspace.path().display().to_string(),
        }).unwrap();

        let canonical = workspace.path().canonicalize().unwrap();
        {
            let mut state = service.state.lock().unwrap();
            state.get_mut(&canonical).unwrap().last_seen = std::time::Instant::now()
                .checked_sub(CACHE_IDLE_TTL + std::time::Duration::from_secs(1))
                .unwrap();
        }
        std::thread::sleep(std::time::Duration::from_millis(350));

        assert!(!service.state.lock().unwrap().contains_key(&canonical));
    }
}
