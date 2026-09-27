use std::fs;
use std::path::Path;
#[cfg(unix)]
use std::path::PathBuf;

#[cfg(windows)]
use crate::capability::rpc::path::protocol_path;
use crate::tool::ToolError;
#[cfg(windows)]
use crate::tool::bash::model::{ShellRuntime, powershell_command};

#[cfg(unix)]
const BASH_INTEGRATION: &str = include_str!("../assets/bash.sh");
#[cfg(unix)]
const FISH_INTEGRATION: &str = include_str!("../assets/fish.fish");
#[cfg(unix)]
const ZSH_INTEGRATION: &str = include_str!("../assets/zsh.sh");

pub struct ShellLaunch {
    pub args: Vec<String>,
}

#[cfg(unix)]
pub fn prepare_shell_launch(
    shell_root: &Path,
    status_dir: &Path,
    pane_id: &str,
    _cwd: &Path,
) -> Result<ShellLaunch, ToolError> {
    fs::create_dir_all(shell_root).map_err(io_error)?;
    fs::create_dir_all(status_dir).map_err(io_error)?;
    let shell = managed_shell();
    let launch = match shell.file_name().and_then(|name| name.to_str()) {
        Some("fish") => prepare_fish(shell_root, status_dir, pane_id, &shell),
        Some("zsh") => prepare_zsh(shell_root, status_dir, pane_id, &shell),
        _ => prepare_bash(shell_root, status_dir, pane_id, &shell),
    }?;
    let loop_command = format!("while :; do {}; /bin/sleep 0.05; done", launch.args[0]);
    Ok(ShellLaunch {
        args: vec![format!("exec /bin/sh -c {}", quote(&loop_command))],
    })
}

#[cfg(windows)]
pub fn prepare_shell_launch(
    shell_root: &Path,
    status_dir: &Path,
    pane_id: &str,
    cwd: &Path,
) -> Result<ShellLaunch, ToolError> {
    fs::create_dir_all(shell_root).map_err(io_error)?;
    fs::create_dir_all(status_dir).map_err(io_error)?;
    let shell = ShellRuntime::detect()?;
    let profile = shell_root.join(format!("{pane_id}.ps1"));
    let status_path = status_dir
        .join(format!("{pane_id}.json"))
        .to_string_lossy()
        .replace('\'', "''");
    let cwd = protocol_path(cwd).replace('\'', "''");
    let encoding = powershell_command("");
    write_powershell_script(
        &profile,
        &format!(
            "{encoding}\n\
             Remove-Item -LiteralPath 'Env:DEVSHELL_WORKER_INTERNAL_PSMUX' -ErrorAction SilentlyContinue\n\
             Remove-Item -LiteralPath 'Env:DEVSHELL_WORKER_INTERNAL_INSTANCE' -ErrorAction SilentlyContinue\n\
             Remove-Item -LiteralPath 'Env:DEVSHELL_WORKER_INTERNAL_SECURITY_MODE' -ErrorAction SilentlyContinue\n\
             Remove-Item -LiteralPath 'Env:DEVSHELL_WORKER_INTERNAL_WORKSPACE' -ErrorAction SilentlyContinue\n\
             Remove-Item -LiteralPath 'Env:TMUX' -ErrorAction SilentlyContinue\n\
             Remove-Item -LiteralPath 'Env:TMUX_PANE' -ErrorAction SilentlyContinue\n\
             Remove-Item -LiteralPath 'Env:TMUX_TMPDIR' -ErrorAction SilentlyContinue\n\
             Set-Location -LiteralPath '{cwd}'\n\
             [System.IO.Directory]::SetCurrentDirectory('{cwd}')\n\
             $global:DevshellPaneStatusPath = '{status_path}'\n\
             function global:prompt {{\n\
                 $global:DevshellPaneCwd = $executionContext.SessionState.Path.CurrentLocation.Path\n\
                 try {{ [System.IO.Directory]::SetCurrentDirectory($global:DevshellPaneCwd) }} catch {{}}\n\
                 [Console]::Write(([char]27).ToString() + ']9;9;' + $global:DevshellPaneCwd + [char]7)\n\
                 [System.IO.File]::WriteAllText($global:DevshellPaneStatusPath, '{{\"state\":\"idle\"}}' + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))\n\
                 return \"PS $($executionContext.SessionState.Path.CurrentLocation)> \"\n\
             }}\n"
        ),
    )
    .map_err(io_error)?;
    Ok(ShellLaunch {
        args: vec![
            "--".to_string(),
            shell.executable.to_string_lossy().into_owned(),
            "-NoLogo".to_string(),
            "-NoProfile".to_string(),
            "-NoExit".to_string(),
            "-File".to_string(),
            profile.to_string_lossy().into_owned(),
        ],
    })
}

#[cfg(windows)]
fn write_powershell_script(path: &Path, contents: &str) -> std::io::Result<()> {
    let mut bytes = Vec::with_capacity(3 + contents.len());
    bytes.extend_from_slice(&[0xef, 0xbb, 0xbf]);
    bytes.extend_from_slice(contents.as_bytes());
    fs::write(path, bytes)
}

#[cfg(unix)]
fn managed_shell() -> PathBuf {
    let configured = std::env::var_os("SHELL").map(PathBuf::from);
    match configured
        .as_ref()
        .and_then(|path| path.file_name())
        .and_then(|name| name.to_str())
    {
        Some("bash" | "fish" | "zsh") => configured.unwrap(),
        _ => PathBuf::from("/bin/bash"),
    }
}

#[cfg(unix)]
fn prepare_bash(
    root: &Path,
    status_dir: &Path,
    pane_id: &str,
    shell: &Path,
) -> Result<ShellLaunch, ToolError> {
    let integration = root.join("bash-integration.sh");
    let rc = root.join("bashrc");
    fs::write(&integration, BASH_INTEGRATION).map_err(io_error)?;
    fs::write(
        &rc,
        format!(
            "if [ -f \"$HOME/.bashrc\" ]; then\n  . \"$HOME/.bashrc\"\nfi\nexport DEVSHELL_TMUX_PANE_STATUS_DIR={}\n. {}\n",
            quote(status_dir.to_string_lossy().as_ref()),
            quote(integration.to_string_lossy().as_ref())
        ),
    )
    .map_err(io_error)?;
    Ok(ShellLaunch {
        args: vec![format!(
            "/usr/bin/env -u DEVSHELL_WORKER_INTERNAL_INSTANCE -u DEVSHELL_WORKER_INTERNAL_SECURITY_MODE -u DEVSHELL_WORKER_INTERNAL_WORKSPACE -u TMUX -u TMUX_PANE -u TMUX_TMPDIR DEVSHELL_TMUX_PANE_STATUS_DIR={} DEVSHELL_TMUX_PANE_ID={} {} --rcfile {} -i",
            quote(status_dir.to_string_lossy().as_ref()),
            quote(pane_id),
            quote(shell.to_string_lossy().as_ref()),
            quote(rc.to_string_lossy().as_ref())
        )],
    })
}

#[cfg(unix)]
fn prepare_fish(
    root: &Path,
    status_dir: &Path,
    pane_id: &str,
    shell: &Path,
) -> Result<ShellLaunch, ToolError> {
    let integration = root.join("fish-integration.fish");
    fs::write(&integration, FISH_INTEGRATION).map_err(io_error)?;
    Ok(ShellLaunch {
        args: vec![format!(
            "/usr/bin/env -u DEVSHELL_WORKER_INTERNAL_INSTANCE -u DEVSHELL_WORKER_INTERNAL_SECURITY_MODE -u DEVSHELL_WORKER_INTERNAL_WORKSPACE -u TMUX -u TMUX_PANE -u TMUX_TMPDIR DEVSHELL_TMUX_PANE_STATUS_DIR={} DEVSHELL_TMUX_PANE_ID={} DEVSHELL_TMUX_FISH_INTEGRATION={} {} -C {} -i",
            quote(status_dir.to_string_lossy().as_ref()),
            quote(pane_id),
            quote(integration.to_string_lossy().as_ref()),
            quote(shell.to_string_lossy().as_ref()),
            quote("source \"$DEVSHELL_TMUX_FISH_INTEGRATION\"")
        )],
    })
}

#[cfg(unix)]
fn prepare_zsh(
    root: &Path,
    status_dir: &Path,
    pane_id: &str,
    shell: &Path,
) -> Result<ShellLaunch, ToolError> {
    let integration = root.join("zsh-integration.sh");
    let zdotdir = root.join("zdotdir");
    fs::create_dir_all(&zdotdir).map_err(io_error)?;
    let zshrc = zdotdir.join(".zshrc");
    fs::write(&integration, ZSH_INTEGRATION).map_err(io_error)?;
    fs::write(
        &zshrc,
        format!(
            "if [ -f \"$HOME/.zshrc\" ]; then\n  source \"$HOME/.zshrc\"\nfi\nexport DEVSHELL_TMUX_PANE_STATUS_DIR={}\nsource {}\n",
            quote(status_dir.to_string_lossy().as_ref()),
            quote(integration.to_string_lossy().as_ref())
        ),
    )
    .map_err(io_error)?;
    Ok(ShellLaunch {
        args: vec![format!(
            "/usr/bin/env -u DEVSHELL_WORKER_INTERNAL_INSTANCE -u DEVSHELL_WORKER_INTERNAL_SECURITY_MODE -u DEVSHELL_WORKER_INTERNAL_WORKSPACE -u TMUX -u TMUX_PANE -u TMUX_TMPDIR DEVSHELL_TMUX_PANE_STATUS_DIR={} DEVSHELL_TMUX_PANE_ID={} ZDOTDIR={} {} -d -i",
            quote(status_dir.to_string_lossy().as_ref()),
            quote(pane_id),
            quote(zdotdir.to_string_lossy().as_ref()),
            quote(shell.to_string_lossy().as_ref())
        )],
    })
}

#[cfg(unix)]
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn io_error(error: std::io::Error) -> ToolError {
    ToolError::new("tmux.storageFailed", error.to_string())
}
