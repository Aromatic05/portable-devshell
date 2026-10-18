pub mod bash;
pub mod contract;
pub mod environment;
pub mod file;
pub mod registry;
pub mod tmux;

pub use contract::{
    ToolCall, ToolCancellation, ToolCapability, ToolCatalogEntry, ToolError, ToolHandler, ToolName,
    ToolProcessGuard, ToolProcessRegistry, ToolProgressEmitter,
};
pub use environment::{ToolCommandEnvironment, ToolCommandEnvironmentProvider};
pub use registry::ToolRegistry;

pub(crate) fn unix_time_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
