use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::daemon::process::WorkerRuntimeContext;
use crate::platform::unix_time_millis;
use crate::socket::SocketPaths;
use crate::storage::InstancePaths;
use crate::storage::permissions::ensure_dir;
use crate::tools::ToolError;
use crate::tools::tmux::codec::{TmuxInputChunk, parse_tmux_input, sanitize_terminal_snapshot};
use crate::tools::tmux::shell::prepare_shell_launch;

pub const TMUX_SESSION: &str = "devshell";
pub const MAX_PANES: usize = 16;
const PANE_HISTORY_LINES: i64 = 400;
const TERMINAL_HISTORY_LINES: usize = 10_000;
const TERMINAL_COLUMNS: usize = 240;
const TERMINAL_ROWS: usize = 60;

#[derive(Debug, Clone)]
pub struct BackendPane {
    pub id: String,
    pub name: String,
    pub automatic: bool,
    pub tmux_pane_id: String,
    pub tmux_window_id: String,
    pub window_panes: usize,
    pub columns: usize,
    pub rows: usize,
    pub pane_incarnation_id: String,
    pub created_at_ms: u128,
    pub cwd: String,
    pub command: String,
    pub lines: Vec<String>,
    pub status: Option<String>,
    pub status_task_id: Option<String>,
    pub managed_task_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct BackendWorkspace {
    pub panes: Vec<BackendPane>,
    pub total_panes: usize,
    pub foreign_panes: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionRecord {
    schema_version: u32,
    session_id: String,
    instance: String,
    created_at_ms: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PaneRecord {
    schema_version: u32,
    pane_id: String,
    pane_incarnation_id: String,
    name: String,
    #[serde(default)]
    automatic: bool,
    #[serde(default)]
    task_id: Option<String>,
    created_at_ms: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PaneStatusRecord {
    state: String,
    exit_code: i32,
    seq: u64,
    #[serde(default)]
    task_id: Option<String>,
}

pub struct TmuxBackend {
    instance: String,
    workspace: PathBuf,
    socket: PathBuf,
    panes_dir: PathBuf,
    shell_dir: PathBuf,
    status_dir: PathBuf,
    tasks_dir: PathBuf,
    transcripts_dir: PathBuf,
    session_file: PathBuf,
    observation_reset: bool,
    session_prepared: AtomicBool,
}

impl TmuxBackend {
    pub fn available() -> bool {
        Command::new("tmux")
            .arg("-V")
            .output()
            .is_ok_and(|output| output.status.success())
    }

    pub fn new(
        instance_paths: &InstancePaths,
        socket_paths: &SocketPaths,
        runtime: &WorkerRuntimeContext,
        workspace: &Path,
    ) -> Result<Self, ToolError> {
        let workspace_key = workspace_key(&instance_paths.instance_root, workspace);
        let (root, socket) =
            workspace_storage(instance_paths, socket_paths, workspace, &workspace_key)?;
        let panes_dir = root.join("panes").join("by-id");
        let shell_dir = root.join("shell");
        let status_dir = root.join("status");
        let tasks_dir = root.join("tasks");
        let transcripts_dir = root.join("transcripts");
        for path in [
            &root,
            &panes_dir,
            &shell_dir,
            &status_dir,
            &tasks_dir,
            &transcripts_dir,
        ] {
            ensure_dir(path, 0o700).map_err(|error| ToolError::new("tmux.storageFailed", error))?;
        }
        let observation_reset = session_exists(&socket);
        Ok(Self {
            instance: runtime.instance.as_str().to_string(),
            workspace: workspace.to_path_buf(),
            socket,
            panes_dir,
            shell_dir,
            status_dir,
            tasks_dir,
            transcripts_dir,
            session_file: root.join("session.json"),
            observation_reset,
            session_prepared: AtomicBool::new(false),
        })
    }

    pub fn observation_reset(&self) -> bool {
        self.observation_reset
    }

    pub fn has_session(&self) -> bool {
        session_exists(&self.socket)
    }

    pub fn ensure_session(&self) -> Result<(), ToolError> {
        if session_exists(&self.socket) {
            if !self.session_prepared.load(Ordering::Acquire) {
                self.validate_existing_session()?;
                self.configure_terminal_size()?;
                self.normalize_managed_windows()?;
                self.reconcile_registry()?;
                self.session_prepared.store(true, Ordering::Release);
            }
            return Ok(());
        }

        self.session_prepared.store(false, Ordering::Release);
        self.clear_stale_pane_records()?;
        let session = self.new_session_record();
        atomic_write_json(&self.session_file, &session)?;
        let pane = PaneRecord::new("main", false, None)?;
        let launch = prepare_shell_launch(&self.shell_dir, &self.status_dir, &pane.pane_id)?;
        let args = vec![
            "new-session".to_string(),
            "-d".to_string(),
            "-s".to_string(),
            TMUX_SESSION.to_string(),
            "-x".to_string(),
            TERMINAL_COLUMNS.to_string(),
            "-y".to_string(),
            TERMINAL_ROWS.to_string(),
            "-n".to_string(),
            "main".to_string(),
            "-c".to_string(),
            self.workspace.to_string_lossy().to_string(),
            launch.command,
        ];
        self.run(&args)?;
        self.configure_terminal_size()?;
        self.mark_session(&session)?;
        let tmux_pane_id = self
            .run(&[
                "display-message".into(),
                "-p".into(),
                "-t".into(),
                TMUX_SESSION.into(),
                "#{pane_id}".into(),
            ])?
            .trim()
            .to_string();
        if tmux_pane_id.is_empty() {
            return Err(ToolError::new(
                "tmux.startFailed",
                "new tmux session did not expose an initial pane",
            ));
        }
        self.mark_pane(&tmux_pane_id, &pane)?;
        self.persist_pane(&pane)?;
        self.wait_until_ready(&pane.pane_id, Duration::from_secs(3))?;
        self.discard_initial_prompt_output(&pane.pane_id, Duration::from_secs(3))?;
        self.session_prepared.store(true, Ordering::Release);
        Ok(())
    }

    pub fn capture_workspace(&self) -> Result<BackendWorkspace, ToolError> {
        let pane_format = [
            "#{pane_id}",
            "#{@devshell_worker_pane_id}",
            "#{@devshell_worker_pane_name}",
            "#{@devshell_worker_pane_incarnation_id}",
            "#{@devshell_worker_created_at}",
            "#{window_id}",
            "#{window_panes}",
            "#{pane_width}",
            "#{pane_height}",
            "#{q:pane_current_path}",
            "#{q:pane_current_command}",
            "#{@devshell_worker_automatic}",
            "#{pane_dead}",
            "#{pane_dead_status}",
            "#{@devshell_worker_task_id}",
            "#{pane_dead_signal}",
        ]
        .join("|");
        let raw = self.run(&[
            "list-panes".into(),
            "-s".into(),
            "-t".into(),
            TMUX_SESSION.into(),
            "-F".into(),
            pane_format,
        ])?;
        let mut panes = Vec::new();
        let mut total_panes = 0;
        let mut foreign_panes = 0;
        for line in raw.lines().filter(|line| !line.trim().is_empty()) {
            total_panes += 1;
            let fields = split_tmux_fields(line);
            let Some(tmux_pane_id) = fields.first().copied() else {
                continue;
            };
            let id = fields.get(1).copied().unwrap_or_default();
            let name = fields.get(2).copied().unwrap_or_default();
            let pane_incarnation_id = fields.get(3).copied().unwrap_or_default();
            let created_at_ms = fields
                .get(4)
                .and_then(|value| value.parse::<u128>().ok())
                .unwrap_or_default();
            if id.is_empty()
                || name.is_empty()
                || pane_incarnation_id.is_empty()
                || created_at_ms == 0
            {
                foreign_panes += 1;
                continue;
            }
            let lines = self.capture_lines(tmux_pane_id, -PANE_HISTORY_LINES, 0)?;
            let managed_task_id = fields
                .get(14)
                .copied()
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned);
            let shell_status = self.read_status(id);
            let task_status = managed_task_id.as_ref().map(|_| {
                if fields.get(12).copied() == Some("1") {
                    if let Some(status) = fields.get(13).copied().filter(|value| !value.is_empty())
                    {
                        status.to_string()
                    } else if let Some(signal) =
                        fields.get(15).and_then(|value| value.parse::<i32>().ok())
                    {
                        (128 + signal).to_string()
                    } else {
                        "unknown".to_string()
                    }
                } else {
                    "running".to_string()
                }
            });
            panes.push(BackendPane {
                id: id.to_string(),
                name: name.to_string(),
                automatic: fields.get(11).copied() == Some("1"),
                tmux_pane_id: tmux_pane_id.to_string(),
                tmux_window_id: fields.get(5).copied().unwrap_or_default().to_string(),
                window_panes: fields
                    .get(6)
                    .and_then(|value| value.parse::<usize>().ok())
                    .unwrap_or(1),
                columns: fields
                    .get(7)
                    .and_then(|value| value.parse::<usize>().ok())
                    .unwrap_or_default(),
                rows: fields
                    .get(8)
                    .and_then(|value| value.parse::<usize>().ok())
                    .unwrap_or_default(),
                pane_incarnation_id: pane_incarnation_id.to_string(),
                created_at_ms,
                cwd: decode_tmux_argument(fields.get(9).copied().unwrap_or_default())?,
                command: decode_tmux_argument(fields.get(10).copied().unwrap_or_default())?,
                lines,
                status: task_status.or_else(|| shell_status.as_ref().map(status_text)),
                status_task_id: managed_task_id
                    .clone()
                    .or_else(|| shell_status.and_then(|record| record.task_id)),
                managed_task_id,
            });
        }
        panes.sort_by_key(|pane| pane.created_at_ms);
        Ok(BackendWorkspace {
            panes,
            total_panes,
            foreign_panes,
        })
    }

    pub fn capture_lines(
        &self,
        tmux_pane_id: &str,
        start: i64,
        end: i64,
    ) -> Result<Vec<String>, ToolError> {
        let raw = self.run(&[
            "capture-pane".into(),
            "-p".into(),
            "-e".into(),
            "-t".into(),
            tmux_pane_id.into(),
            "-S".into(),
            "-".into(),
            "-E".into(),
            "-".into(),
        ])?;
        let sanitized = sanitize_terminal_snapshot(&raw);
        let lines = sanitized.lines().map(ToOwned::to_owned).collect::<Vec<_>>();
        let logical_start = lines.len().saturating_sub(start.unsigned_abs() as usize);
        let logical_end = lines.len().saturating_sub(end.unsigned_abs() as usize);
        let mut selected = lines[logical_start.min(logical_end)..logical_end].to_vec();
        while selected.last().is_some_and(String::is_empty) {
            selected.pop();
        }
        Ok(selected)
    }

    pub fn send_input(&self, tmux_pane_id: &str, input: &str) -> Result<(), ToolError> {
        for chunk in parse_tmux_input(input)? {
            match chunk {
                TmuxInputChunk::Literal(text) => {
                    self.run(&[
                        "send-keys".into(),
                        "-t".into(),
                        tmux_pane_id.into(),
                        "-l".into(),
                        text,
                    ])?;
                }
                TmuxInputChunk::Key(key) => {
                    self.run(&[
                        "send-keys".into(),
                        "-t".into(),
                        tmux_pane_id.into(),
                        key.into(),
                    ])?;
                }
            }
        }
        Ok(())
    }

    pub fn create_pane(
        &self,
        name: &str,
        cwd: &Path,
        automatic: bool,
    ) -> Result<BackendPane, ToolError> {
        let pane = PaneRecord::new(name, automatic, None)?;
        let launch = prepare_shell_launch(&self.shell_dir, &self.status_dir, &pane.pane_id)?;
        let args = vec![
            "new-window".to_string(),
            "-d".to_string(),
            "-P".to_string(),
            "-F".to_string(),
            "#{pane_id}".to_string(),
            "-t".to_string(),
            format!("{TMUX_SESSION}:"),
            "-n".to_string(),
            name.to_string(),
            "-c".to_string(),
            cwd.to_string_lossy().to_string(),
            launch.command,
        ];
        let tmux_pane_id = self.run(&args)?.trim().to_string();
        if tmux_pane_id.is_empty() {
            return Err(ToolError::new(
                "tmux.createFailed",
                "tmux new-window returned an empty pane id",
            ));
        }
        if let Err(error) = self.mark_pane(&tmux_pane_id, &pane) {
            let _ = self.run(&["kill-pane".into(), "-t".into(), tmux_pane_id.clone()]);
            return Err(error);
        }
        if let Err(error) = self.persist_pane(&pane) {
            let _ = self.run(&["kill-pane".into(), "-t".into(), tmux_pane_id.clone()]);
            return Err(error);
        }
        if let Err(error) = self.wait_until_ready(&pane.pane_id, Duration::from_secs(3)) {
            let _ = self.run(&["kill-pane".into(), "-t".into(), tmux_pane_id.clone()]);
            let _ = self.remove_pane_record(&pane.pane_id);
            return Err(error);
        }
        if let Err(error) =
            self.discard_initial_prompt_output(&pane.pane_id, Duration::from_secs(3))
        {
            let _ = self.run(&["kill-pane".into(), "-t".into(), tmux_pane_id.clone()]);
            let _ = self.remove_pane_record(&pane.pane_id);
            return Err(error);
        }
        self.capture_workspace()?
            .panes
            .into_iter()
            .find(|candidate| candidate.id == pane.pane_id)
            .ok_or_else(|| ToolError::new("tmux.createFailed", "created pane disappeared"))
    }

    pub fn create_task_pane(
        &self,
        task_id: &str,
        cwd: &Path,
        command: &str,
    ) -> Result<BackendPane, ToolError> {
        let pane = PaneRecord::new(task_id, true, Some(task_id.to_string()))?;
        let script_path = self.tasks_dir.join(format!("{task_id}.sh"));
        let gate_path = self.tasks_dir.join(format!("{task_id}.start"));
        let transcript_path = self.transcript_path(task_id);
        let transcript_done_path = self.transcript_done_path(task_id);
        let _ = fs::remove_file(&gate_path);
        let _ = fs::remove_file(&transcript_done_path);
        atomic_write_bytes(&transcript_path, b"")?;
        let script = format!(
            "while [ ! -e {} ]; do sleep 0.02; done\nrm -f {}\n{}",
            shell_quote(&gate_path.to_string_lossy()),
            shell_quote(&gate_path.to_string_lossy()),
            command,
        );
        atomic_write_bytes(&script_path, script.as_bytes())?;
        let launch = format!(
            "exec /bin/bash --noprofile --norc {}",
            shell_quote(&script_path.to_string_lossy())
        );
        let args = vec![
            "new-window".to_string(),
            "-d".to_string(),
            "-P".to_string(),
            "-F".to_string(),
            "#{pane_id}".to_string(),
            "-t".to_string(),
            format!("{TMUX_SESSION}:"),
            "-n".to_string(),
            task_id.to_string(),
            "-c".to_string(),
            cwd.to_string_lossy().to_string(),
            launch,
        ];
        let tmux_pane_id = self.run(&args)?.trim().to_string();
        if tmux_pane_id.is_empty() {
            self.remove_task_runtime(task_id);
            return Err(ToolError::new(
                "tmux.createFailed",
                "tmux new-window returned an empty task pane id",
            ));
        }
        let setup = (|| {
            self.mark_pane(&tmux_pane_id, &pane)?;
            self.persist_pane(&pane)?;
            self.run(&[
                "set-option".into(),
                "-w".into(),
                "-t".into(),
                tmux_pane_id.clone(),
                "remain-on-exit".into(),
                "on".into(),
            ])?;
            self.run(&[
                "pipe-pane".into(),
                "-t".into(),
                tmux_pane_id.clone(),
                format!(
                    "cat >> {}; : > {}",
                    shell_quote(&transcript_path.to_string_lossy()),
                    shell_quote(&transcript_done_path.to_string_lossy()),
                ),
            ])?;
            Ok::<(), ToolError>(())
        })();
        if let Err(error) = setup {
            let _ = self.run(&["kill-pane".into(), "-t".into(), tmux_pane_id.clone()]);
            let _ = self.remove_pane_record(&pane.pane_id);
            self.remove_task_runtime(task_id);
            let _ = fs::remove_file(&transcript_path);
            return Err(error);
        }
        self.capture_workspace()?
            .panes
            .into_iter()
            .find(|candidate| candidate.id == pane.pane_id)
            .ok_or_else(|| ToolError::new("tmux.createFailed", "created task pane disappeared"))
    }

    pub fn start_task_pane(&self, task_id: &str) -> Result<(), ToolError> {
        let gate_path = self.tasks_dir.join(format!("{task_id}.start"));
        atomic_write_bytes(&gate_path, b"start\n")?;
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while gate_path.exists() && std::time::Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        if gate_path.exists() {
            return Err(ToolError::retryable(
                "tmux.taskStartUnconfirmed",
                "task runner did not consume its start gate",
            ));
        }
        thread::sleep(Duration::from_millis(20));
        Ok(())
    }

    pub fn finish_task_capture(&self, task_id: &str) -> Result<(), ToolError> {
        self.wait_task_capture(task_id)
    }

    pub fn transcript_path(&self, task_id: &str) -> PathBuf {
        self.transcripts_dir.join(format!("{task_id}.log"))
    }

    pub fn persist_task_record<T: Serialize>(
        &self,
        task_id: &str,
        record: &T,
    ) -> Result<(), ToolError> {
        atomic_write_json(
            &self.transcripts_dir.join(format!("{task_id}.json")),
            record,
        )
    }

    pub fn load_task_records<T: DeserializeOwned>(&self) -> Result<Vec<T>, ToolError> {
        let mut paths = fs::read_dir(&self.transcripts_dir)
            .map_err(storage_error)?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "json")
            })
            .collect::<Vec<_>>();
        paths.sort();
        paths
            .into_iter()
            .map(|path| {
                let bytes = fs::read(path).map_err(storage_error)?;
                serde_json::from_slice(&bytes)
                    .map_err(|error| ToolError::new("tmux.storageFailed", error.to_string()))
            })
            .collect()
    }

    fn transcript_done_path(&self, task_id: &str) -> PathBuf {
        self.transcripts_dir.join(format!("{task_id}.done"))
    }

    fn wait_task_capture(&self, task_id: &str) -> Result<(), ToolError> {
        let done_path = self.transcript_done_path(task_id);
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while !done_path.exists() {
            if std::time::Instant::now() >= deadline {
                return Err(ToolError::retryable(
                    "tmux.transcriptFinalizeFailed",
                    "task transcript logger did not confirm completion",
                ));
            }
            thread::sleep(Duration::from_millis(5));
        }
        let _ = fs::remove_file(&done_path);
        Ok(())
    }

    pub fn remove_task_runtime(&self, task_id: &str) {
        let _ = fs::remove_file(self.tasks_dir.join(format!("{task_id}.sh")));
        let _ = fs::remove_file(self.tasks_dir.join(format!("{task_id}.start")));
        let _ = fs::remove_file(self.transcript_done_path(task_id));
    }

    pub fn remove_pane_metadata(&self, pane_id: &str) {
        let _ = self.remove_pane_record(pane_id);
        let _ = fs::remove_file(self.status_path(pane_id));
    }

    pub fn close_pane(&self, pane: &BackendPane) -> Result<(), ToolError> {
        self.run(&["kill-pane".into(), "-t".into(), pane.tmux_pane_id.clone()])?;
        self.remove_pane_record(&pane.id)?;
        let _ = fs::remove_file(self.status_path(&pane.id));
        Ok(())
    }

    pub fn resolve<'a>(
        &self,
        workspace: &'a BackendWorkspace,
        selector: Option<&str>,
    ) -> Result<&'a BackendPane, ToolError> {
        if let Some(selector) = selector {
            return workspace
                .panes
                .iter()
                .find(|pane| pane.id == selector)
                .or_else(|| workspace.panes.iter().find(|pane| pane.name == selector))
                .ok_or_else(|| {
                    ToolError::new(
                        "tmux.paneNotFound",
                        format!("managed pane not found: {selector}"),
                    )
                });
        }
        if workspace.panes.len() == 1 {
            return Ok(&workspace.panes[0]);
        }
        Err(ToolError::new(
            "tmux.paneRequired",
            "pane is required when multiple managed panes exist",
        ))
    }

    fn validate_existing_session(&self) -> Result<(), ToolError> {
        let instance = self
            .run(&[
                "show-options".into(),
                "-qv".into(),
                "-t".into(),
                TMUX_SESSION.into(),
                "@devshell_worker_instance".into(),
            ])?
            .trim()
            .to_string();
        if instance != self.instance {
            return Err(ToolError::new(
                "tmux.runtimeConflict",
                format!(
                    "existing tmux session is not owned by instance {}",
                    self.instance
                ),
            ));
        }
        Ok(())
    }

    fn configure_terminal_size(&self) -> Result<(), ToolError> {
        self.run(&[
            "set-option".into(),
            "-g".into(),
            "-t".into(),
            TMUX_SESSION.into(),
            "history-limit".into(),
            TERMINAL_HISTORY_LINES.to_string(),
        ])?;
        self.run(&[
            "set-option".into(),
            "-g".into(),
            "-t".into(),
            TMUX_SESSION.into(),
            "default-size".into(),
            format!("{TERMINAL_COLUMNS}x{TERMINAL_ROWS}"),
        ])?;
        let windows = self.run(&[
            "list-windows".into(),
            "-t".into(),
            TMUX_SESSION.into(),
            "-F".into(),
            "#{window_id}".into(),
        ])?;
        for window_id in windows.lines().filter(|line| !line.is_empty()) {
            self.run(&[
                "resize-window".into(),
                "-t".into(),
                window_id.into(),
                "-x".into(),
                TERMINAL_COLUMNS.to_string(),
                "-y".into(),
                TERMINAL_ROWS.to_string(),
            ])?;
        }
        Ok(())
    }

    fn normalize_managed_windows(&self) -> Result<(), ToolError> {
        let workspace = self.capture_workspace()?;
        let mut by_window = HashMap::<String, Vec<&BackendPane>>::new();
        for pane in &workspace.panes {
            by_window
                .entry(pane.tmux_window_id.clone())
                .or_default()
                .push(pane);
        }

        for panes in by_window.values_mut() {
            if panes.is_empty() {
                continue;
            }
            let window_panes = panes[0].window_panes;
            if window_panes <= 1 {
                continue;
            }

            panes.sort_by_key(|pane| (pane.name != "main", pane.created_at_ms));
            let keep_count = usize::from(window_panes == panes.len());
            for pane in panes.iter().skip(keep_count) {
                self.run(&[
                    "break-pane".into(),
                    "-d".into(),
                    "-s".into(),
                    pane.tmux_pane_id.clone(),
                    "-t".into(),
                    format!("{TMUX_SESSION}:"),
                    "-n".into(),
                    pane.name.clone(),
                ])?;
            }
        }
        Ok(())
    }

    fn reconcile_registry(&self) -> Result<(), ToolError> {
        let workspace = self.capture_workspace()?;
        let live = workspace
            .panes
            .iter()
            .map(|pane| pane.id.as_str())
            .collect::<HashSet<_>>();
        for pane in &workspace.panes {
            self.persist_pane(&PaneRecord {
                schema_version: 1,
                pane_id: pane.id.clone(),
                pane_incarnation_id: pane.pane_incarnation_id.clone(),
                name: pane.name.clone(),
                automatic: pane.automatic,
                task_id: pane.managed_task_id.clone(),
                created_at_ms: pane.created_at_ms,
            })?;
        }
        for entry in fs::read_dir(&self.panes_dir).map_err(storage_error)? {
            let entry = entry.map_err(storage_error)?;
            let path = entry.path();
            let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            if path.extension().and_then(|extension| extension.to_str()) == Some("json")
                && !live.contains(stem)
            {
                fs::remove_file(path).map_err(storage_error)?;
            }
        }
        Ok(())
    }

    fn new_session_record(&self) -> SessionRecord {
        SessionRecord {
            schema_version: 1,
            session_id: Uuid::new_v4().to_string(),
            instance: self.instance.clone(),
            created_at_ms: unix_time_millis(),
        }
    }

    fn mark_session(&self, session: &SessionRecord) -> Result<(), ToolError> {
        for (option, value) in [
            ("@devshell_worker_managed", "1".to_string()),
            ("@devshell_worker_instance", self.instance.clone()),
            ("@devshell_worker_session_id", session.session_id.clone()),
            ("@devshell_worker_schema", "1".to_string()),
        ] {
            self.run(&[
                "set-option".into(),
                "-q".into(),
                "-t".into(),
                TMUX_SESSION.into(),
                option.into(),
                value,
            ])?;
        }
        Ok(())
    }

    fn mark_pane(&self, tmux_pane_id: &str, pane: &PaneRecord) -> Result<(), ToolError> {
        for (option, value) in [
            ("@devshell_worker_managed", "1".to_string()),
            ("@devshell_worker_pane_id", pane.pane_id.clone()),
            ("@devshell_worker_pane_name", pane.name.clone()),
            (
                "@devshell_worker_pane_incarnation_id",
                pane.pane_incarnation_id.clone(),
            ),
            (
                "@devshell_worker_created_at",
                pane.created_at_ms.to_string(),
            ),
            (
                "@devshell_worker_automatic",
                if pane.automatic { "1" } else { "0" }.to_string(),
            ),
            (
                "@devshell_worker_task_id",
                pane.task_id.clone().unwrap_or_default(),
            ),
        ] {
            self.run(&[
                "set-option".into(),
                "-p".into(),
                "-q".into(),
                "-t".into(),
                tmux_pane_id.into(),
                option.into(),
                value,
            ])?;
        }
        Ok(())
    }

    fn wait_until_ready(&self, pane_id: &str, timeout: Duration) -> Result<(), ToolError> {
        let deadline = std::time::Instant::now() + timeout;
        while std::time::Instant::now() < deadline {
            if self
                .read_status(pane_id)
                .is_some_and(|status| status.state == "idle")
            {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(25));
        }
        Err(ToolError::new(
            "tmux.paneNotReady",
            format!("pane {pane_id} did not report shell readiness"),
        ))
    }

    fn discard_initial_prompt_output(
        &self,
        pane_id: &str,
        timeout: Duration,
    ) -> Result<(), ToolError> {
        const QUIET_PERIOD: Duration = Duration::from_millis(100);
        const POLL_INTERVAL: Duration = Duration::from_millis(25);

        let deadline = std::time::Instant::now() + timeout;
        let mut previous_lines: Option<Vec<String>> = None;
        let mut unchanged_since = std::time::Instant::now();

        loop {
            let workspace = self.capture_workspace()?;
            let pane = workspace
                .panes
                .iter()
                .find(|pane| pane.id == pane_id)
                .ok_or_else(|| ToolError::new("tmux.paneNotFound", "created pane disappeared"))?;
            let shell_idle = matches!(pane.command.as_str(), "bash" | "zsh" | "fish");

            if previous_lines.as_ref() == Some(&pane.lines) && shell_idle {
                if unchanged_since.elapsed() >= QUIET_PERIOD {
                    return Ok(());
                }
            } else {
                previous_lines = Some(pane.lines.clone());
                unchanged_since = std::time::Instant::now();
            }

            if std::time::Instant::now() >= deadline {
                return Ok(());
            }
            thread::sleep(POLL_INTERVAL);
        }
    }

    fn read_status(&self, pane_id: &str) -> Option<PaneStatusRecord> {
        let raw = fs::read_to_string(self.status_path(pane_id)).ok()?;
        serde_json::from_str(&raw).ok()
    }

    fn status_path(&self, pane_id: &str) -> PathBuf {
        self.status_dir.join(format!("{}.json", escape_id(pane_id)))
    }

    fn persist_pane(&self, pane: &PaneRecord) -> Result<(), ToolError> {
        atomic_write_json(&self.panes_dir.join(format!("{}.json", pane.pane_id)), pane)
    }

    fn remove_pane_record(&self, pane_id: &str) -> Result<(), ToolError> {
        match fs::remove_file(self.panes_dir.join(format!("{pane_id}.json"))) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(storage_error(error)),
        }
    }

    fn clear_stale_pane_records(&self) -> Result<(), ToolError> {
        for entry in fs::read_dir(&self.panes_dir).map_err(storage_error)? {
            let entry = entry.map_err(storage_error)?;
            if entry.file_type().map_err(storage_error)?.is_file() {
                fs::remove_file(entry.path()).map_err(storage_error)?;
            }
        }
        for entry in fs::read_dir(&self.status_dir).map_err(storage_error)? {
            let entry = entry.map_err(storage_error)?;
            if entry.file_type().map_err(storage_error)?.is_file() {
                fs::remove_file(entry.path()).map_err(storage_error)?;
            }
        }
        Ok(())
    }

    fn run(&self, args: &[String]) -> Result<String, ToolError> {
        let output = Command::new("tmux")
            .arg("-S")
            .arg(&self.socket)
            .args(args)
            .output()
            .map_err(|error| ToolError::new("tmux.unavailable", error.to_string()))?;
        if !output.status.success() {
            return Err(ToolError::new(
                "tmux.commandFailed",
                format!(
                    "tmux {:?} failed: {}",
                    args,
                    String::from_utf8_lossy(&output.stderr).trim()
                ),
            ));
        }
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }
}

impl PaneRecord {
    fn new(name: &str, automatic: bool, task_id: Option<String>) -> Result<Self, ToolError> {
        validate_pane_name(name)?;
        Ok(Self {
            schema_version: 1,
            pane_id: new_pane_id(),
            pane_incarnation_id: Uuid::new_v4().to_string(),
            name: name.to_string(),
            automatic,
            task_id,
            created_at_ms: unix_time_millis(),
        })
    }
}

pub fn validate_pane_name(name: &str) -> Result<(), ToolError> {
    let bytes = name.as_bytes();
    if bytes.is_empty()
        || bytes.len() > 64
        || !bytes[0].is_ascii_alphanumeric()
        || bytes
            .iter()
            .skip(1)
            .any(|byte| !byte.is_ascii_alphanumeric() && !matches!(*byte, b'.' | b'_' | b'-'))
    {
        return Err(ToolError::new(
            "tmux.invalidPaneName",
            "name must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}",
        ));
    }
    Ok(())
}

fn session_exists(socket: &Path) -> bool {
    socket.exists()
        && Command::new("tmux")
            .arg("-S")
            .arg(socket)
            .args(["has-session", "-t", TMUX_SESSION])
            .output()
            .is_ok_and(|output| output.status.success())
}

fn workspace_key(instance_root: &Path, workspace: &Path) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(instance_root.as_os_str().as_bytes());
    hasher.update(&[0]);
    hasher.update(workspace.as_os_str().as_bytes());
    hasher.finalize().to_hex()[..16].to_string()
}

fn workspace_socket(
    socket_paths: &SocketPaths,
    instance_root: &Path,
    workspace: &Path,
    workspace_key: &str,
) -> PathBuf {
    const MAX_UNIX_SOCKET_PATH_BYTES: usize = 100;
    let candidate = socket_paths
        .instance_runtime_dir
        .join(format!("tmux-{workspace_key}.sock"));
    if candidate.as_os_str().as_bytes().len() <= MAX_UNIX_SOCKET_PATH_BYTES {
        return candidate;
    }
    let mut hasher = blake3::Hasher::new();
    hasher.update(instance_root.as_os_str().as_bytes());
    hasher.update(&[0]);
    hasher.update(workspace.as_os_str().as_bytes());
    let hash = hasher.finalize().to_hex();
    PathBuf::from("/tmp").join(format!("devshell-tmux-{}.sock", &hash[..16]))
}

fn workspace_storage(
    instance_paths: &InstancePaths,
    socket_paths: &SocketPaths,
    workspace: &Path,
    workspace_key: &str,
) -> Result<(PathBuf, PathBuf), ToolError> {
    let tmux_root = instance_paths.instance_root.join("tmux");
    let scoped_root = tmux_root.join("workspaces").join(workspace_key);
    let scoped_socket = workspace_socket(
        socket_paths,
        &instance_paths.instance_root,
        workspace,
        workspace_key,
    );
    let legacy_marker = tmux_root.join("legacy-workspace.json");
    if let Some(claimed_key) = read_legacy_workspace_key(&legacy_marker)? {
        return if claimed_key == workspace_key {
            Ok((tmux_root, socket_paths.tmux_socket_file.clone()))
        } else {
            Ok((scoped_root, scoped_socket))
        };
    }
    if session_exists(&socket_paths.tmux_socket_file)
        && legacy_session_is_within(&socket_paths.tmux_socket_file, workspace)?
    {
        atomic_write_json(&legacy_marker, &workspace_key.to_string())?;
        return Ok((tmux_root, socket_paths.tmux_socket_file.clone()));
    }
    Ok((scoped_root, scoped_socket))
}

fn read_legacy_workspace_key(path: &Path) -> Result<Option<String>, ToolError> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(ToolError::new("tmux.storageFailed", error.to_string())),
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| ToolError::new("tmux.storageFailed", error.to_string()))
}

fn legacy_session_is_within(socket: &Path, workspace: &Path) -> Result<bool, ToolError> {
    let output = Command::new("tmux")
        .arg("-S")
        .arg(socket)
        .args([
            "list-panes",
            "-s",
            "-t",
            TMUX_SESSION,
            "-F",
            "#{q:pane_current_path}",
        ])
        .output()
        .map_err(|error| ToolError::new("tmux.inspectFailed", error.to_string()))?;
    if !output.status.success() {
        return Ok(false);
    }
    let raw = String::from_utf8(output.stdout)
        .map_err(|error| ToolError::new("tmux.inspectFailed", error.to_string()))?;
    let mut saw_pane = false;
    for line in raw.lines().filter(|line| !line.trim().is_empty()) {
        saw_pane = true;
        let decoded = decode_tmux_argument(line)?;
        let canonical = PathBuf::from(decoded).canonicalize().map_err(|error| {
            ToolError::new(
                "tmux.inspectFailed",
                format!("failed to resolve legacy pane cwd: {error}"),
            )
        })?;
        if !canonical.starts_with(workspace) {
            return Ok(false);
        }
    }
    Ok(saw_pane)
}

fn status_text(record: &PaneStatusRecord) -> String {
    match record.state.as_str() {
        "idle" => "idle".to_string(),
        "running" => "running".to_string(),
        "exit" => record.exit_code.to_string(),
        _ => "unknown".to_string(),
    }
}

fn split_tmux_fields(line: &str) -> Vec<&str> {
    let bytes = line.as_bytes();
    let mut fields = Vec::new();
    let mut field_start = 0;
    for (index, byte) in bytes.iter().enumerate() {
        if *byte != b'|' {
            continue;
        }
        let preceding_backslashes = bytes[field_start..index]
            .iter()
            .rev()
            .take_while(|byte| **byte == b'\\')
            .count();
        if preceding_backslashes % 2 == 0 {
            fields.push(&line[field_start..index]);
            field_start = index + 1;
        }
    }
    fields.push(&line[field_start..]);
    fields
}

fn decode_tmux_argument(value: &str) -> Result<String, ToolError> {
    let mut chars = value.chars().peekable();
    let mut decoded = String::new();
    while let Some(character) = chars.next() {
        if character != '\\' {
            decoded.push(character);
            continue;
        }
        let Some(escaped) = chars.next() else {
            return Err(ToolError::new(
                "tmux.invalidFormat",
                "tmux returned a dangling argument escape",
            ));
        };
        match escaped {
            'n' => decoded.push('\n'),
            'r' => decoded.push('\r'),
            't' => decoded.push('\t'),
            'e' => decoded.push('\u{001b}'),
            '0'..='7' => {
                let mut octal = String::from(escaped);
                while octal.len() < 3 && chars.peek().is_some_and(|next| matches!(next, '0'..='7'))
                {
                    octal.push(chars.next().unwrap());
                }
                let byte = u8::from_str_radix(&octal, 8)
                    .map_err(|error| ToolError::new("tmux.invalidFormat", error.to_string()))?;
                decoded.push(char::from(byte));
            }
            other => decoded.push(other),
        }
    }
    Ok(decoded)
}

fn escape_id(value: &str) -> String {
    value
        .chars()
        .map(|character| match character {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '_' | '.' | '-' => character,
            _ => '_',
        })
        .collect()
}

fn new_pane_id() -> String {
    let uuid = Uuid::new_v4().simple().to_string();
    format!("pane-{}", &uuid[..26])
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn atomic_write_bytes(path: &Path, bytes: &[u8]) -> Result<(), ToolError> {
    let parent = path
        .parent()
        .ok_or_else(|| ToolError::new("tmux.storageFailed", "tmux state path has no parent"))?;
    ensure_dir(parent, 0o700).map_err(|error| ToolError::new("tmux.storageFailed", error))?;
    let temporary = path.with_extension(format!("tmp.{}", std::process::id()));
    let mut file = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(storage_error)?;
    file.write_all(bytes).map_err(storage_error)?;
    file.sync_all().map_err(storage_error)?;
    fs::rename(&temporary, path).map_err(storage_error)?;
    Ok(())
}

fn atomic_write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), ToolError> {
    let parent = path
        .parent()
        .ok_or_else(|| ToolError::new("tmux.storageFailed", "tmux state path has no parent"))?;
    ensure_dir(parent, 0o700).map_err(|error| ToolError::new("tmux.storageFailed", error))?;
    let temporary = path.with_extension(format!("json.tmp.{}", std::process::id()));
    let mut bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| ToolError::new("tmux.storageFailed", error.to_string()))?;
    bytes.push(b'\n');
    let mut file = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(storage_error)?;
    file.write_all(&bytes).map_err(storage_error)?;
    file.sync_all().map_err(storage_error)?;
    fs::rename(&temporary, path).map_err(storage_error)?;
    Ok(())
}

fn storage_error(error: std::io::Error) -> ToolError {
    ToolError::new("tmux.storageFailed", error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{decode_tmux_argument, split_tmux_fields};

    #[test]
    fn parses_tmux_34_quoted_fields_without_splitting_escaped_pipes() {
        let fields = split_tmux_fields(r"%0|pane-id|/tmp/a\ b\|c\\037d|sleep");
        assert_eq!(fields, [r"%0", "pane-id", r"/tmp/a\ b\|c\\037d", "sleep"]);
        assert_eq!(decode_tmux_argument(fields[2]).unwrap(), r"/tmp/a b|c\037d");
    }

    #[test]
    fn treats_pipe_after_even_backslashes_as_a_field_separator() {
        let fields = split_tmux_fields(r"%0|/tmp/trailing\\|sleep");
        assert_eq!(fields, [r"%0", r"/tmp/trailing\\", "sleep"]);
        assert_eq!(decode_tmux_argument(fields[1]).unwrap(), "/tmp/trailing\\");
    }
}
