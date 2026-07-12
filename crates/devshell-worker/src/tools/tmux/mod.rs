pub mod backend;
pub mod capture;
pub mod close;
pub mod codec;
pub mod create;
pub mod group;
pub mod inspect;
pub mod list;
pub mod send;
pub mod shell;
pub mod state;
pub mod types;

use std::sync::Arc;

use crate::daemon::process::WorkerRuntimeContext;
use crate::socket::SocketPaths;
use crate::storage::InstancePaths;
use crate::tools::tmux::backend::TmuxBackend;
use crate::tools::tmux::capture::TmuxCaptureTool;
use crate::tools::tmux::close::TmuxCloseTool;
use crate::tools::tmux::create::TmuxCreateTool;
use crate::tools::tmux::inspect::TmuxInspectTool;
use crate::tools::tmux::list::TmuxListTool;
use crate::tools::tmux::send::TmuxSendTool;
use crate::tools::tmux::state::TmuxState;
use crate::tools::{ToolError, ToolRegistry};

pub fn register_tools(
    registry: &mut ToolRegistry,
    instance_paths: &InstancePaths,
    socket_paths: &SocketPaths,
    runtime: &WorkerRuntimeContext,
) -> Result<(), ToolError> {
    if !TmuxBackend::available() {
        return Ok(());
    }
    let state = Arc::new(TmuxState::new(TmuxBackend::new(
        instance_paths,
        socket_paths,
        runtime,
    )?));
    registry.register(Arc::new(TmuxSendTool::new(Arc::clone(&state))) as Arc<_>)?;
    registry.register(Arc::new(TmuxCaptureTool::new(Arc::clone(&state))) as Arc<_>)?;
    registry.register(Arc::new(TmuxInspectTool::new(Arc::clone(&state))) as Arc<_>)?;
    registry.register(Arc::new(TmuxListTool::new(Arc::clone(&state))) as Arc<_>)?;
    registry.register(Arc::new(TmuxCreateTool::new(Arc::clone(&state))) as Arc<_>)?;
    registry.register(Arc::new(TmuxCloseTool::new(state)) as Arc<_>)?;
    Ok(())
}
