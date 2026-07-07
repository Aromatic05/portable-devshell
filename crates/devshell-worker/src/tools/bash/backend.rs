use std::collections::BTreeMap;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

use nix::unistd::{Pid, setpgid};

use crate::tools::ToolError;

pub fn spawn_bash(
    shell: &PathBuf,
    command_text: &str,
    cwd: &Path,
    env: &BTreeMap<String, String>,
) -> Result<Child, ToolError> {
    let mut command = Command::new(shell);
    command
        .arg("-lc")
        .arg(command_text)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    for (key, value) in env {
        command.env(key, value);
    }

    unsafe {
        command.pre_exec(|| {
            setpgid(Pid::from_raw(0), Pid::from_raw(0)).map_err(std::io::Error::other)?;
            Ok(())
        });
    }

    command.spawn().map_err(|error| {
        ToolError::new("bash.spawnFailed", format!("failed to spawn bash: {error}"))
    })
}
