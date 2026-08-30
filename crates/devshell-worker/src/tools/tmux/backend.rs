use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
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
use crate::tools::tmux::output::TRANSCRIPT_LOGGER_MODE;
use crate::tools::tmux::shell::prepare_shell_launch;
use crate::tools::tmux::transcript_ring;

pub const TMUX_SESSION: &str = "devshell";
pub const MAX_PANES: usize = 16;
const TMUX_RUNTIME_SCHEMA: &str = "3";
const PANE_HISTORY_LINES: i64 = 400;
const TERMINAL_HISTORY_LINES: usize = 10_000;
const TERMINAL_COLUMNS: usize = 240;
const TERMINAL_ROWS: usize = 60;

#[derive(Debug, Clone)]
pub struct BackendPane {
    pub id: String,
    pub name: String,
    pub tmux_pane_id: String,
    pub columns: usize,
    pub rows: usize,
    pub pane_incarnation_id: String,
    pub created_at_ms: u128,
    pub cwd: String,
    pub command: String,
    pub status: Option<String>,
    pub managed_task_id: Option<String>,
    pub transcript_capture_active: bool,
}

#[derive(Debug, Clone)]
pub struct BackendWorkspace {
    pub panes: Vec<BackendPane>,
    pub total_panes: usize,
    pub foreign_panes: usize,
}

#[derive(Debug, Clone)]
struct PaneRecord {
    pane_id: String,
    pane_incarnation_id: String,
    name: String,
    task_id: Option<String>,
    created_at_ms: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PaneStatusRecord {
    state: String,
}

pub struct TmuxBackend {
    instance: String,
    workspace: PathBuf,
    socket: PathBuf,
    shell_dir: PathBuf,
    status_dir: PathBuf,
    tasks_dir: PathBuf,
    transcripts_dir: PathBuf,
    session_lock: Mutex<()>,
    session_prepared: AtomicBool,
    runtime_migrated: AtomicBool,
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
        let shell_dir = root.join("shell");
        let status_dir = root.join("status");
        let tasks_dir = root.join("tasks");
        let transcripts_dir = root.join("transcripts");
        for path in [&root, &shell_dir, &status_dir, &tasks_dir, &transcripts_dir] {
            ensure_dir(path, 0o700).map_err(|error| ToolError::new("tmux.storageFailed", error))?;
        }
        Ok(Self {
            instance: runtime.instance.as_str().to_string(),
            workspace: workspace.to_path_buf(),
            socket,
            shell_dir,
            status_dir,
            tasks_dir,
            transcripts_dir,
            session_lock: Mutex::new(()),
            session_prepared: AtomicBool::new(false),
            runtime_migrated: AtomicBool::new(false),
        })
    }

    pub fn has_session(&self) -> bool {
        session_exists(&self.socket)
    }

    pub fn take_runtime_migrated(&self) -> bool {
        self.runtime_migrated.swap(false, Ordering::AcqRel)
    }

    pub fn ensure_session(&self) -> Result<(), ToolError> {
        if self.session_prepared.load(Ordering::Acquire) && session_exists(&self.socket) {
            return Ok(());
        }
        let _session_guard = self.session_lock.lock().map_err(|_| {
            ToolError::new(
                "tmux.internalError",
                "tmux session initialization lock poisoned",
            )
        })?;
        if session_exists(&self.socket) {
            if !self.session_prepared.load(Ordering::Acquire) {
                if self.validate_existing_session()? {
                    self.configure_terminal_size()?;
                    self.session_prepared.store(true, Ordering::Release);
                    return Ok(());
                }
                self.run(&["kill-session".into(), "-t".into(), TMUX_SESSION.into()])?;
                self.clear_unpersisted_task_runtime()?;
                self.runtime_migrated.store(true, Ordering::Release);
            } else {
                return Ok(());
            }
        }

        self.session_prepared.store(false, Ordering::Release);
        self.clear_stale_status_records()?;
        let session_id = Uuid::new_v4().to_string();
        let pane = PaneRecord::new("main", None)?;
        atomic_write_json(
            &self.status_path(&pane.pane_id),
            &PaneStatusRecord {
                state: "running".to_string(),
            },
        )?;
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
        let setup = (|| {
            self.configure_terminal_size()?;
            self.mark_session(&session_id)?;
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
            Ok::<(), ToolError>(())
        })();
        if let Err(error) = setup {
            let _ = self.run(&["kill-session".into(), "-t".into(), TMUX_SESSION.into()]);
            return Err(error);
        }
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
            "#{pane_width}",
            "#{pane_height}",
            "#{q:pane_current_path}",
            "#{q:pane_current_command}",
            "#{pane_dead}",
            "#{pane_dead_status}",
            "#{@devshell_worker_task_id}",
            "#{pane_dead_signal}",
            "#{pane_pipe}",
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
            let managed_task_id = fields
                .get(11)
                .copied()
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned);
            let shell_status = self.read_status(id);
            let task_status = managed_task_id.as_ref().map(|task_id| {
                if fields.get(9).copied() == Some("1") {
                    if let Some(status) =
                        self.wait_task_exit_status(task_id, Duration::from_millis(250))
                    {
                        status.to_string()
                    } else if let Some(status) =
                        fields.get(10).copied().filter(|value| !value.is_empty())
                    {
                        status.to_string()
                    } else if let Some(signal) =
                        fields.get(12).and_then(|value| value.parse::<i32>().ok())
                    {
                        (128 + signal).to_string()
                    } else {
                        "unknown".to_string()
                    }
                } else {
                    "running".to_string()
                }
            });
            let cwd = decode_tmux_argument(fields.get(7).copied().unwrap_or_default())?;
            let command = decode_tmux_argument(fields.get(8).copied().unwrap_or_default())?;
            let interactive_running =
                managed_task_id.is_none() && !matches!(command.as_str(), "bash" | "zsh" | "fish");
            panes.push(BackendPane {
                id: id.to_string(),
                name: name.to_string(),
                tmux_pane_id: tmux_pane_id.to_string(),
                columns: fields
                    .get(5)
                    .and_then(|value| value.parse::<usize>().ok())
                    .unwrap_or_default(),
                rows: fields
                    .get(6)
                    .and_then(|value| value.parse::<usize>().ok())
                    .unwrap_or_default(),
                pane_incarnation_id: pane_incarnation_id.to_string(),
                created_at_ms,
                cwd,
                command,
                status: task_status.or_else(|| {
                    interactive_running
                        .then(|| "running".to_string())
                        .or_else(|| shell_status.as_ref().map(status_text))
                }),
                managed_task_id,
                transcript_capture_active: fields.get(13).copied() == Some("1"),
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
        let mut selected = sanitized.lines().map(ToOwned::to_owned).collect::<Vec<_>>();
        while selected.last().is_some_and(String::is_empty) {
            selected.pop();
        }
        let logical_start = selected.len().saturating_sub(start.unsigned_abs() as usize);
        let logical_end = selected.len().saturating_sub(end.unsigned_abs() as usize);
        selected = selected[logical_start.min(logical_end)..logical_end].to_vec();
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

    pub fn create_pane(&self, name: &str, cwd: &Path) -> Result<BackendPane, ToolError> {
        let pane = PaneRecord::new(name, None)?;
        atomic_write_json(
            &self.status_path(&pane.pane_id),
            &PaneStatusRecord {
                state: "running".to_string(),
            },
        )?;
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
        if let Err(error) = self.wait_until_ready(&pane.pane_id, Duration::from_secs(5)) {
            let _ = self.run(&["kill-pane".into(), "-t".into(), tmux_pane_id.clone()]);
            return Err(error);
        }
        if let Err(error) =
            self.discard_initial_prompt_output(&pane.pane_id, Duration::from_secs(3))
        {
            let _ = self.run(&["kill-pane".into(), "-t".into(), tmux_pane_id.clone()]);
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
        let pane = PaneRecord::new(task_id, Some(task_id.to_string()))?;
        let script_path = self.tasks_dir.join(format!("{task_id}.sh"));
        let gate_path = self.tasks_dir.join(format!("{task_id}.start"));
        let exit_path = self.task_exit_path(task_id);
        let transcript_buffer_name = self.transcript_buffer_name(task_id);
        let transcript_done_path = self.transcript_done_path(task_id);
        let _ = fs::remove_file(&gate_path);
        let _ = fs::remove_file(&exit_path);
        let _ = transcript_ring::remove(&transcript_buffer_name);
        let _ = fs::remove_file(&transcript_done_path);
        self.persist_transcript_ring_name(task_id)?;
        atomic_write_bytes(&script_path, command.as_bytes())?;
        let runner = format!(
            "umask 077; while [ ! -e {} ]; do /bin/sleep 0.02; done; /bin/rm -f {}; /bin/bash --noprofile --norc {}; status=$?; printf '%s\\n' \"$status\" > {}; exit \"$status\"",
            shell_quote(&gate_path.to_string_lossy()),
            shell_quote(&gate_path.to_string_lossy()),
            shell_quote(&script_path.to_string_lossy()),
            shell_quote(&exit_path.to_string_lossy()),
        );
        let launch = format!(
            "exec /usr/bin/env -u BASH_ENV -u TMUX -u TMUX_PANE -u TMUX_TMPDIR /bin/bash --noprofile --norc -c {}",
            shell_quote(&runner)
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
                    "exec {} {} {} {} 2>/dev/null",
                    shell_quote(
                        &std::env::current_exe()
                            .map_err(|error| {
                                ToolError::new("tmux.createFailed", error.to_string())
                            })?
                            .to_string_lossy()
                    ),
                    TRANSCRIPT_LOGGER_MODE,
                    shell_quote(&transcript_buffer_name),
                    shell_quote(&transcript_done_path.to_string_lossy()),
                ),
            ])?;
            Ok::<(), ToolError>(())
        })();
        if let Err(error) = setup {
            let _ = self.run(&["kill-pane".into(), "-t".into(), tmux_pane_id.clone()]);
            self.remove_task_runtime(task_id);
            let _ = transcript_ring::remove(&transcript_buffer_name);
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

    pub fn task_record_path(&self, task_id: &str) -> PathBuf {
        self.transcripts_dir.join(format!("{task_id}.json"))
    }

    pub fn transcript_buffer_name(&self, task_id: &str) -> String {
        let identity = format!("{}:{}:{task_id}", self.instance, self.workspace.display());
        let digest = blake3::hash(identity.as_bytes()).to_hex();
        format!("/devshell-tmux-{}", &digest[..32])
    }

    pub fn persist_transcript_ring_name(&self, task_id: &str) -> Result<(), ToolError> {
        atomic_write_bytes(
            &self.transcripts_dir.join(format!("{task_id}.ring")),
            self.transcript_buffer_name(task_id).as_bytes(),
        )
    }

    pub fn persist_task_record<T: Serialize>(
        &self,
        task_id: &str,
        record: &T,
    ) -> Result<(), ToolError> {
        atomic_write_json(&self.task_record_path(task_id), record)
    }

    pub fn persist_task_offset(&self, task_id: &str, offset: u64) -> Result<(), ToolError> {
        atomic_write_json(
            &self.transcripts_dir.join(format!("{task_id}.offset")),
            &offset,
        )
    }

    pub fn load_task_offset(&self, task_id: &str) -> Result<u64, ToolError> {
        let path = self.transcripts_dir.join(format!("{task_id}.offset"));
        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(error) => return Err(storage_error(error)),
        };
        serde_json::from_slice(&bytes)
            .map_err(|error| ToolError::new("tmux.storageFailed", error.to_string()))
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

    fn task_exit_path(&self, task_id: &str) -> PathBuf {
        self.tasks_dir.join(format!("{task_id}.exit"))
    }

    fn read_task_exit_status(&self, task_id: &str) -> Option<i32> {
        fs::read_to_string(self.task_exit_path(task_id))
            .ok()?
            .trim()
            .parse()
            .ok()
    }

    fn wait_task_exit_status(&self, task_id: &str, timeout: Duration) -> Option<i32> {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            if let Some(status) = self.read_task_exit_status(task_id) {
                return Some(status);
            }
            if std::time::Instant::now() >= deadline {
                return None;
            }
            thread::sleep(Duration::from_millis(5));
        }
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
        let _ = fs::remove_file(self.task_exit_path(task_id));
        let _ = fs::remove_file(self.transcript_done_path(task_id));
        let _ = fs::remove_file(self.transcripts_dir.join(format!("{task_id}.ring")));
    }

    pub fn task_runtime_pending(&self, task_id: &str) -> bool {
        self.tasks_dir.join(format!("{task_id}.sh")).exists()
            || self.tasks_dir.join(format!("{task_id}.start")).exists()
            || self.task_exit_path(task_id).exists()
            || self.transcript_done_path(task_id).exists()
    }

    pub fn remove_pane_metadata(&self, pane_id: &str) {
        let _ = fs::remove_file(self.status_path(pane_id));
    }

    pub fn close_pane(&self, pane: &BackendPane) -> Result<(), ToolError> {
        self.run(&["kill-pane".into(), "-t".into(), pane.tmux_pane_id.clone()])?;
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

    fn validate_existing_session(&self) -> Result<bool, ToolError> {
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
        let schema = self
            .run(&[
                "show-options".into(),
                "-qv".into(),
                "-t".into(),
                TMUX_SESSION.into(),
                "@devshell_worker_schema".into(),
            ])?
            .trim()
            .to_string();
        Ok(schema == TMUX_RUNTIME_SCHEMA)
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

    fn mark_session(&self, session_id: &str) -> Result<(), ToolError> {
        for (option, value) in [
            ("@devshell_worker_managed", "1".to_string()),
            ("@devshell_worker_instance", self.instance.clone()),
            ("@devshell_worker_session_id", session_id.to_string()),
            ("@devshell_worker_schema", TMUX_RUNTIME_SCHEMA.to_string()),
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
            let lines = self.capture_lines(&pane.tmux_pane_id, -PANE_HISTORY_LINES, 0)?;

            if previous_lines.as_ref() == Some(&lines) && shell_idle {
                if unchanged_since.elapsed() >= QUIET_PERIOD {
                    return Ok(());
                }
            } else {
                previous_lines = Some(lines);
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

    fn clear_stale_status_records(&self) -> Result<(), ToolError> {
        for entry in fs::read_dir(&self.status_dir).map_err(storage_error)? {
            let entry = entry.map_err(storage_error)?;
            if entry.file_type().map_err(storage_error)?.is_file() {
                fs::remove_file(entry.path()).map_err(storage_error)?;
            }
        }
        Ok(())
    }

    fn clear_unpersisted_task_runtime(&self) -> Result<(), ToolError> {
        let persisted = fs::read_dir(&self.transcripts_dir)
            .map_err(storage_error)?
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let path = entry.path();
                if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
                    return None;
                }
                path.file_stem()
                    .and_then(|stem| stem.to_str())
                    .map(ToOwned::to_owned)
            })
            .collect::<HashSet<_>>();
        let mut discarded = HashSet::new();

        for entry in fs::read_dir(&self.tasks_dir).map_err(storage_error)? {
            let entry = entry.map_err(storage_error)?;
            if !entry.file_type().map_err(storage_error)?.is_file() {
                continue;
            }
            let path = entry.path();
            if let Some(task_id) = path.file_stem().and_then(|stem| stem.to_str())
                && !persisted.contains(task_id)
            {
                discarded.insert(task_id.to_string());
            }
            fs::remove_file(path).map_err(storage_error)?;
        }

        for entry in fs::read_dir(&self.transcripts_dir).map_err(storage_error)? {
            let entry = entry.map_err(storage_error)?;
            let path = entry.path();
            let Some(extension) = path.extension().and_then(|extension| extension.to_str()) else {
                continue;
            };
            if !matches!(extension, "log" | "offset" | "done" | "ring") {
                continue;
            }
            let Some(task_id) = path.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            if !persisted.contains(task_id) {
                discarded.insert(task_id.to_string());
                fs::remove_file(path).map_err(storage_error)?;
            }
        }

        for task_id in discarded {
            transcript_ring::remove(&self.transcript_buffer_name(&task_id))
                .map_err(storage_error)?;
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
    fn new(name: &str, task_id: Option<String>) -> Result<Self, ToolError> {
        validate_pane_name(name)?;
        Ok(Self {
            pane_id: new_pane_id(),
            pane_incarnation_id: Uuid::new_v4().to_string(),
            name: name.to_string(),
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
        "idle" | "exit" => "idle".to_string(),
        "running" => "running".to_string(),
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
    let temporary = path.with_extension(format!(
        "tmp.{}.{}",
        std::process::id(),
        Uuid::new_v4().simple()
    ));
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
    let temporary = path.with_extension(format!(
        "json.tmp.{}.{}",
        std::process::id(),
        Uuid::new_v4().simple()
    ));
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
