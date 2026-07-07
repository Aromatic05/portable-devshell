use std::sync::Arc;

use crate::tools::bash::run::BashRunTool;
use crate::tools::{ToolError, ToolRegistry};

pub fn builtin_registry() -> Result<ToolRegistry, ToolError> {
    let mut registry = ToolRegistry::new();
    registry.register(Arc::new(BashRunTool::new()) as Arc<_>)?;
    Ok(registry)
}
