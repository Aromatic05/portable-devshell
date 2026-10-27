#[cfg(unix)]
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use crate::instance::storage::InstancePaths;
use crate::transport::endpoint::channel::EndpointPaths;

use super::TMUX_SESSION;
use crate::tool::tmux::transcript::ring as transcript_ring;

pub fn retire_instance_runtime(
    instance_paths: &InstancePaths,
    socket_paths: &EndpointPaths,
    instance: &str,
) -> Result<(), String> {
    #[cfg(windows)]
    let _ = socket_paths;
    #[cfg(unix)]
    for socket in socket_candidates(instance_paths, socket_paths)? {
        if socket == socket_paths.tmux_socket_file
            && show_option(&socket, "@devshell_worker_instance_root", None).unwrap_or_default()
                != instance_paths.instance_root.to_string_lossy()
        {
            continue;
        }
        if !owned_session(&socket, instance, None)? {
            continue;
        }
        let output = run_mux(&socket, &["kill-session", "-t", TMUX_SESSION], None)?;
        if !output.status.success() {
            return Err(format!(
                "failed to retire tmux session {}: {}",
                socket.display(),
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
    }

    #[cfg(windows)]
    retire_windows_workspaces(instance_paths, instance)?;

    let tmux_root = instance_paths.instance_root.join("tmux");
    remove_recorded_rings(&tmux_root)?;
    match fs::remove_dir_all(&tmux_root) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("failed to remove {}: {error}", tmux_root.display())),
    }
}

#[cfg(windows)]
fn retire_windows_workspaces(instance_paths: &InstancePaths, instance: &str) -> Result<(), String> {
    let psmux_data_dir = instance_paths.instance_root.join("tmux").join("psmux");
    let workspaces = instance_paths.instance_root.join("tmux").join("workspaces");
    let entries = match fs::read_dir(&workspaces) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("failed to read {}: {error}", workspaces.display())),
    };
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            continue;
        }
        let key = entry.file_name();
        let key = key.to_string_lossy();
        let namespace = PathBuf::from(format!("devshell-{key}"));
        if !owned_session(&namespace, instance, Some(&psmux_data_dir))? {
            continue;
        }
        let output = run_mux(&namespace, &["kill-server"], Some(&psmux_data_dir))?;
        if !output.status.success() {
            return Err(format!(
                "failed to stop psmux namespace {}: {}",
                namespace.display(),
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
    }
    Ok(())
}

#[cfg(unix)]
fn socket_candidates(
    instance_paths: &InstancePaths,
    socket_paths: &EndpointPaths,
) -> Result<Vec<PathBuf>, String> {
    // Workspace socket names include instance_root, including the /tmp fallback.
    // Never enumerate another HOME's sockets in a shared runtime directory or /tmp.
    let mut sockets = HashSet::new();
    sockets.insert(socket_paths.tmux_socket_file.clone());
    for workspace in
        super::TmuxBackend::discover_workspaces(instance_paths).map_err(|error| error.message)?
    {
        let key = super::workspace_key(&instance_paths.instance_root, &workspace);
        sockets.insert(super::workspace_socket(
            socket_paths,
            &instance_paths.instance_root,
            &workspace,
            &key,
        ));
    }
    Ok(sockets.into_iter().collect())
}

fn owned_session(
    endpoint: &Path,
    instance: &str,
    psmux_data_dir: Option<&Path>,
) -> Result<bool, String> {
    let has_session = match run_mux(
        endpoint,
        &["has-session", "-t", TMUX_SESSION],
        psmux_data_dir,
    ) {
        Ok(output) => output,
        Err(_) => return Ok(false),
    };
    if !has_session.status.success() {
        return Ok(false);
    }
    let managed = show_option(endpoint, "@devshell_worker_managed", psmux_data_dir)?;
    let owner = show_option(endpoint, "@devshell_worker_instance", psmux_data_dir)?;
    Ok(managed == "1" && owner == instance)
}

fn show_option(
    endpoint: &Path,
    option: &str,
    psmux_data_dir: Option<&Path>,
) -> Result<String, String> {
    let output = run_mux(
        endpoint,
        &["show-options", "-qv", "-t", TMUX_SESSION, option],
        psmux_data_dir,
    )?;
    if !output.status.success() {
        return Ok(String::new());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn run_mux(
    endpoint: &Path,
    args: &[&str],
    _psmux_data_dir: Option<&Path>,
) -> Result<Output, String> {
    #[cfg(unix)]
    {
        Command::new("tmux")
            .arg("-S")
            .arg(endpoint)
            .args(args)
            .output()
            .map_err(|error| {
                format!(
                    "failed to inspect tmux session {}: {error}",
                    endpoint.display()
                )
            })
    }
    #[cfg(windows)]
    {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let mut command = Command::new(executable);
        command
            .env(crate::INTERNAL_PSMUX_ENV, "1")
            .arg("-L")
            .arg(endpoint)
            .arg("-f")
            .arg("NUL");
        if let Some(data_dir) = _psmux_data_dir {
            command.env("PSMUX_DATA_DIR", data_dir);
        }
        command.args(args).output().map_err(|error| {
            format!(
                "failed to inspect psmux namespace {}: {error}",
                endpoint.display()
            )
        })
    }
}

fn remove_recorded_rings(root: &Path) -> Result<(), String> {
    if !root.exists() {
        return Ok(());
    }
    let mut directories = vec![root.to_path_buf()];
    while let Some(directory) = directories.pop() {
        for entry in fs::read_dir(&directory)
            .map_err(|error| format!("failed to read {}: {error}", directory.display()))?
        {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            if entry
                .file_type()
                .map_err(|error| error.to_string())?
                .is_dir()
            {
                directories.push(path);
                continue;
            }
            if path.extension().and_then(|value| value.to_str()) != Some("ring") {
                continue;
            }
            let name = fs::read_to_string(&path)
                .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
            transcript_ring::remove(name.trim()).map_err(|error| {
                format!(
                    "failed to remove tmux shared memory {}: {error}",
                    name.trim()
                )
            })?;
        }
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn retire_fixture_child() {
        if std::env::var_os("DEVSHELL_RETIRE_FIXTURE").is_none() {
            return;
        }
        let instance = crate::instance::InstanceName::parse("same-name").unwrap();
        let paths = InstancePaths::resolve(&instance).unwrap();
        let runtime = PathBuf::from(std::env::var_os("FIXTURE_RUNTIME").unwrap());
        let sockets = EndpointPaths {
            socket_file: runtime.join("worker.sock"),
            transport_socket_file: runtime.join("transport.sock"),
            tmux_socket_file: runtime.join("tmux.sock"),
            instance_runtime_dir: runtime,
        };
        retire_instance_runtime(&paths, &sockets, instance.as_str()).unwrap();
    }

    #[test]
    fn retirement_never_inspects_or_kills_another_home_with_the_same_name() {
        for (long_path, legacy_owned) in [(false, false), (true, false), (false, true)] {
            let root = crate::testing::temp_dir();
            let home = root.path().join("home-a");
            let instance_root = home.join("same-name");
            let foreign_root = root.path().join("home-b/same-name");
            let workspace = root.path().join("workspace");
            let runtime = if long_path {
                root.path().join("x".repeat(100))
            } else {
                root.path().join("run")
            };
            fs::create_dir_all(&runtime).unwrap();
            let sockets = EndpointPaths {
                socket_file: runtime.join("worker.sock"),
                transport_socket_file: runtime.join("transport.sock"),
                tmux_socket_file: runtime.join("tmux.sock"),
                instance_runtime_dir: runtime.clone(),
            };
            let key = super::super::workspace_key(&instance_root, &workspace);
            let foreign_key = super::super::workspace_key(&foreign_root, &workspace);
            let own = super::super::workspace_socket(&sockets, &instance_root, &workspace, &key);
            let foreign =
                super::super::workspace_socket(&sockets, &foreign_root, &workspace, &foreign_key);
            let record = instance_root.join("tmux/workspaces").join(&key);
            fs::create_dir_all(&record).unwrap();
            fs::write(
                record.join("workspace.json"),
                serde_json::to_vec(&serde_json::json!({"workspace": workspace})).unwrap(),
            )
            .unwrap();
            fs::write(&own, "fixture").unwrap();
            fs::write(&foreign, "fixture").unwrap();
            let bin = root.path().join("bin");
            fs::create_dir(&bin).unwrap();
            let log = root.path().join("calls");
            let fixture = bin.join("tmux");
            fs::write(
                &fixture,
                r#"#!/bin/sh
socket=$2
shift 2
printf '%s %s\n' "$socket" "$*" >> "$FIXTURE_LOG"
case "$socket" in
    "$FIXTURE_OWN"|"$FIXTURE_FOREIGN"|"$FIXTURE_LEGACY") ;;
    *) exit 1 ;;
esac
case "$1" in
    has-session|kill-session) exit 0 ;;
    show-options)
        case "$5" in
            @devshell_worker_managed) echo 1 ;;
            @devshell_worker_instance) echo same-name ;;
            @devshell_worker_instance_root) printf '%s\n' "$FIXTURE_FOREIGN_ROOT" ;;
        esac ;;
esac
"#,
            )
            .unwrap();
            fs::set_permissions(&fixture, fs::Permissions::from_mode(0o700)).unwrap();
            let output = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "tool::tmux::backend::retire::tests::retire_fixture_child",
                    "--nocapture",
                ])
                .env("DEVSHELL_RETIRE_FIXTURE", "1")
                .env("PORTABLE_DEVSHELL_HOME", &home)
                .env("FIXTURE_RUNTIME", &runtime)
                .env("PATH", &bin)
                .env("FIXTURE_LOG", &log)
                .env("FIXTURE_OWN", &own)
                .env("FIXTURE_FOREIGN", &foreign)
                .env("FIXTURE_LEGACY", &sockets.tmux_socket_file)
                .env(
                    "FIXTURE_FOREIGN_ROOT",
                    if legacy_owned {
                        &instance_root
                    } else {
                        &foreign_root
                    },
                )
                .output()
                .unwrap();
            // Remove only our inert /tmp fixture files, including on assertion failure.
            fs::remove_file(&own).unwrap();
            fs::remove_file(&foreign).unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let calls = fs::read_to_string(log).unwrap();
            assert!(
                calls.contains(&format!("{} kill-session", own.display())),
                "{calls}"
            );
            assert!(
                !calls.contains(&foreign.to_string_lossy().to_string()),
                "another HOME was inspected: {calls}"
            );
            assert_eq!(
                calls.contains(&format!(
                    "{} kill-session",
                    sockets.tmux_socket_file.display()
                )),
                legacy_owned,
                "legacy socket must match the exact instance root: {calls}",
            );
        }
    }
}
