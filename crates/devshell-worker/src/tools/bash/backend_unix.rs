use std::collections::BTreeMap;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};

use nix::unistd::{Pid, fchdir, setpgid};

use crate::security::path::ResolvedPath;
use crate::tools::ToolError;
use crate::tools::bash::runtime::ShellRuntime;

pub fn spawn_shell(
    shell: &ShellRuntime,
    command_text: &str,
    cwd: &ResolvedPath,
    env: &BTreeMap<String, Option<String>>,
) -> Result<Child, ToolError> {
    let anchored_cwd = cwd
        .cloned_directory_file()
        .map_err(|error| ToolError::new("bash.invalidCwd", error.to_string()))?;
    let mut command = Command::new(&shell.executable);
    command
        .arg("-lc")
        .arg(command_text)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if anchored_cwd.is_none() {
        command.current_dir(cwd.access_path());
    }
    apply_environment(&mut command, env);
    unsafe {
        command.pre_exec(move || {
            if let Some(directory) = &anchored_cwd {
                fchdir(directory).map_err(std::io::Error::other)?;
            }
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

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::fs;
    use std::os::unix::fs::symlink;

    use crate::security::path::{parse_requested_path, resolve_existing_target};
    use crate::tools::bash::runtime::ShellRuntime;

    use super::spawn_shell;

    #[test]
    fn spawned_shell_uses_the_anchored_directory_after_parent_swap() {
        let root = crate::testing::temp_dir();
        let outside = crate::testing::temp_dir();
        let workspace = root.path().join("workspace");
        fs::create_dir_all(workspace.join("safe")).unwrap();
        fs::write(workspace.join("safe/marker.txt"), "inside").unwrap();
        fs::write(outside.path().join("marker.txt"), "outside").unwrap();
        let requested = parse_requested_path("./safe").unwrap();
        let resolved = resolve_existing_target(&workspace, &requested).unwrap();

        fs::rename(workspace.join("safe"), workspace.join("safe-old")).unwrap();
        symlink(outside.path(), workspace.join("safe")).unwrap();

        let output = spawn_shell(
            &ShellRuntime::detect().unwrap(),
            "cat marker.txt",
            &resolved,
            &BTreeMap::new(),
        )
        .unwrap()
        .wait_with_output()
        .unwrap();
        assert!(output.status.success());
        assert_eq!(String::from_utf8(output.stdout).unwrap().trim(), "inside");
    }
}
