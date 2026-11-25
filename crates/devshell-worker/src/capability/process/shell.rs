use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Command;

use crate::tool::ToolError;

#[derive(Clone, Debug)]
pub struct ShellRuntime {
    pub executable: PathBuf,
    pub kind: String,
    pub version: String,
}

impl ShellRuntime {
    pub fn detect() -> Result<Self, ToolError> {
        detect_shell_runtime()
    }

    #[cfg(windows)]
    pub fn display_name(&self) -> &'static str {
        if self
            .executable
            .file_stem()
            .is_some_and(|name| name == "pwsh")
        {
            "PowerShell"
        } else if cfg!(windows) {
            "Windows PowerShell"
        } else {
            "Bash"
        }
    }
}

#[cfg(windows)]
pub fn powershell_command(command_text: &str) -> String {
    format!(
        "$__devshellUtf8 = [System.Text.UTF8Encoding]::new($false); [Console]::InputEncoding = $__devshellUtf8; [Console]::OutputEncoding = $__devshellUtf8; $OutputEncoding = $__devshellUtf8; {command_text}"
    )
}

#[cfg(unix)]
fn detect_shell_runtime() -> Result<ShellRuntime, ToolError> {
    let executable = PathBuf::from("/bin/bash");
    if !executable.is_file() {
        return Err(ToolError::new(
            "bash.shellUnavailable",
            "/bin/bash is unavailable",
        ));
    }
    let version = Command::new(&executable)
        .arg("--version")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .and_then(|output| output.lines().next().map(str::to_string))
        .unwrap_or_else(|| "unknown".to_string());
    Ok(ShellRuntime {
        executable,
        kind: "bash".to_string(),
        version,
    })
}

#[cfg(windows)]
fn detect_shell_runtime() -> Result<ShellRuntime, ToolError> {
    for executable in ["pwsh.exe", "powershell.exe"] {
        let version_command = powershell_command("$PSVersionTable.PSVersion.ToString()");
        let output = Command::new(executable)
            .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"])
            .arg(&version_command)
            .output();
        let Ok(output) = output else {
            continue;
        };
        if !output.status.success() {
            continue;
        }
        let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Ok(ShellRuntime {
            executable: PathBuf::from(executable),
            kind: "powershell".to_string(),
            version: if version.is_empty() {
                "unknown".to_string()
            } else {
                version
            },
        });
    }
    Err(ToolError::new(
        "bash.shellUnavailable",
        "neither pwsh.exe nor powershell.exe is available",
    ))
}

const RESERVED_ENV: [&str; 5] = [
    crate::instance::runtime::INTERNAL_INSTANCE_ENV,
    crate::instance::runtime::INTERNAL_SECURITY_MODE_ENV,
    crate::capability::execution::CONFIG_ENV,
    "DEVSHELL_WORKER_INTERNAL_WORKSPACE",
    "DEVSHELL_WORKER_INTERNAL_PROCESS_HOST",
];

/// The managed command's executable, arguments and environment are prepared
/// once, independently of its pipe or PTY transport.
pub(super) struct ShellCommand {
    program: PathBuf,
    args: Vec<OsString>,
    env: BTreeMap<String, Option<String>>,
}

impl ShellCommand {
    pub fn prepare(
        shell: &ShellRuntime,
        command: &str,
        env: &BTreeMap<String, Option<String>>,
        execution: Option<&crate::capability::execution::ExecutionConfig>,
        tty: bool,
    ) -> Result<Self, ToolError> {
        let sandbox = crate::capability::execution::process_sandbox(execution)
            .map_err(|error| ToolError::new("execution.sandboxFailed", error))?;
        let mut args: Vec<OsString> = Vec::new();
        let program = if let Some((wrapper, wrapper_args)) = sandbox {
            #[cfg(windows)]
            {
                let _ = (wrapper, wrapper_args);
                return Err(ToolError::new(
                    "execution.sandboxFailed",
                    "bubblewrap process sandbox is unavailable on Windows",
                ));
            }
            #[cfg(unix)]
            {
                args.extend(wrapper_args.into_iter().map(OsString::from));
                args.push("--".into());
                args.push(shell.executable.as_os_str().to_owned());
                PathBuf::from(wrapper)
            }
        } else {
            shell.executable.clone()
        };
        #[cfg(unix)]
        {
            args.extend(["--noprofile", "--norc", "-c"].map(OsString::from));
            args.push(command.into());
        }
        #[cfg(windows)]
        {
            args.extend(["-NoLogo", "-NoProfile"].map(OsString::from));
            if !tty {
                args.push("-NonInteractive".into());
            }
            args.push("-Command".into());
            args.push(powershell_command(command).into());
        }

        let mut env = env.clone();
        #[cfg(unix)]
        env.entry("BASH_ENV".to_string()).or_insert(None);
        if tty {
            env.entry("TERM".to_string())
                .or_insert_with(|| Some("xterm-256color".to_string()));
        }
        Ok(Self { program, args, env })
    }

    pub fn std_command(&self) -> Command {
        let mut command = Command::new(&self.program);
        command.args(&self.args);
        for (key, value) in &self.env {
            match value {
                Some(value) => {
                    command.env(key, value);
                }
                None => {
                    command.env_remove(key);
                }
            }
        }
        for key in RESERVED_ENV {
            command.env_remove(key);
        }
        command
    }

    #[cfg(windows)]
    pub fn pty_command(&self) -> portable_pty::CommandBuilder {
        let mut command = portable_pty::CommandBuilder::new(&self.program);
        for arg in &self.args {
            command.arg(arg);
        }
        for (key, value) in &self.env {
            match value {
                Some(value) => command.env(key, value),
                None => command.env_remove(key),
            }
        }
        for key in RESERVED_ENV {
            command.env_remove(key);
        }
        command
    }
}
