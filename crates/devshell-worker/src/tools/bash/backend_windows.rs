use std::collections::BTreeMap;
use std::process::{Child, Command, Stdio};

use crate::platform::configure_child_process;
use crate::security::path::ResolvedPath;
use crate::tools::ToolError;
use crate::tools::bash::runtime::{ShellRuntime, powershell_command};

pub fn spawn_shell(
    shell: &ShellRuntime,
    command_text: &str,
    cwd: &ResolvedPath,
    env: &BTreeMap<String, Option<String>>,
) -> Result<Child, ToolError> {
    let mut command = Command::new(&shell.executable);
    command
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"])
        .arg(powershell_command(command_text))
        .current_dir(cwd.access_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in env {
        match value {
            Some(value) => {
                command.env(key, value);
            }
            None => {
                command.env_remove(key);
            }
        }
    }
    command
        .env_remove(crate::daemon::process::INTERNAL_INSTANCE_ENV)
        .env_remove(crate::daemon::process::INTERNAL_SECURITY_MODE_ENV)
        .env_remove("DEVSHELL_WORKER_INTERNAL_WORKSPACE");
    configure_child_process(&mut command);
    command.spawn().map_err(|error| {
        ToolError::new(
            "bash.spawnFailed",
            format!("failed to spawn PowerShell: {error}"),
        )
    })
}
