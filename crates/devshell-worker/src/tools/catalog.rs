use std::sync::Arc;

use crate::daemon::process::WorkerRuntimeContext;
use crate::model_devshell::ModelDevshellShim;
use crate::socket::SocketPaths;
use crate::storage::InstancePaths;
use crate::tools::artifact::store::ArtifactStore;
use crate::tools::bash::run::BashRunTool;
use crate::tools::file::FileToolState;
use crate::tools::file::edit::FileEditTool;
use crate::tools::file::glob::FileGlobTool;
use crate::tools::file::grep::FileGrepTool;
use crate::tools::file::read::FileReadTool;
#[cfg(unix)]
use crate::tools::tmux::register_tools as register_tmux_tools;
use crate::tools::{ToolError, ToolRegistry};

pub fn builtin_registry(
    instance_paths: &InstancePaths,
    socket_paths: &SocketPaths,
    runtime: &WorkerRuntimeContext,
    artifacts: Arc<ArtifactStore>,
) -> Result<ToolRegistry, ToolError> {
    let mut registry = ToolRegistry::new();
    let files = FileToolState::new();
    let model_devshell = Arc::new(
        ModelDevshellShim::prepare(socket_paths)
            .map_err(|error| ToolError::new("devshell.command.shimUnavailable", error))?,
    );
    registry.register(Arc::new(BashRunTool::new(
        Arc::clone(&artifacts),
        Arc::clone(&model_devshell),
    )?) as Arc<_>)?;
    registry.register(Arc::new(FileReadTool::new(
        Arc::clone(&files),
        Arc::clone(&artifacts),
    )) as Arc<_>)?;
    registry.register(Arc::new(FileEditTool::new(Arc::clone(&files))) as Arc<_>)?;
    registry.register(Arc::new(FileGlobTool::new(Arc::clone(&files))) as Arc<_>)?;
    registry.register(Arc::new(FileGrepTool::new(Arc::clone(&files))) as Arc<_>)?;
    #[cfg(unix)]
    register_tmux_tools(
        &mut registry,
        instance_paths,
        socket_paths,
        runtime,
        model_devshell,
    )?;
    #[cfg(windows)]
    let _ = (instance_paths, runtime, model_devshell);
    Ok(registry)
}
