use std::sync::Arc;

use crate::capability::artifact::store::ArtifactStore;
use crate::capability::rpc::command::client::ModelDevshellShim;
use crate::instance::runtime::WorkerRuntimeContext;
use crate::instance::storage::InstancePaths;
use crate::tool::bash::run::BashRunTool;
use crate::tool::file::FileToolState;
use crate::tool::file::edit::FileEditTool;
use crate::tool::file::read::FileReadTool;
use crate::tool::file::search::glob::FileGlobTool;
use crate::tool::file::search::grep::FileGrepTool;
use crate::tool::tmux::register_tools as register_tmux_tools;
use crate::tool::{ToolCommandEnvironmentProvider, ToolError, ToolRegistry};
use crate::transport::endpoint::channel::EndpointPaths;

pub fn builtin_registry(
    instance_paths: &InstancePaths,
    socket_paths: &EndpointPaths,
    runtime: &WorkerRuntimeContext,
    artifacts: Arc<ArtifactStore>,
) -> Result<ToolRegistry, ToolError> {
    let mut registry = ToolRegistry::new();
    let files = FileToolState::new();
    let model_devshell: Arc<dyn ToolCommandEnvironmentProvider> = Arc::new(
        ModelDevshellShim::prepare(socket_paths)
            .map_err(|error| ToolError::new("devshell.command.shimUnavailable", error))?,
    );
    registry.register(Arc::new(BashRunTool::new(
        Arc::clone(&artifacts),
        Arc::clone(&model_devshell),
        Arc::clone(&files),
    )?) as Arc<_>)?;
    registry.register(Arc::new(FileReadTool::new(
        Arc::clone(&files),
        Arc::clone(&artifacts),
    )) as Arc<_>)?;
    registry.register(Arc::new(FileEditTool::new(Arc::clone(&files))) as Arc<_>)?;
    registry.register(Arc::new(FileGlobTool::new(Arc::clone(&files))) as Arc<_>)?;
    registry.register(Arc::new(FileGrepTool::new(Arc::clone(&files))) as Arc<_>)?;
    register_tmux_tools(
        &mut registry,
        instance_paths,
        socket_paths,
        runtime,
        model_devshell,
        files,
    )?;
    Ok(registry)
}
