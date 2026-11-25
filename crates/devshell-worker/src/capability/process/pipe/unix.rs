use std::collections::BTreeMap;
use std::os::unix::process::CommandExt;
use std::process::{Child, Stdio};

use nix::unistd::{Pid, fchdir, setpgid};

use crate::capability::process::shell::{ShellCommand, ShellRuntime};
use crate::instance::sandbox::path::ResolvedPath;
use crate::tool::ToolError;

pub fn spawn_shell(
    shell: &ShellRuntime,
    command_text: &str,
    cwd: &ResolvedPath,
    env: &BTreeMap<String, Option<String>>,
    execution: Option<&crate::capability::execution::ExecutionConfig>,
) -> Result<Child, ToolError> {
    let anchored_cwd = cwd
        .cloned_directory_file()
        .map_err(|error| ToolError::new("bash.invalidCwd", error.to_string()))?;
    let prepared = ShellCommand::prepare(shell, command_text, env, execution, false)?;
    let mut command = prepared.std_command();
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if anchored_cwd.is_none() {
        command.current_dir(cwd.access_path());
    }
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

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::fs;
    use std::os::unix::fs::symlink;

    use crate::capability::process::shell::ShellRuntime;
    use crate::instance::sandbox::path::{parse_requested_path, resolve_existing_target};

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
            None,
        )
        .unwrap()
        .wait_with_output()
        .unwrap();
        assert!(output.status.success());
        assert_eq!(String::from_utf8(output.stdout).unwrap().trim(), "inside");
    }

    #[test]
    fn spawned_shell_cannot_inherit_worker_internal_environment() {
        let root = crate::testing::temp_dir();
        let workspace = root.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let requested = parse_requested_path("./").unwrap();
        let resolved = resolve_existing_target(&workspace, &requested).unwrap();
        let mut env = BTreeMap::new();
        env.insert(
            crate::instance::runtime::INTERNAL_INSTANCE_ENV.to_string(),
            Some("aromatic-pc".to_string()),
        );
        env.insert(
            crate::instance::runtime::INTERNAL_SECURITY_MODE_ENV.to_string(),
            Some("disabled".to_string()),
        );
        env.insert(
            "DEVSHELL_WORKER_INTERNAL_WORKSPACE".to_string(),
            Some("workspace".to_string()),
        );

        let output = spawn_shell(
            &ShellRuntime::detect().unwrap(),
            "printf '%s' \"${DEVSHELL_WORKER_INTERNAL_INSTANCE-}${DEVSHELL_WORKER_INTERNAL_SECURITY_MODE-}${DEVSHELL_WORKER_INTERNAL_WORKSPACE-}\"",
            &resolved,
            &env,
            None,
        )
        .unwrap()
        .wait_with_output()
        .unwrap();

        assert!(output.status.success());
        assert!(output.stdout.is_empty());
    }
}
