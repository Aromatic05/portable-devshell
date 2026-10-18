use std::collections::BTreeMap;
use std::os::windows::process::CommandExt;
use std::process::{Child, Command, Stdio};

use crate::instance::sandbox::path::ResolvedPath;
use crate::tool::ToolError;
use crate::tool::bash::model::{ShellRuntime, powershell_command};
use windows_sys::Win32::System::Threading::{CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW};

pub fn spawn_shell(
    shell: &ShellRuntime,
    command_text: &str,
    cwd: &ResolvedPath,
    env: &BTreeMap<String, Option<String>>,
    execution: Option<&crate::capability::execution::ExecutionConfig>,
) -> Result<Child, ToolError> {
    if crate::capability::execution::process_sandbox(execution)
        .map_err(|e| ToolError::new("execution.sandboxFailed", e))?
        .is_some()
    {
        return Err(ToolError::new(
            "execution.sandboxFailed",
            "bubblewrap process sandbox is unavailable on Windows",
        ));
    }
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
        .env_remove(crate::instance::runtime::INTERNAL_INSTANCE_ENV)
        .env_remove(crate::instance::runtime::INTERNAL_SECURITY_MODE_ENV)
        .env_remove(crate::capability::execution::CONFIG_ENV)
        .env_remove("DEVSHELL_WORKER_INTERNAL_WORKSPACE");
    command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    command.spawn().map_err(|error| {
        ToolError::new(
            "bash.spawnFailed",
            format!("failed to spawn PowerShell: {error}"),
        )
    })
}
