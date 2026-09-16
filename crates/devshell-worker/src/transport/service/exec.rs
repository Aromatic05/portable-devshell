use std::io::Read;
#[cfg(test)]
use std::io::Write;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

use serde::Deserialize;

const STDERR_SUMMARY_LIMIT: usize = 8 * 1024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExecMetadata {
    executable: String,
    #[serde(default)]
    args: Vec<String>,
    cwd: Option<String>,
}

pub struct ExecService {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: Option<ChildStdout>,
    stderr_summary: Arc<Mutex<Vec<u8>>>,
    stderr_thread: Option<JoinHandle<()>>,
    finished: bool,
}

impl ExecService {
    pub fn open(metadata: &[u8]) -> Result<Self, String> {
        let metadata: ExecMetadata = serde_json::from_slice(metadata)
            .map_err(|error| format!("process.exec metadata is invalid: {error}"))?;
        if metadata.executable.trim().is_empty() {
            return Err("process.exec executable must not be empty.".to_string());
        }

        let mut command = Command::new(&metadata.executable);
        command.args(&metadata.args);
        if let Some(cwd) = metadata.cwd {
            command.current_dir(cwd);
        }
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = command
            .spawn()
            .map_err(|error| format!("process.exec spawn failed: {error}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "process.exec child stdin is unavailable.".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "process.exec child stdout is unavailable.".to_string())?;
        let mut stderr = child
            .stderr
            .take()
            .ok_or_else(|| "process.exec child stderr is unavailable.".to_string())?;
        let stderr_summary = Arc::new(Mutex::new(Vec::new()));
        let thread_summary = Arc::clone(&stderr_summary);
        let stderr_thread = thread::spawn(move || {
            let mut buffer = [0u8; 4096];
            loop {
                let read = match stderr.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => read,
                };
                let Ok(mut summary) = thread_summary.lock() else {
                    break;
                };
                let remaining = STDERR_SUMMARY_LIMIT.saturating_sub(summary.len());
                if remaining > 0 {
                    summary.extend_from_slice(&buffer[..read.min(remaining)]);
                }
            }
        });

        Ok(Self {
            child,
            stdin: Some(stdin),
            stdout: Some(stdout),
            stderr_summary,
            stderr_thread: Some(stderr_thread),
            finished: false,
        })
    }

    #[cfg(test)]
    pub fn write(&mut self, data: &[u8]) -> Result<(), String> {
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| "process.exec stdin is closed.".to_string())?;
        stdin
            .write_all(data)
            .map_err(|error| format!("process.exec stdin write failed: {error}"))
    }

    #[cfg(test)]
    pub fn finish_input(&mut self) -> Result<(), String> {
        self.stdin.take();
        Ok(())
    }

    #[cfg(test)]
    pub fn read(&mut self, buffer: &mut [u8]) -> Result<usize, String> {
        if self.finished {
            return Ok(0);
        }
        let read = self
            .stdout
            .as_mut()
            .ok_or_else(|| "process.exec stdout is already attached.".to_string())?
            .read(buffer)
            .map_err(|error| format!("process.exec stdout read failed: {error}"))?;
        if read > 0 {
            return Ok(read);
        }
        self.finish_status()?;
        Ok(0)
    }

    pub fn reset(&mut self) {
        self.stdin.take();
        if !self.finished {
            let _ = self.child.kill();
            let _ = self.child.wait();
            self.finished = true;
        }
        self.join_stderr();
    }

    pub(super) fn take_stdin(&mut self) -> Result<ChildStdin, String> {
        self.stdin
            .take()
            .ok_or_else(|| "process.exec stdin is already attached.".to_string())
    }

    pub(super) fn take_stdout(&mut self) -> Result<ChildStdout, String> {
        self.stdout
            .take()
            .ok_or_else(|| "process.exec stdout is already attached.".to_string())
    }

    pub(super) fn poll_status(&mut self) -> Result<bool, String> {
        if self.finished {
            return Ok(true);
        }
        let Some(status) = self
            .child
            .try_wait()
            .map_err(|error| format!("process.exec wait failed: {error}"))?
        else {
            return Ok(false);
        };
        self.finished = true;
        self.join_stderr();
        if status.success() {
            return Ok(true);
        }
        let summary = self
            .stderr_summary
            .lock()
            .map(|value| String::from_utf8_lossy(&value).trim().to_string())
            .unwrap_or_default();
        if summary.is_empty() {
            Err(format!("process.exec exited with status {status}."))
        } else {
            Err(format!(
                "process.exec exited with status {status}: {summary}"
            ))
        }
    }

    #[cfg(test)]
    fn finish_status(&mut self) -> Result<(), String> {
        if self.finished {
            return Ok(());
        }
        let status = self
            .child
            .wait()
            .map_err(|error| format!("process.exec wait failed: {error}"))?;
        self.finished = true;
        self.join_stderr();
        if status.success() {
            return Ok(());
        }
        let summary = self
            .stderr_summary
            .lock()
            .map(|value| String::from_utf8_lossy(&value).trim().to_string())
            .unwrap_or_default();
        if summary.is_empty() {
            Err(format!("process.exec exited with status {status}."))
        } else {
            Err(format!(
                "process.exec exited with status {status}: {summary}"
            ))
        }
    }

    fn join_stderr(&mut self) {
        if let Some(handle) = self.stderr_thread.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for ExecService {
    fn drop(&mut self) {
        self.reset();
    }
}
