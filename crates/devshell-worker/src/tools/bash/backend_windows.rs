use std::collections::BTreeMap;
use std::path::Path;
use std::process::{Child, Command, Stdio};

use crate::platform::configure_child_process;
use crate::tools::ToolError;
use crate::tools::bash::runtime::{ShellRuntime, powershell_command};

pub fn spawn_shell(
    shell: &ShellRuntime,
    command_text: &str,
    cwd: &Path,
    env: &BTreeMap<String, Option<String>>,
) -> Result<Child, ToolError> {
    let mut command = Command::new(&shell.executable);
    command
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"])
        .arg(powershell_command(command_text))
        .current_dir(cwd)
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
    configure_child_process(&mut command);
    command.spawn().map_err(|error| {
        ToolError::new(
            "bash.spawnFailed",
            format!("failed to spawn PowerShell: {error}"),
        )
    })
}
