//! Start a resource owner independent of the Worker process group.
use crate::instance::{InstanceName, sandbox::SecurityMode, storage::InstancePaths};

pub(in crate::capability::process) fn spawn(
    instance: &InstanceName,
    paths: &InstancePaths,
    mode: &SecurityMode,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    let executable = std::path::PathBuf::from("/proc/self/exe");
    #[cfg(not(target_os = "linux"))]
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    #[cfg(windows)]
    let security = match mode {
        SecurityMode::Disabled => "disabled",
        SecurityMode::Workspace => "workspace",
    };
    #[cfg(unix)]
    {
        return spawn_command(std::process::Command::new(executable), instance, paths, mode);
    }
    #[cfg(windows)]
    {
        // The internal host role is dispatched before daemon entry in main.
        crate::daemon::process::platform::spawn_daemon_process(
            &executable,
            &paths.instance_root,
            &[
                (
                    crate::instance::runtime::INTERNAL_INSTANCE_ENV,
                    std::ffi::OsStr::new(instance.as_str()),
                ),
                (
                    crate::instance::runtime::INTERNAL_SECURITY_MODE_ENV,
                    std::ffi::OsStr::new(security),
                ),
                (
                    "DEVSHELL_WORKER_INTERNAL_PROCESS_HOST",
                    std::ffi::OsStr::new(instance.as_str()),
                ),
            ],
        )?;
    }
    #[cfg(windows)]
    Ok(())
}


#[cfg(unix)]
pub(in crate::capability::process) fn spawn_command(
    mut command: std::process::Command,
    instance: &InstanceName,
    paths: &InstancePaths,
    mode: &SecurityMode,
) -> Result<(), String> {
    use std::process::Stdio;
    command.args(["_process-host", "--instance", instance.as_str()])
        .env_remove(crate::instance::runtime::INTERNAL_INSTANCE_ENV)
        .env(crate::instance::runtime::INTERNAL_SECURITY_MODE_ENV, match mode {
            SecurityMode::Disabled => "disabled",
            SecurityMode::Workspace => "workspace",
        })
        .current_dir(&paths.instance_root)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    crate::daemon::process::platform::configure_daemon_command(&mut command);
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    std::thread::spawn(move || { let _ = child.wait(); });
    Ok(())
}
