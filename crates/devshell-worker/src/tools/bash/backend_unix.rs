use std::collections::BTreeMap;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};

use nix::unistd::{Pid, setpgid};

use crate::tools::ToolError;
use crate::tools::bash::runtime::ShellRuntime;

pub fn spawn_shell(
    shell: &ShellRuntime,
    command_text: &str,
    cwd: &Path,
    env: &BTreeMap<String, Option<String>>,
) -> Result<Child, ToolError> {
    let mut command = Command::new(&shell.executable);
    command
        .arg("-lc")
        .arg(command_text)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_environment(&mut command, env);
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

fn apply_environment(command: &mut Command, env: &BTreeMap<String, Option<String>>) {
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
}
