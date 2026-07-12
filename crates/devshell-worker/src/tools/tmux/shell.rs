use std::fs;
use std::path::{Path, PathBuf};

use crate::tools::ToolError;

const BASH_INTEGRATION: &str = include_str!("assets/bash.sh");
const ZSH_INTEGRATION: &str = include_str!("assets/zsh.sh");

pub struct ShellLaunch {
    pub command: String,
}

pub fn prepare_shell_launch(
    shell_root: &Path,
    status_dir: &Path,
    pane_id: &str,
) -> Result<ShellLaunch, ToolError> {
    fs::create_dir_all(shell_root).map_err(io_error)?;
    fs::create_dir_all(status_dir).map_err(io_error)?;
    let shell = managed_shell();
    match shell.file_name().and_then(|name| name.to_str()) {
        Some("zsh") => prepare_zsh(shell_root, status_dir, pane_id, &shell),
        _ => prepare_bash(shell_root, status_dir, pane_id, &shell),
    }
}

fn managed_shell() -> PathBuf {
    let configured = std::env::var_os("SHELL").map(PathBuf::from);
    match configured
        .as_ref()
        .and_then(|path| path.file_name())
        .and_then(|name| name.to_str())
    {
        Some("bash" | "zsh") => configured.unwrap(),
        _ => PathBuf::from("/bin/bash"),
    }
}

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
        command: format!(
            "exec env -u TMUX -u TMUX_TMPDIR DEVSHELL_TMUX_PANE_STATUS_DIR={} DEVSHELL_TMUX_PANE_ID={} {} --rcfile {} -i",
            quote(status_dir.to_string_lossy().as_ref()),
            quote(pane_id),
            quote(shell.to_string_lossy().as_ref()),
            quote(rc.to_string_lossy().as_ref())
        ),
    })
}

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
        command: format!(
            "exec env -u TMUX -u TMUX_TMPDIR DEVSHELL_TMUX_PANE_STATUS_DIR={} DEVSHELL_TMUX_PANE_ID={} ZDOTDIR={} {} -i",
            quote(status_dir.to_string_lossy().as_ref()),
            quote(pane_id),
            quote(zdotdir.to_string_lossy().as_ref()),
            quote(shell.to_string_lossy().as_ref())
        ),
    })
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn io_error(error: std::io::Error) -> ToolError {
    ToolError::new("tmux.storageFailed", error.to_string())
}
