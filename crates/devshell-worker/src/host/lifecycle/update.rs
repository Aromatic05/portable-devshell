use crate::cli::{InstanceArgs, UpgradeRestartArgs};
use crate::daemon::log::append_log;
use crate::host::home::devshell_home;
use crate::host::lifecycle::install;
use crate::instance::InstanceName;
use crate::instance::storage::InstancePaths;

/// Run by the *new* Worker binary, detached from the old Reverse connection.
/// The old executable remains available until the replacement is running.
pub fn restart(args: UpgradeRestartArgs) -> Result<String, String> {
    let instance = InstanceName::parse(&args.instance)?;
    let paths = InstancePaths::resolve(&instance)?;
    let previous = devshell_home()?
        .join("bin")
        .join("devshell-worker")
        .canonicalize()
        .map_err(|error| format!("cannot identify previous Worker: {error}"))?;

    // The existing installer verifies the content and switches only the
    // executable alias. The old daemon keeps running until the new binary
    // is ready to take ownership of its instance.
    install::install_current_binary()?;
    let _ = append_log(&paths, "reverse Worker update staged; restarting daemon");
    if let Err(error) = crate::cli::instance::lifecycle::stop::stop_instance(&instance) {
        install::install_from_path(&previous)?;
        let _ = append_log(
            &paths,
            &format!("reverse Worker update could not stop daemon: {error}"),
        );
        return Err(error);
    }

    match crate::cli::instance::lifecycle::start::run(InstanceArgs {
        instance: args.instance,
    }) {
        Ok(result) => {
            let _ = append_log(&paths, "reverse Worker update daemon started");
            Ok(result)
        }
        Err(error) => {
            let restored = install::install_from_path(&previous)?;
            install::start_installed_worker(&restored, &instance).map_err(|rollback| {
                let message = format!("Worker update failed: {error}; rollback failed: {rollback}");
                let _ = append_log(&paths, &message);
                message
            })?;
            let message = format!("Worker update failed, previous version restored: {error}");
            let _ = append_log(&paths, &message);
            Err(message)
        }
    }
}
