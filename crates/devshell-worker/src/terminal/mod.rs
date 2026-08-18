#[cfg(unix)]
mod pty_unix;
#[cfg(windows)]
mod pty_windows;

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::rpc::codec::encode_json;
use crate::rpc::error::RpcError;
use crate::security::SecurityPolicy;
use crate::security::path::{
    FilesystemCapability, PathNamespace, ResolvedPath, parse_requested_path,
    resolve_existing_target,
};
#[cfg(test)]
use crate::security::{SecurityMode, build_security_policy};

const DEFAULT_MAX_REPLAY_BYTES: usize = 4 * 1024 * 1024;
const DEFAULT_MAX_NOTIFICATION_BYTES: usize = 4 * 1024 * 1024;
const DEFAULT_MAX_SESSIONS: usize = 16;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOpenInput {
    pub cols: u16,
    pub rows: u16,
    pub cwd: Option<String>,
    pub command: Option<String>,
    pub workspace: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAttachInput {
    pub terminal_id: String,
    pub generation: u64,
    pub from_seq: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCommandInput {
    pub terminal_id: String,
    pub generation: u64,
    pub version: u64,
    pub client_seq: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalWriteInput {
    #[serde(flatten)]
    pub identity: TerminalCommandInput,
    pub data: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalResizeInput {
    #[serde(flatten)]
    pub identity: TerminalCommandInput,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalDescriptor {
    pub terminal_id: String,
    pub generation: u64,
    pub version: u64,
    pub cols: u16,
    pub rows: u16,
    pub latest_seq: u64,
    pub state: &'static str,
    pub created_at_ms: u128,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputFrame {
    pub seq: u64,
    pub data_base64: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExit {
    pub exit_code: i32,
    pub signal: i32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAttachResult {
    pub session: TerminalDescriptor,
    pub replay: Vec<TerminalOutputFrame>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit: Option<TerminalExit>,
}

#[derive(Clone)]
pub struct TerminalManager {
    inner: Arc<TerminalManagerInner>,
}

struct TerminalManagerInner {
    generation: AtomicU64,
    max_replay_bytes: usize,
    max_sessions: usize,
    notifications: NotificationQueue,
    policy: Arc<dyn SecurityPolicy>,
    sessions: Mutex<HashMap<String, Arc<TerminalSession>>>,
}

struct TerminalSession {
    child: Box<dyn TerminalChild + Send + Sync>,
    state: Mutex<TerminalSessionState>,
    writer: Mutex<Box<dyn Write + Send>>,
}

struct TerminalSessionState {
    cols: u16,
    created_at_ms: u128,
    exit: Option<TerminalExit>,
    generation: u64,
    latest_seq: u64,
    replay: VecDeque<ReplayFrame>,
    replay_bytes: usize,
    rows: u16,
    terminal_id: String,
    version: u64,
}

struct ReplayFrame {
    bytes: Vec<u8>,
    seq: u64,
}

pub(crate) trait TerminalChild {
    fn kill(&self) -> Result<(), String>;
    fn resize(&self, cols: u16, rows: u16) -> Result<(), String>;
    fn wait(&self) -> Result<(i32, i32), String>;
}

pub(crate) struct SpawnedTerminal {
    pub child: Box<dyn TerminalChild + Send + Sync>,
    pub reader: Box<dyn std::io::Read + Send>,
    pub writer: Box<dyn Write + Send>,
}

impl TerminalManager {
    pub fn with_policy(policy: Arc<dyn SecurityPolicy>) -> Self {
        Self::with_policy_limits(
            policy,
            DEFAULT_MAX_REPLAY_BYTES,
            DEFAULT_MAX_NOTIFICATION_BYTES,
            DEFAULT_MAX_SESSIONS,
        )
    }

    #[cfg(test)]
    fn with_limits(
        max_replay_bytes: usize,
        max_notification_bytes: usize,
        max_sessions: usize,
    ) -> Self {
        Self::with_policy_limits(
            build_security_policy(SecurityMode::Disabled),
            max_replay_bytes,
            max_notification_bytes,
            max_sessions,
        )
    }

    fn with_policy_limits(
        policy: Arc<dyn SecurityPolicy>,
        max_replay_bytes: usize,
        max_notification_bytes: usize,
        max_sessions: usize,
    ) -> Self {
        Self {
            inner: Arc::new(TerminalManagerInner {
                generation: AtomicU64::new(0),
                max_replay_bytes,
                max_sessions,
                notifications: NotificationQueue::new(max_notification_bytes),
                policy,
                sessions: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub fn open(&self, input: TerminalOpenInput) -> Result<TerminalDescriptor, RpcError> {
        validate_dimensions(input.cols, input.rows)?;
        let cwd = resolve_cwd(
            Path::new(&input.workspace),
            self.inner.policy.as_ref(),
            input.cwd.as_deref(),
        )?;
        let terminal_id = format!("terminal-{}", Uuid::new_v4());
        let generation = self.inner.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let command = input.command.filter(|value| !value.is_empty());
        let (session, reader) = {
            let mut sessions = self.inner.sessions.lock().map_err(lock_error)?;
            let mut exited = Vec::new();
            let mut active_sessions = 0;
            for (id, session) in sessions.iter() {
                let state = session.state.lock().map_err(lock_error)?;
                if state.exit.is_none() {
                    active_sessions += 1;
                } else {
                    exited.push((id.clone(), state.created_at_ms));
                }
            }
            if active_sessions >= self.inner.max_sessions {
                return Err(RpcError::new(
                    "terminal.sessionLimit",
                    "Remote terminal session limit reached.",
                ));
            }
            exited.sort_by_key(|(_, created_at_ms)| *created_at_ms);
            let reclaim = sessions
                .len()
                .saturating_add(1)
                .saturating_sub(self.inner.max_sessions);
            for (id, _) in exited.into_iter().take(reclaim) {
                sessions.remove(&id);
            }

            let spawned = spawn_terminal(cwd.access_path(), input.cols, input.rows)?;
            let session = Arc::new(TerminalSession {
                child: spawned.child,
                state: Mutex::new(TerminalSessionState {
                    cols: input.cols,
                    created_at_ms: epoch_millis(),
                    exit: None,
                    generation,
                    latest_seq: 0,
                    replay: VecDeque::new(),
                    replay_bytes: 0,
                    rows: input.rows,
                    terminal_id: terminal_id.clone(),
                    version: 1,
                }),
                writer: Mutex::new(spawned.writer),
            });
            if let Some(command) = command.as_deref() {
                let write_result = {
                    let mut writer = session.writer.lock().map_err(lock_error)?;
                    writer
                        .write_all(format!("{command}\r").as_bytes())
                        .and_then(|_| writer.flush())
                };
                if let Err(error) = write_result {
                    let _ = session.child.kill();
                    return Err(RpcError::new("terminal.writeFailed", error.to_string()));
                }
            }
            sessions.insert(terminal_id.clone(), Arc::clone(&session));
            (session, spawned.reader)
        };
        self.spawn_reader(Arc::clone(&session), reader);
        self.spawn_waiter(Arc::clone(&session));
        let state = session.state.lock().map_err(lock_error)?;
        Ok(descriptor(&state))
    }

    pub fn attach(&self, input: TerminalAttachInput) -> Result<TerminalAttachResult, RpcError> {
        let session = self.require(&input.terminal_id)?;
        let state = session.state.lock().map_err(lock_error)?;
        assert_generation(&state, input.generation)?;
        let oldest = state
            .replay
            .front()
            .map(|frame| frame.seq)
            .unwrap_or(state.latest_seq + 1);
        if input.from_seq + 1 < oldest {
            return Err(RpcError::new(
                "stream.gap",
                "Requested remote terminal output is no longer available.",
            )
            .with_details(json!({
                "terminalId": state.terminal_id,
                "requestedFromSeq": input.from_seq,
                "oldestAvailableSeq": oldest,
                "latestSeq": state.latest_seq,
            })));
        }
        Ok(TerminalAttachResult {
            session: descriptor(&state),
            replay: state
                .replay
                .iter()
                .filter(|frame| frame.seq > input.from_seq)
                .map(|frame| TerminalOutputFrame {
                    seq: frame.seq,
                    data_base64: BASE64.encode(&frame.bytes),
                })
                .collect(),
            exit: state.exit.clone(),
        })
    }

    pub fn write(&self, input: TerminalWriteInput) -> Result<serde_json::Value, RpcError> {
        let session = self.require(&input.identity.terminal_id)?;
        {
            let state = session.state.lock().map_err(lock_error)?;
            assert_identity(&state, &input.identity)?;
            assert_running(&state)?;
        }
        let bytes = BASE64
            .decode(input.data.as_bytes())
            .map_err(|error| RpcError::new("rpc.invalidParams", error.to_string()))?;
        let mut writer = session.writer.lock().map_err(lock_error)?;
        writer
            .write_all(&bytes)
            .and_then(|_| writer.flush())
            .map_err(|error| RpcError::new("terminal.writeFailed", error.to_string()))?;
        Ok(json!({
            "terminalId": input.identity.terminal_id,
            "generation": input.identity.generation,
            "version": input.identity.version,
            "clientSeq": input.identity.client_seq,
            "accepted": true,
        }))
    }

    pub fn resize(&self, input: TerminalResizeInput) -> Result<serde_json::Value, RpcError> {
        validate_dimensions(input.cols, input.rows)?;
        let session = self.require(&input.identity.terminal_id)?;
        {
            let state = session.state.lock().map_err(lock_error)?;
            assert_identity(&state, &input.identity)?;
            assert_running(&state)?;
        }
        session
            .child
            .resize(input.cols, input.rows)
            .map_err(|error| RpcError::new("terminal.resizeFailed", error))?;
        let mut state = session.state.lock().map_err(lock_error)?;
        assert_identity(&state, &input.identity)?;
        state.cols = input.cols;
        state.rows = input.rows;
        state.version += 1;
        Ok(json!({
            "terminalId": state.terminal_id,
            "generation": state.generation,
            "version": state.version,
            "clientSeq": input.identity.client_seq,
            "accepted": true,
        }))
    }

    pub fn kill(&self, input: TerminalCommandInput) -> Result<TerminalDescriptor, RpcError> {
        let session = self.require(&input.terminal_id)?;
        {
            let state = session.state.lock().map_err(lock_error)?;
            assert_identity(&state, &input)?;
            assert_running(&state)?;
        }
        session
            .child
            .kill()
            .map_err(|error| RpcError::new("terminal.killFailed", error))?;
        let state = session.state.lock().map_err(lock_error)?;
        Ok(descriptor(&state))
    }

    pub fn list(&self) -> Result<Vec<TerminalDescriptor>, RpcError> {
        let sessions = self.inner.sessions.lock().map_err(lock_error)?;
        sessions
            .values()
            .map(|session| {
                session
                    .state
                    .lock()
                    .map_err(lock_error)
                    .map(|state| descriptor(&state))
            })
            .collect()
    }

    pub fn try_pop_notification(&self) -> Result<Option<Vec<u8>>, String> {
        self.inner.notifications.try_pop()
    }

    pub fn clear_notifications(&self) -> Result<(), String> {
        self.inner.notifications.clear()
    }

    fn require(&self, terminal_id: &str) -> Result<Arc<TerminalSession>, RpcError> {
        self.inner
            .sessions
            .lock()
            .map_err(lock_error)?
            .get(terminal_id)
            .cloned()
            .ok_or_else(|| {
                RpcError::new(
                    "instance.missing",
                    format!("Terminal {terminal_id} was not found."),
                )
            })
    }

    fn spawn_reader(
        &self,
        session: Arc<TerminalSession>,
        mut reader: Box<dyn std::io::Read + Send>,
    ) {
        let manager = self.clone();
        std::thread::spawn(move || {
            let mut buffer = vec![0_u8; 64 * 1024];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => return,
                    Ok(length) => {
                        if manager.append_output(&session, &buffer[..length]).is_err() {
                            return;
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => return,
                }
            }
        });
    }

    fn spawn_waiter(&self, session: Arc<TerminalSession>) {
        let manager = self.clone();
        std::thread::spawn(move || {
            let exit = session.child.wait();
            let (exit_code, signal) = exit.unwrap_or((-1, 0));
            let _ = manager.finish_session(&session, exit_code, signal);
        });
    }

    fn append_output(&self, session: &TerminalSession, bytes: &[u8]) -> Result<(), String> {
        let notification = {
            let mut state = session
                .state
                .lock()
                .map_err(|_| "terminal state lock poisoned".to_string())?;
            if state.exit.is_some() {
                return Ok(());
            }
            state.latest_seq += 1;
            let seq = state.latest_seq;
            state.replay.push_back(ReplayFrame {
                bytes: bytes.to_vec(),
                seq,
            });
            state.replay_bytes += bytes.len();
            while state.replay_bytes > self.inner.max_replay_bytes && state.replay.len() > 1 {
                if let Some(frame) = state.replay.pop_front() {
                    state.replay_bytes = state.replay_bytes.saturating_sub(frame.bytes.len());
                }
            }
            json!({
                "type": "notification",
                "method": "terminal.output",
                "params": {
                    "terminalId": state.terminal_id,
                    "generation": state.generation,
                    "seq": seq,
                    "dataBase64": BASE64.encode(bytes),
                }
            })
        };
        self.inner.notifications.push(encode_json(&notification)?)
    }

    fn finish_session(
        &self,
        session: &TerminalSession,
        exit_code: i32,
        signal: i32,
    ) -> Result<(), String> {
        let notification = {
            let mut state = session
                .state
                .lock()
                .map_err(|_| "terminal state lock poisoned".to_string())?;
            if state.exit.is_some() {
                return Ok(());
            }
            state.exit = Some(TerminalExit { exit_code, signal });
            state.version += 1;
            json!({
                "type": "notification",
                "method": "terminal.exit",
                "params": {
                    "terminalId": state.terminal_id,
                    "generation": state.generation,
                    "version": state.version,
                    "exitCode": exit_code,
                    "signal": signal,
                }
            })
        };
        self.inner.notifications.push(encode_json(&notification)?)
    }
}

struct NotificationQueue {
    inner: Mutex<NotificationQueueState>,
    max_bytes: usize,
}

struct NotificationQueueState {
    bytes: usize,
    frames: VecDeque<Vec<u8>>,
}

impl NotificationQueue {
    fn new(max_bytes: usize) -> Self {
        Self {
            inner: Mutex::new(NotificationQueueState {
                bytes: 0,
                frames: VecDeque::new(),
            }),
            max_bytes,
        }
    }

    fn push(&self, frame: Vec<u8>) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "notification queue lock poisoned".to_string())?;
        inner.bytes += frame.len();
        inner.frames.push_back(frame);
        while inner.bytes > self.max_bytes && inner.frames.len() > 1 {
            if let Some(frame) = inner.frames.pop_front() {
                inner.bytes = inner.bytes.saturating_sub(frame.len());
            }
        }
        Ok(())
    }

    fn try_pop(&self) -> Result<Option<Vec<u8>>, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "notification queue lock poisoned".to_string())?;
        let frame = inner.frames.pop_front();
        if let Some(frame) = &frame {
            inner.bytes = inner.bytes.saturating_sub(frame.len());
        }
        Ok(frame)
    }

    fn clear(&self) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "notification queue lock poisoned".to_string())?;
        inner.bytes = 0;
        inner.frames.clear();
        Ok(())
    }
}

fn descriptor(state: &TerminalSessionState) -> TerminalDescriptor {
    TerminalDescriptor {
        terminal_id: state.terminal_id.clone(),
        generation: state.generation,
        version: state.version,
        cols: state.cols,
        rows: state.rows,
        latest_seq: state.latest_seq,
        state: if state.exit.is_some() {
            "exited"
        } else {
            "running"
        },
        created_at_ms: state.created_at_ms,
    }
}

fn assert_generation(state: &TerminalSessionState, generation: u64) -> Result<(), RpcError> {
    if state.generation != generation {
        return Err(
            RpcError::new("instance.conflict", "Terminal generation is stale.").with_details(
                json!({
                    "terminalId": state.terminal_id,
                    "actualGeneration": state.generation,
                    "requestedGeneration": generation,
                }),
            ),
        );
    }
    Ok(())
}

fn assert_identity(
    state: &TerminalSessionState,
    input: &TerminalCommandInput,
) -> Result<(), RpcError> {
    assert_generation(state, input.generation)?;
    if state.version != input.version {
        return Err(
            RpcError::new("instance.conflict", "Terminal version is stale.").with_details(json!({
                "terminalId": state.terminal_id,
                "actualVersion": state.version,
                "requestedVersion": input.version,
            })),
        );
    }
    Ok(())
}

fn assert_running(state: &TerminalSessionState) -> Result<(), RpcError> {
    if state.exit.is_some() {
        return Err(RpcError::new("instance.conflict", "Terminal has exited."));
    }
    Ok(())
}

fn validate_dimensions(cols: u16, rows: u16) -> Result<(), RpcError> {
    if cols < 2 || rows < 1 {
        return Err(RpcError::new(
            "target.invalid",
            "Terminal dimensions are invalid.",
        ));
    }
    Ok(())
}

fn resolve_cwd(
    workspace: &Path,
    policy: &dyn SecurityPolicy,
    value: Option<&str>,
) -> Result<ResolvedPath, RpcError> {
    if !workspace.is_absolute() {
        return Err(RpcError::new(
            "rpc.invalidContext",
            "terminal workspace must be an absolute path",
        ));
    }
    let raw = normalize_cwd_request(value);
    let requested = parse_requested_path(&raw)?;
    let (read, write) = match requested.namespace {
        PathNamespace::Workspace => (
            FilesystemCapability::WorkspaceRead,
            FilesystemCapability::WorkspaceWrite,
        ),
        PathNamespace::Absolute => (
            FilesystemCapability::AbsoluteRead,
            FilesystemCapability::AbsoluteWrite,
        ),
    };
    policy
        .check_capability(read)
        .and_then(|_| policy.check_capability(write))
        .map_err(|error| RpcError {
            code: error.code,
            message: error.message,
            retryable: false,
            details: error.details,
        })?;
    let cwd = resolve_existing_target(workspace, &requested)?;
    if !cwd
        .metadata()
        .map_err(|error| {
            RpcError::new(
                "target.invalid",
                format!("Failed to inspect terminal working directory: {error}"),
            )
        })?
        .is_dir()
    {
        return Err(RpcError::new(
            "target.invalid",
            "Terminal working directory is not a directory.",
        ));
    }
    Ok(cwd)
}

fn normalize_cwd_request(value: Option<&str>) -> String {
    match value {
        None => "./".to_string(),
        Some(value) if Path::new(value).is_absolute() => value.to_string(),
        Some(".") => "./".to_string(),
        #[cfg(windows)]
        Some(value) if value.starts_with(".\\") => format!("./{}", &value[2..]),
        Some(value) if value.starts_with("./") => value.to_string(),
        Some(value) => format!("./{value}"),
    }
}

fn epoch_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn lock_error<T>(_: std::sync::PoisonError<T>) -> RpcError {
    RpcError::new("terminal.internal", "Terminal state lock poisoned.")
}

#[cfg(unix)]
fn spawn_terminal(cwd: &Path, cols: u16, rows: u16) -> Result<SpawnedTerminal, RpcError> {
    pty_unix::spawn(cwd, cols, rows)
}

#[cfg(windows)]
fn spawn_terminal(cwd: &Path, cols: u16, rows: u16) -> Result<SpawnedTerminal, RpcError> {
    pty_windows::spawn(cwd, cols, rows)
}

#[cfg(all(test, windows))]
mod windows_cwd_tests {
    use crate::security::{SecurityMode, build_security_policy};

    use super::resolve_cwd;

    #[test]
    fn terminal_workspace_cwd_accepts_dot_backslash_syntax() {
        let workspace = crate::testing::temp_dir();
        let nested = workspace.path().join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        let policy = build_security_policy(SecurityMode::Disabled);

        let resolved = resolve_cwd(workspace.path(), policy.as_ref(), Some(".\\nested")).unwrap();

        assert_eq!(resolved.canonical, nested.canonicalize().unwrap());
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::time::{Duration, Instant};

    use base64::Engine;
    use base64::engine::general_purpose::STANDARD as BASE64;

    use super::{
        TerminalAttachInput, TerminalCommandInput, TerminalManager, TerminalOpenInput,
        TerminalResizeInput, TerminalWriteInput,
    };

    #[test]
    fn real_terminal_replays_output_resizes_and_kills_explicitly() {
        let workspace = crate::testing::temp_dir();
        let manager = TerminalManager::with_limits(
            1024 * 1024,
            1024 * 1024,
            2,
        );
        let opened = manager
            .open(TerminalOpenInput {
                cols: 80,
                rows: 24,
                cwd: None,
                command: None,
                workspace: workspace.path().to_string_lossy().to_string(),
            })
            .expect("open terminal");
        manager
            .write(TerminalWriteInput {
                identity: TerminalCommandInput {
                    terminal_id: opened.terminal_id.clone(),
                    generation: opened.generation,
                    version: opened.version,
                    client_seq: 1,
                },
                data: BASE64.encode(b"printf '%s%s\\n' 'worker-' 'pty-ready'\r"),
            })
            .expect("write marker");
        wait_for_output(
            &manager,
            &opened.terminal_id,
            opened.generation,
            "worker-pty-ready",
        );

        let resized = manager
            .resize(TerminalResizeInput {
                identity: TerminalCommandInput {
                    terminal_id: opened.terminal_id.clone(),
                    generation: opened.generation,
                    version: opened.version,
                    client_seq: 2,
                },
                cols: 100,
                rows: 40,
            })
            .expect("resize terminal");
        assert_eq!(resized["version"], 2);
        manager
            .write(TerminalWriteInput {
                identity: TerminalCommandInput {
                    terminal_id: opened.terminal_id.clone(),
                    generation: opened.generation,
                    version: 2,
                    client_seq: 3,
                },
                data: BASE64.encode(b"stty size\r"),
            })
            .expect("write stty");
        wait_for_output(&manager, &opened.terminal_id, opened.generation, "40 100");

        let replay = manager
            .attach(TerminalAttachInput {
                terminal_id: opened.terminal_id.clone(),
                generation: opened.generation,
                from_seq: 0,
            })
            .expect("attach replay");
        let all_output = replay
            .replay
            .iter()
            .flat_map(|frame| BASE64.decode(frame.data_base64.as_bytes()).unwrap())
            .collect::<Vec<_>>();
        let all_output = String::from_utf8_lossy(&all_output);
        assert!(all_output.contains("worker-pty-ready"));
        assert!(all_output.contains("40 100"));

        manager
            .kill(TerminalCommandInput {
                terminal_id: opened.terminal_id.clone(),
                generation: opened.generation,
                version: 2,
                client_seq: 4,
            })
            .expect("kill terminal");
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let current = manager
                .attach(TerminalAttachInput {
                    terminal_id: opened.terminal_id.clone(),
                    generation: opened.generation,
                    from_seq: replay.session.latest_seq,
                })
                .expect("read exit state");
            if current.exit.is_some() {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "terminal did not exit after kill"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn terminated_terminal_does_not_permanently_consume_the_session_limit() {
        let workspace = crate::testing::temp_dir();
        let manager = TerminalManager::with_limits(
            1024 * 1024,
            1024 * 1024,
            1,
        );
        let first = manager
            .open(TerminalOpenInput {
                cols: 80,
                rows: 24,
                cwd: None,
                command: None,
                workspace: workspace.path().to_string_lossy().to_string(),
            })
            .expect("open first terminal");
        manager
            .kill(TerminalCommandInput {
                terminal_id: first.terminal_id.clone(),
                generation: first.generation,
                version: first.version,
                client_seq: 1,
            })
            .expect("terminate first terminal");
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let current = manager
                .attach(TerminalAttachInput {
                    terminal_id: first.terminal_id.clone(),
                    generation: first.generation,
                    from_seq: 0,
                })
                .expect("read first terminal exit");
            if current.exit.is_some() {
                break;
            }
            assert!(Instant::now() < deadline, "first terminal did not exit");
            std::thread::sleep(Duration::from_millis(10));
        }

        let second = manager
            .open(TerminalOpenInput {
                cols: 80,
                rows: 24,
                cwd: None,
                command: None,
                workspace: workspace.path().to_string_lossy().to_string(),
            })
            .expect("open replacement terminal after the first exited");
        let listed = manager.list().expect("list replacement terminal");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].terminal_id, second.terminal_id);
        manager
            .kill(TerminalCommandInput {
                terminal_id: second.terminal_id.clone(),
                generation: second.generation,
                version: second.version,
                client_seq: 1,
            })
            .expect("kill replacement terminal");
    }

    fn wait_for_output(
        manager: &TerminalManager,
        terminal_id: &str,
        generation: u64,
        expected: &str,
    ) {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let attached = manager
                .attach(TerminalAttachInput {
                    terminal_id: terminal_id.to_string(),
                    generation,
                    from_seq: 0,
                })
                .expect("attach terminal");
            let bytes = attached
                .replay
                .iter()
                .flat_map(|frame| BASE64.decode(frame.data_base64.as_bytes()).unwrap())
                .collect::<Vec<_>>();
            if String::from_utf8_lossy(&bytes).contains(expected) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "missing terminal output: {expected}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
