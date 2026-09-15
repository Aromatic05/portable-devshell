pub mod bash;
pub mod contract;
pub mod file;
pub mod registry;
#[cfg(unix)]
pub mod tmux;

pub use contract::{
    ToolCall, ToolCancellation, ToolCapability, ToolCatalogEntry, ToolError, ToolHandler, ToolName,
    ToolProgressEmitter,
};
pub use registry::{ToolRegistry, builtin_registry};

pub(crate) fn unix_time_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
