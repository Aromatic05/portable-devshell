use std::sync::Arc;

use crate::tools::bash::run::BashRunTool;
use crate::tools::file::FileToolState;
use crate::tools::file::edit::FileEditTool;
use crate::tools::file::find::FileFindTool;
use crate::tools::file::info::FileInfoTool;
use crate::tools::file::read::FileReadTool;
use crate::tools::file::search::FileSearchTool;
use crate::tools::file::write::FileWriteTool;
use crate::tools::{ToolError, ToolRegistry};

pub fn builtin_registry() -> Result<ToolRegistry, ToolError> {
    let mut registry = ToolRegistry::new();
    let files = FileToolState::new();
    registry.register(Arc::new(BashRunTool::new()) as Arc<_>)?;
    registry.register(Arc::new(FileReadTool::new(Arc::clone(&files))) as Arc<_>)?;
    registry.register(Arc::new(FileEditTool::new(Arc::clone(&files))) as Arc<_>)?;
    registry.register(Arc::new(FileWriteTool::new(Arc::clone(&files))) as Arc<_>)?;
    registry.register(Arc::new(FileFindTool::new(Arc::clone(&files))) as Arc<_>)?;
    registry.register(Arc::new(FileSearchTool::new(Arc::clone(&files))) as Arc<_>)?;
    registry.register(Arc::new(FileInfoTool::new(files)) as Arc<_>)?;
    Ok(registry)
}
