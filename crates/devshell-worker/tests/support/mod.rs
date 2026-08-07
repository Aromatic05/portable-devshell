use std::fs;
use std::path::{Path, PathBuf};

use assert_cmd::Command;
use serde_json::Value;

pub struct TestEnv {
    _home_guard: tempfile::TempDir,
    _runtime_guard: tempfile::TempDir,
    _workspace_guard: tempfile::TempDir,
    home_root: PathBuf,
    runtime_root: PathBuf,
    workspace_root: PathBuf,
}

#[allow(dead_code)]
impl TestEnv {
    pub fn new() -> Self {
        let home = test_temp_dir();
        let runtime = test_temp_dir();
        let workspace = test_temp_dir();
        Self {
            home_root: home.path().join(".devshell"),
            runtime_root: runtime.path().to_path_buf(),
            workspace_root: workspace.path().to_path_buf(),
            _home_guard: home,
            _runtime_guard: runtime,
            _workspace_guard: workspace,
        }
    }

    pub fn home(&self) -> &Path {
        self._home_guard.path()
    }

    pub fn workspace(&self) -> &Path {
        &self.workspace_root
    }

    pub fn protocol_workspace(&self) -> String {
        protocol_path(&self.workspace().canonicalize().unwrap())
    }

    pub fn protocol_skills_directory(&self) -> String {
        protocol_path(&self.home().join(".devshell").join("skill"))
    }

    pub fn instance_root(&self, instance: &str) -> PathBuf {
        self.home_root.join(instance)
    }

    pub fn socket_file(&self, instance: &str) -> PathBuf {
        self.runtime_root
            .join("devshell-worker")
            .join(instance)
            .join("worker.sock")
    }

    pub fn tmux_socket_file(&self, instance: &str) -> PathBuf {
        self.runtime_root
            .join("devshell-worker")
            .join(instance)
            .join("tmux.sock")
    }

    pub fn fallback_socket_file(&self, instance: &str) -> PathBuf {
        self.home_root
            .join("runtime")
            .join("devshell-worker")
            .join(instance)
            .join("worker.sock")
    }

    pub fn std_command(&self) -> std::process::Command {
        let mut command =
            std::process::Command::new(assert_cmd::cargo::cargo_bin("devshell-worker"));
        self.configure_std_command(&mut command);
        command
    }

    pub fn command(&self) -> Command {
        let mut command = Command::cargo_bin("devshell-worker").unwrap();
        self.configure_command(&mut command);
        command
    }

    pub fn workspace_mode_command(&self) -> Command {
        let mut command = Command::cargo_bin("devshell-worker").unwrap();
        self.configure_command(&mut command);
        command.env("DEVSHELL_WORKER_SECURITY_MODE", "workspace");
        command
    }

    pub fn command_with_env(&self, key: &str, value: &str) -> Command {
        let mut command = Command::cargo_bin("devshell-worker").unwrap();
        self.configure_command(&mut command);
        command.env(key, value);
        command
    }

    pub fn command_without_runtime_dir(&self) -> Command {
        let mut command = Command::cargo_bin("devshell-worker").unwrap();
        command
            .env("HOME", self._home_guard.path())
            .env("PORTABLE_DEVSHELL_HOME", &self.home_root)
            .env_remove("XDG_RUNTIME_DIR")
            .env_remove("DEVSHELL_WORKER_INTERNAL_INSTANCE")
            .env_remove("DEVSHELL_WORKER_INTERNAL_WORKSPACE")
            .env_remove("DEVSHELL_WORKER_INTERNAL_SECURITY_MODE");
        #[cfg(windows)]
        command
            .env("USERPROFILE", self._home_guard.path())
            .env_remove("HOMEDRIVE")
            .env_remove("HOMEPATH");
        command
    }

    pub fn json_command(&self, args: &[&str]) -> Value {
        let output = self
            .command()
            .args(args)
            .assert()
            .success()
            .get_output()
            .stdout
            .clone();
        serde_json::from_slice(&output).unwrap()
    }

    pub fn rpc(&self, instance: &str, request: &Value) -> Value {
        let payload = serde_json::to_vec(request).unwrap();
        self.raw_rpc(instance, &payload)
    }

    pub fn raw_rpc(&self, instance: &str, payload: &[u8]) -> Value {
        let mut input = Vec::with_capacity(4 + payload.len());
        input.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        input.extend_from_slice(payload);

        let output = self
            .command()
            .args(["rpc", "--instance", instance])
            .write_stdin(input)
            .assert()
            .success()
            .get_output()
            .stdout
            .clone();
        let length = u32::from_be_bytes(output[..4].try_into().unwrap()) as usize;
        serde_json::from_slice(&output[4..4 + length]).unwrap()
    }

    fn configure_command(&self, command: &mut Command) {
        command
            .env("HOME", self._home_guard.path())
            .env("PORTABLE_DEVSHELL_HOME", &self.home_root)
            .env("XDG_RUNTIME_DIR", &self.runtime_root)
            .env_remove("DEVSHELL_WORKER_INTERNAL_INSTANCE")
            .env_remove("DEVSHELL_WORKER_INTERNAL_WORKSPACE")
            .env_remove("DEVSHELL_WORKER_INTERNAL_SECURITY_MODE");
        #[cfg(windows)]
        command
            .env("USERPROFILE", self._home_guard.path())
            .env_remove("HOMEDRIVE")
            .env_remove("HOMEPATH");
    }

    fn configure_std_command(&self, command: &mut std::process::Command) {
        command
            .env("HOME", self._home_guard.path())
            .env("PORTABLE_DEVSHELL_HOME", &self.home_root)
            .env("XDG_RUNTIME_DIR", &self.runtime_root)
            .env_remove("DEVSHELL_WORKER_INTERNAL_INSTANCE")
            .env_remove("DEVSHELL_WORKER_INTERNAL_WORKSPACE")
            .env_remove("DEVSHELL_WORKER_INTERNAL_SECURITY_MODE");
        #[cfg(windows)]
        command
            .env("USERPROFILE", self._home_guard.path())
            .env_remove("HOMEDRIVE")
            .env_remove("HOMEPATH");
    }

    fn stop_remaining_workers(&self) {
        let Ok(entries) = fs::read_dir(&self.home_root) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.join("state/worker.pid").is_file() {
                continue;
            }
            let Some(instance) = entry.file_name().to_str().map(ToOwned::to_owned) else {
                continue;
            };
            let mut command =
                std::process::Command::new(assert_cmd::cargo::cargo_bin("devshell-worker"));
            self.configure_std_command(&mut command);
            let _ = command.args(["stop", "--instance", &instance]).output();
        }
    }
}

impl Drop for TestEnv {
    fn drop(&mut self) {
        self.stop_remaining_workers();
    }
}

fn test_temp_dir() -> tempfile::TempDir {
    let namespace = std::env::temp_dir().join("devshell-test");
    std::fs::create_dir_all(&namespace).unwrap();
    tempfile::Builder::new()
        .prefix("test-")
        .tempdir_in(&namespace)
        .unwrap()
}

fn protocol_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{rest}");
        }
        if let Some(rest) = value.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }
    value.into_owned()
}
