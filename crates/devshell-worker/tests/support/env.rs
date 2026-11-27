use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use assert_cmd::Command;
use serde_json::Value;

use super::frame::exchange_rpc;

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
        let runtime = test_runtime_temp_dir();
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

    pub fn instance_root(&self, instance: &str) -> PathBuf {
        self.home_root.join(instance)
    }

    pub fn context_temp_link(&self) -> PathBuf {
        self.home_root.join("context-tmp")
    }

    pub fn socket_file(&self, instance: &str) -> PathBuf {
        self.runtime_root
            .join("devshell-worker")
            .join(instance)
            .join("worker.sock")
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

    pub fn std_command_for(&self, executable: &Path) -> std::process::Command {
        let mut command = std::process::Command::new(executable);
        self.configure_std_command(&mut command);
        command
    }

    pub fn std_command_without_runtime_dir(&self) -> std::process::Command {
        let mut command =
            std::process::Command::new(assert_cmd::cargo::cargo_bin("devshell-worker"));
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
            .timeout(Duration::from_secs(60))
            .assert()
            .success()
            .get_output()
            .stdout
            .clone();
        serde_json::from_slice(&output).unwrap()
    }

    pub fn rpc(&self, instance: &str, port: &str, packet: &Value) -> Value {
        self.rpc_with_command(self.std_command(), instance, port, packet)
    }

    pub fn rpc_without_runtime_dir(&self, instance: &str, port: &str, packet: &Value) -> Value {
        self.rpc_with_command(
            self.std_command_without_runtime_dir(),
            instance,
            port,
            packet,
        )
    }

    fn rpc_with_command(
        &self,
        mut command: std::process::Command,
        instance: &str,
        port: &str,
        packet: &Value,
    ) -> Value {
        let mut child = command
            .args(["transport", "--instance", instance])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut input = child.stdin.take().unwrap();
        let mut output = child.stdout.take().unwrap();
        let (response, status) = std::thread::scope(move |scope| {
            let waiter = scope.spawn(move || wait_child(&mut child, Duration::from_secs(60)));
            let response = exchange_rpc(&mut input, &mut output, instance, port, packet);
            drop(input);
            let status = waiter.join().unwrap();
            drop(output);
            (response, status)
        });
        let method = &packet["method"];
        let status = status.unwrap_or_else(|error| panic!("{instance} {method}: transport child: {error}"));
        assert!(status.success(), "{instance} {method}: transport child exited with {status}");
        response.unwrap_or_else(|error| panic!("{instance} {method}: Endpoint RPC exchange: {error}"))
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

    fn cleanup_instance(&self, instance: &str) {
        let actions: &[&str] = if self.instance_root(instance).join("state/process-host.lock").exists() {
            &["stop", "retire"]
        } else {
            &["stop"]
        };
        for &action in actions {
            let result = self.std_command()
                .args([action, "--instance", instance])
                .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
                .spawn()
                .and_then(|mut child| wait_child(&mut child, Duration::from_secs(30)));
            match result {
                Ok(status) if status.success() => {},
                other => {
                    let message = format!("{action} test instance {instance}: {other:?}");
                    eprintln!("{message}");
                }
            }
        }
    }

    fn stop_remaining_workers(&self) {
        let Ok(entries) = fs::read_dir(&self.home_root) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.join("state/worker.pid").is_file() && !path.join("state/process-host.lock").exists() {
                continue;
            }
            let Some(instance) = entry.file_name().to_str().map(ToOwned::to_owned) else {
                continue;
            };
            self.cleanup_instance(&instance);
        }
    }


}

impl Drop for TestEnv {
    fn drop(&mut self) {
        self.stop_remaining_workers();
    }
}

pub(crate) fn wait_child(child: &mut Child, timeout: Duration) -> std::io::Result<ExitStatus> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(status);
        }
        if Instant::now() >= deadline {
            child.kill()?;
            let _ = child.wait();
            return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "test child exceeded its deadline"));
        }
        std::thread::sleep(Duration::from_millis(10));
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

fn test_runtime_temp_dir() -> tempfile::TempDir {
    #[cfg(target_os = "macos")]
    let namespace = PathBuf::from("/tmp").join("devshell-test-runtime");
    #[cfg(not(target_os = "macos"))]
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
