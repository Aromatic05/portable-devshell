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

    pub fn catalog_description(&self) -> String {
        #[cfg(windows)]
        {
            return format!(
                "Execute a bounded, non-interactive command using {} {} with PowerShell syntax. Captures stdout and stderr and reports termination, byte counts, truncation, and optional read-only recovery paths for retained output.",
                self.display_name(),
                self.version
            );
        }
        #[cfg(not(windows))]
        {
            "Execute a bounded, non-interactive Bash command. Captures stdout and stderr and reports termination, byte counts, truncation, and optional read-only recovery paths for retained output.".to_string()
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

use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeMap;

use crate::capability::artifact::types::ArtifactReference;

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct BashRunParams {
    #[schemars(length(min = 1))]
    pub command: String,
    #[serde(default)]
    /// Working directory. Use ./ for a workspace-relative path or / for an absolute path.
    #[schemars(length(min = 1))]
    pub cwd: Option<String>,
    #[serde(default)]
    /// Standard input text. Omit to close stdin immediately and deliver EOF.
    pub stdin: Option<String>,
    /// Required command timeout in milliseconds. Range: 1..=100000.
    #[schemars(range(min = 1, max = 100000))]
    pub timeout_ms: u64,
    #[serde(default)]
    /// Maximum captured bytes per output stream. Defaults to 4194304.
    #[schemars(range(min = 1, max = 16777216))]
    pub max_capture_bytes: Option<usize>,
    #[serde(default)]
    pub env: BTreeMap<String, Option<String>>,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BashRunOutput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub term_signal: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timed_out: Option<bool>,
    pub stdout: String,
    pub stderr: String,
    pub stdout_bytes: usize,
    pub stderr_bytes: usize,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    /// Read-only virtual path for retained stdout when recovery storage is available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdout_path: Option<String>,
    /// Read-only virtual path for retained stderr when recovery storage is available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdout_artifact: Option<ArtifactReference>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr_artifact: Option<ArtifactReference>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact_warnings: Option<Vec<String>>,
    pub duration_ms: u128,
    pub termination: BashTermination,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum BashTermination {
    Exited,
    Signaled,
    Timeout,
}
