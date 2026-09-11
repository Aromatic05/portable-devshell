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
    flatten_root_object_union(value);
    normalize_schema_node(value);
}

fn normalize_schema_node(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Array(values) => {
            for value in values {
                normalize_schema_node(value);
            }
        }
        serde_json::Value::Object(properties) => {
            let numeric = properties.get("type").is_some_and(is_numeric_type);
            if numeric {
                properties.remove("format");
            }
            for value in properties.values_mut() {
                normalize_schema_node(value);
            }
        }
        _ => {}
    }
}

fn flatten_root_object_union(value: &mut serde_json::Value) {
    let Some(root) = value.as_object() else {
        return;
    };
    let union = root
        .get("anyOf")
        .and_then(serde_json::Value::as_array)
        .or_else(|| root.get("oneOf").and_then(serde_json::Value::as_array))
        .cloned();
    let Some(union) = union else {
        return;
    };

    if root
        .get("properties")
        .and_then(serde_json::Value::as_object)
        .is_some()
    {
        let root = value
            .as_object_mut()
            .expect("schema root remained an object");
        root.remove("anyOf");
        root.remove("oneOf");
        return;
    }

    let Some(variants) = resolve_object_variants(root, &union) else {
        return;
    };
    let mut properties = serde_json::Map::new();
    for variant in &variants {
        if let Some(fields) = variant
            .get("properties")
            .and_then(serde_json::Value::as_object)
        {
            properties.extend(fields.clone());
        }
    }
    let required = intersect_required(&variants);
    let deny_additional = variants.iter().all(|variant| {
        variant.get("additionalProperties") == Some(&serde_json::Value::Bool(false))
    });

    let root = value
        .as_object_mut()
        .expect("schema root remained an object");
    root.remove("anyOf");
    root.remove("oneOf");
    root.insert(
        "type".to_string(),
        serde_json::Value::String("object".to_string()),
    );
    root.insert(
        "properties".to_string(),
        serde_json::Value::Object(properties),
    );
    if required.is_empty() {
        root.remove("required");
    } else {
        root.insert(
            "required".to_string(),
            serde_json::Value::Array(
                required
                    .into_iter()
                    .map(serde_json::Value::String)
                    .collect(),
            ),
        );
    }
    if deny_additional {
        root.insert(
            "additionalProperties".to_string(),
            serde_json::Value::Bool(false),
        );
    }
}

fn resolve_object_variants(
    root: &serde_json::Map<String, serde_json::Value>,
    union: &[serde_json::Value],
) -> Option<Vec<serde_json::Map<String, serde_json::Value>>> {
    union
        .iter()
        .map(|variant| resolve_object_variant(root, variant))
        .collect()
}

fn resolve_object_variant(
    root: &serde_json::Map<String, serde_json::Value>,
    variant: &serde_json::Value,
) -> Option<serde_json::Map<String, serde_json::Value>> {
    let variant = variant.as_object()?;
    let resolved = match variant.get("$ref").and_then(serde_json::Value::as_str) {
        Some(reference) => resolve_local_definition(root, reference)?,
        None => variant,
    };
    let object_schema = resolved.get("type").and_then(serde_json::Value::as_str) == Some("object")
        || resolved
            .get("properties")
            .and_then(serde_json::Value::as_object)
            .is_some();
    object_schema.then(|| resolved.clone())
}

fn resolve_local_definition<'a>(
    root: &'a serde_json::Map<String, serde_json::Value>,
    reference: &str,
) -> Option<&'a serde_json::Map<String, serde_json::Value>> {
    let name = reference.strip_prefix("#/$defs/")?;
    root.get("$defs")?.as_object()?.get(name)?.as_object()
}

fn intersect_required(variants: &[serde_json::Map<String, serde_json::Value>]) -> Vec<String> {
    let Some(first) = variants.first() else {
        return Vec::new();
    };
    read_required(first)
        .into_iter()
        .filter(|name| {
            variants
                .iter()
                .skip(1)
                .all(|variant| read_required(variant).contains(name))
        })
        .collect()
}

fn read_required(schema: &serde_json::Map<String, serde_json::Value>) -> Vec<String> {
    schema
        .get("required")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .map(str::to_string)
        .collect()
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

    use crate::tools::file::types::{FileGlobInput, FileGrepInput};

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

    #[test]
    fn normalize_schema_keeps_file_glob_as_one_object_contract() {
        let mut schema = serde_json::to_value(schemars::schema_for!(FileGlobInput)).unwrap();
        normalize_schema(&mut schema);

        assert_eq!(schema.get("type"), Some(&json!("object")));
        let properties = schema
            .get("properties")
            .and_then(serde_json::Value::as_object)
            .unwrap();
        assert!(properties.contains_key("patterns"));
        assert!(properties.contains_key("type"));
        assert!(properties.contains_key("hidden"));
        assert!(properties.contains_key("gitignore"));
        assert!(properties.contains_key("cursor"));
        assert!(schema.get("required").is_none());
        assert_eq!(schema.get("additionalProperties"), Some(&json!(false)));
    }

    #[test]
    fn normalize_schema_keeps_file_grep_as_one_object_contract() {
        let mut schema = serde_json::to_value(schemars::schema_for!(FileGrepInput)).unwrap();
        normalize_schema(&mut schema);

        assert_eq!(schema.get("type"), Some(&json!("object")));
        let properties = schema
            .get("properties")
            .and_then(serde_json::Value::as_object)
            .unwrap();
        for name in [
            "pattern",
            "paths",
            "syntax",
            "caseSensitive",
            "hidden",
            "gitignore",
            "context",
            "startLine",
            "cursor",
        ] {
            assert!(properties.contains_key(name), "missing property {name}");
        }
        assert!(schema.get("required").is_none());
    }
}
