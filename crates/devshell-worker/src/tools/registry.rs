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
            .map(|handler| {
                let mut entry = handler.catalog_entry();
                normalize_schema(&mut entry.input_schema);
                normalize_schema(&mut entry.output_schema);
                entry
            })
            .collect::<Vec<_>>();
        entries.sort_by(|left, right| left.name.cmp(&right.name));
        entries
    }
}

fn normalize_schema(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Array(values) => {
            for value in values {
                normalize_schema(value);
            }
        }
        serde_json::Value::Object(properties) => {
            let numeric = properties.get("type").is_some_and(is_numeric_type);
            if numeric {
                properties.remove("format");
            }
            for value in properties.values_mut() {
                normalize_schema(value);
            }
        }
        _ => {}
    }
}

fn is_numeric_type(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::String(kind) => kind == "integer" || kind == "number",
        serde_json::Value::Array(kinds) => kinds.iter().any(is_numeric_type),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::normalize_schema;

    #[test]
    fn normalize_schema_removes_numeric_formats_recursively() {
        let mut schema = json!({
            "properties": {
                "line": { "format": "int64", "type": "integer" },
                "nested": { "items": { "format": "uint8", "type": ["integer", "null"] }, "type": "array" },
                "text": { "format": "date-time", "type": "string" }
            },
            "type": "object"
        });
        normalize_schema(&mut schema);
        assert_eq!(
            schema,
            json!({
                "properties": {
                    "line": { "type": "integer" },
                    "nested": { "items": { "type": ["integer", "null"] }, "type": "array" },
                    "text": { "format": "date-time", "type": "string" }
                },
                "type": "object"
            })
        );
    }
}
