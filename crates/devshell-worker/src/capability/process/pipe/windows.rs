use std::collections::BTreeMap;
use std::os::windows::process::CommandExt;
use std::process::{Child, Stdio};

use crate::capability::process::shell::{ShellCommand, ShellRuntime};
use crate::instance::sandbox::path::ResolvedPath;
use crate::tool::ToolError;
use windows_sys::Win32::System::Threading::{CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW};

pub fn spawn_shell(
    shell: &ShellRuntime,
    command_text: &str,
    cwd: &ResolvedPath,
    env: &BTreeMap<String, Option<String>>,
    execution: Option<&crate::capability::execution::ExecutionConfig>,
) -> Result<Child, ToolError> {
    let prepared = ShellCommand::prepare(shell, command_text, env, execution, false)?;
    let mut command = prepared.std_command();
    command
        .current_dir(cwd.access_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    command.spawn().map_err(|error| {
        ToolError::new(
            "bash.spawnFailed",
            format!("failed to spawn PowerShell: {error}"),
        )
    })
}
