use serde::Serialize;

use crate::cli::GcArgs;
use crate::daemon::process::{self, DaemonState};
use crate::instance::{InstanceName, read_config};
use crate::socket::SocketPaths;
use crate::storage::devshell_home;

#[derive(Serialize)]
struct GcResponse {
    ok: bool,
    dry_run: bool,
    removed_instances: Vec<String>,
    skipped_running_instances: Vec<String>,
    skipped_stale_instances: Vec<String>,
}

pub fn run(args: GcArgs) -> Result<String, String> {
    let home_root = devshell_home()?;
    std::fs::create_dir_all(&home_root)
        .map_err(|error| format!("failed to create {}: {error}", home_root.display()))?;

    let mut removed_instances = Vec::new();
    let mut skipped_running_instances = Vec::new();
    let mut skipped_stale_instances = Vec::new();

    for entry in std::fs::read_dir(&home_root)
        .map_err(|error| format!("failed to read {}: {error}", home_root.display()))?
    {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry.file_type().map_err(|error| error.to_string())?.is_dir() {
            continue;
        }

        let raw_name = entry.file_name().to_string_lossy().to_string();
        let Ok(instance) = InstanceName::parse(&raw_name) else {
            continue;
        };
        let instance_paths = crate::storage::InstancePaths::resolve(&instance)?;
        let socket_paths = SocketPaths::resolve(&instance)?;
        if !instance_paths.config_file.exists() {
            continue;
        }
        let Ok(config) = read_config(&instance_paths, &instance) else {
            continue;
        };
        if config.instance != raw_name || config.version == 0 {
            continue;
        }

        match process::daemon_state(&instance_paths, &socket_paths) {
            DaemonState::Running => {
                skipped_running_instances.push(raw_name);
                continue;
            }
            DaemonState::Stale => {
                skipped_stale_instances.push(raw_name);
                continue;
            }
            DaemonState::Stopped => {}
        }

        if !args.dry_run {
            std::fs::remove_dir_all(&instance_paths.instance_root).map_err(|error| {
                format!(
                    "failed to remove {}: {error}",
                    instance_paths.instance_root.display()
                )
            })?;
        }
        removed_instances.push(raw_name);
    }

    serde_json::to_string_pretty(&GcResponse {
        ok: true,
        dry_run: args.dry_run,
        removed_instances,
        skipped_running_instances,
        skipped_stale_instances,
    })
    .map_err(|error| error.to_string())
}
