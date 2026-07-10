use std::collections::HashMap;
use std::sync::Arc;

use crate::tools::{ToolCatalogEntry, ToolError, ToolHandler, ToolName};

#[derive(Default)]
pub struct ToolRegistry {
    handlers: HashMap<String, Arc<dyn ToolHandler>>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, handler: Arc<dyn ToolHandler>) -> Result<(), ToolError> {
        let name = handler.name().as_str();
        if self.handlers.contains_key(&name) {
            return Err(ToolError::new(
                "registry.duplicateTool",
                format!("duplicate tool registration for `{name}`"),
            ));
        }
        self.handlers.insert(name, handler);
        Ok(())
    }

    pub fn find(&self, name: &ToolName) -> Result<Arc<dyn ToolHandler>, ToolError> {
        self.handlers.get(&name.as_str()).cloned().ok_or_else(|| {
            ToolError::new("tool.notFound", format!("tool `{name}` is not registered"))
        })
    }

    pub fn catalog(&self) -> Vec<ToolCatalogEntry> {
        let mut entries = self
            .handlers
            .values()
            .map(|handler| handler.catalog_entry())
            .collect::<Vec<_>>();
        entries.sort_by(|left, right| left.name.cmp(&right.name));
        entries
    }
}
