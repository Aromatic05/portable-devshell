use std::path::PathBuf;
use std::process::Command;

use crate::tools::ToolError;

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

    pub fn catalog_description(&self) -> String {
        #[cfg(windows)]
        {
            return format!(
                "Run a short, non-interactive command using {} {}. Use PowerShell syntax. Use tmux_run for long-running or interactive commands.",
                self.display_name(),
                self.version
            );
        }
        #[cfg(not(windows))]
        {
            "Run a short, non-interactive shell command. Use tmux_run for long-running or interactive commands.".to_string()
        }
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

#[cfg(any(windows, test))]
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

#[cfg(test)]
mod tests {
    use super::powershell_command;

    #[test]
    fn powershell_command_forces_utf8_without_rewriting_the_user_command() {
        let command = powershell_command("Write-Output 'hello'");
        assert!(command.contains("[Console]::InputEncoding = $__devshellUtf8"));
        assert!(command.contains("[Console]::OutputEncoding = $__devshellUtf8"));
        assert!(command.contains("$OutputEncoding = $__devshellUtf8"));
        assert!(command.ends_with("Write-Output 'hello'"));
    }
}
