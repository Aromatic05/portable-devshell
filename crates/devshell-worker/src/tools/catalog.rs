use std::sync::Arc;

use crate::daemon::process::WorkerRuntimeContext;
use crate::model_devshell::ModelDevshellShim;
use crate::socket::SocketPaths;
use crate::storage::InstancePaths;
use crate::tools::artifact::store::ArtifactStore;
use crate::tools::bash::run::BashRunTool;
use crate::tools::file::FileToolState;
use crate::tools::file::edit::FileEditTool;
use crate::tools::file::find::FileFindTool;
use crate::tools::file::info::FileInfoTool;
use crate::tools::file::read::FileReadTool;
use crate::tools::file::search::FileSearchTool;
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
    registry.register(Arc::new(FileReadTool::new(Arc::clone(&files))) as Arc<_>)?;
    registry.register(Arc::new(FileEditTool::new(Arc::clone(&files))) as Arc<_>)?;
    registry.register(Arc::new(FileFindTool::new(Arc::clone(&files))) as Arc<_>)?;
    registry.register(Arc::new(FileSearchTool::new(Arc::clone(&files))) as Arc<_>)?;
    registry.register(Arc::new(FileInfoTool::new()) as Arc<_>)?;
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
