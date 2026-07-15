pub mod backend;
pub mod close;
pub mod codec;
pub mod create;
pub mod group;
pub mod input;
pub mod inspect;
pub mod list;
pub mod output;
pub mod read;
pub mod replay;
pub mod run;
pub mod shell;
pub mod state;
pub mod task;
pub mod types;

use std::sync::Arc;

use crate::daemon::process::WorkerRuntimeContext;
use crate::socket::SocketPaths;
use crate::storage::InstancePaths;
use crate::tools::tmux::backend::TmuxBackend;
use crate::tools::tmux::close::TmuxCloseTool;
use crate::tools::tmux::create::TmuxCreateTool;
use crate::tools::tmux::input::TmuxInputTool;
use crate::tools::tmux::inspect::TmuxInspectTool;
use crate::tools::tmux::list::TmuxListTool;
use crate::tools::tmux::read::TmuxReadTool;
use crate::tools::tmux::run::TmuxRunTool;
use crate::tools::tmux::state::TmuxState;
use crate::tools::tmux::types::TmuxWarning;
use crate::tools::{ToolError, ToolRegistry};

fn warning(pane: Option<&str>, code: &str, message: &str) -> TmuxWarning {
    TmuxWarning {
        pane: pane.map(ToOwned::to_owned),
        code: code.to_string(),
        message: message.to_string(),
    }
}

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
    registry.register(Arc::new(TmuxRunTool::new(Arc::clone(&state))) as Arc<_>)?;
    registry.register(Arc::new(TmuxInputTool::new(Arc::clone(&state))) as Arc<_>)?;
    registry.register(Arc::new(TmuxReadTool::new(Arc::clone(&state))) as Arc<_>)?;
    registry.register(Arc::new(TmuxInspectTool::new(Arc::clone(&state))) as Arc<_>)?;
    registry.register(Arc::new(TmuxListTool::new(Arc::clone(&state))) as Arc<_>)?;
    registry.register(Arc::new(TmuxCreateTool::new(Arc::clone(&state))) as Arc<_>)?;
    registry.register(Arc::new(TmuxCloseTool::new(Arc::clone(&state))) as Arc<_>)?;
    Ok(())
}
