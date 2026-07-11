use std::sync::Arc;

use crate::instance::WorkerConfig;
use crate::storage::InstancePaths;
use crate::tools::artifact::read::ArtifactReadTool;
use crate::tools::artifact::store::ArtifactStore;
use crate::tools::bash::run::BashRunTool;
use crate::tools::file::FileToolState;
use crate::tools::file::edit::FileEditTool;
use crate::tools::file::find::FileFindTool;
use crate::tools::file::info::FileInfoTool;
use crate::tools::file::read::FileReadTool;
use crate::tools::file::search::FileSearchTool;
use crate::tools::file::write::FileWriteTool;
use crate::tools::{ToolError, ToolRegistry};

pub fn builtin_registry(
    instance_paths: &InstancePaths,
    config: &WorkerConfig,
) -> Result<ToolRegistry, ToolError> {
    let mut registry = ToolRegistry::new();
    let files = FileToolState::new();
    let artifacts = ArtifactStore::new(instance_paths.artifacts_dir.clone())?;
    registry.register(Arc::new(BashRunTool::new(Arc::clone(&artifacts))) as Arc<_>)?;
    registry.register(Arc::new(ArtifactReadTool::new(artifacts)) as Arc<_>)?;
    registry.register(Arc::new(FileReadTool::new(Arc::clone(&files))) as Arc<_>)?;
    registry.register(Arc::new(FileEditTool::new(
        Arc::clone(&files),
        config.tools.file_edit.mode,
    )) as Arc<_>)?;
    registry.register(Arc::new(FileWriteTool::new(Arc::clone(&files))) as Arc<_>)?;
    registry.register(Arc::new(FileFindTool::new(Arc::clone(&files))) as Arc<_>)?;
    registry.register(Arc::new(FileSearchTool::new(Arc::clone(&files))) as Arc<_>)?;
    registry.register(Arc::new(FileInfoTool::new(files)) as Arc<_>)?;
    Ok(registry)
}
