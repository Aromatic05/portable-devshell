use std::collections::BTreeMap;
use std::sync::Arc;

use serde_json::json;

use crate::tools::file::FileToolState;
use crate::tools::file::discover::discover;
use crate::tools::file::types::{FileFindEntry, FileFindInput, FileFindOutput, FindType};
use crate::tools::{ToolCall, ToolCapability, ToolCatalogEntry, ToolError, ToolHandler, ToolName};

const PAGE_SIZE: usize = 200;

pub struct FileFindTool {
    name: ToolName,
    state: Arc<FileToolState>,
}
impl FileFindTool {
    pub fn new(state: Arc<FileToolState>) -> Self {
        Self {
            name: ToolName::parse("file_find").unwrap(),
            state,
        }
    }
}
impl ToolHandler for FileFindTool {
    fn name(&self) -> &ToolName {
        &self.name
    }
    fn catalog_entry(&self) -> ToolCatalogEntry {
        crate::tools::contract::catalog_entry::<FileFindInput, FileFindOutput>(
            &self.name,
            "Find files and directories by exact path or glob.".to_string(),
            [ToolCapability::Read],
        )
    }
    fn call(&self, call: ToolCall) -> Result<serde_json::Value, ToolError> {
        call.check_cancelled()?;
        let input: FileFindInput = call.parse_params()?;
        let hidden = input.hidden.unwrap_or(true);
        let gitignore = input.gitignore.unwrap_or(true);
        let kind = input.entry_type.unwrap_or(FindType::Any);
        let query =
            json!({ "paths": input.paths, "type": kind, "hidden": hidden, "gitignore": gitignore });
        let offset = input.cursor.as_deref().map_or(Ok(0), |cursor| {
            self.state.cursors.lock().unwrap().resolve(cursor, &query)
        })?;
        let entries = discover(
            &call,
            query["paths"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_string())
                .collect::<Vec<_>>()
                .as_slice(),
            hidden,
            gitignore,
        )?;
        call.check_cancelled()?;
        let mut filtered = Vec::new();
        for (index, entry) in entries.into_iter().enumerate() {
            if index % 256 == 0 {
                call.check_cancelled()?;
            }
            let matches = match kind {
                FindType::Any => entry.entry_type != "other",
                FindType::File => entry.entry_type == "file",
                FindType::Directory => entry.entry_type == "directory",
            };
            if matches {
                filtered.push(FileFindEntry {
                    path: entry.display,
                    entry_type: entry.entry_type.to_string(),
                });
            }
        }
        let entries = filtered;
        let next_cursor = (entries.len() > offset + PAGE_SIZE).then(|| {
            self.state
                .cursors
                .lock()
                .unwrap()
                .issue(&query, offset + PAGE_SIZE)
        });
        let entries = entries
            .into_iter()
            .skip(offset)
            .take(PAGE_SIZE)
            .collect::<Vec<_>>();
        let content = render_tree(&entries);
        crate::tools::contract::serialize(FileFindOutput {
            entries,
            content,
            next_cursor,
        })
    }
}
#[derive(Default)]
struct TreeNode {
    children: BTreeMap<String, TreeNode>,
    entry_type: Option<String>,
}

fn render_tree(entries: &[FileFindEntry]) -> String {
    let mut roots = BTreeMap::<String, TreeNode>::new();
    for entry in entries {
        let (root, segments) = split_display_path(&entry.path);
        let mut node = roots.entry(root).or_default();
        for segment in segments {
            node = node.children.entry(segment).or_default();
        }
        node.entry_type = Some(entry.entry_type.clone());
    }

    let mut lines = Vec::new();
    for (root, node) in roots {
        lines.push(root);
        render_children(&node, "", &mut lines);
    }
    lines.join("\n")
}

fn split_display_path(path: &str) -> (String, Vec<String>) {
    if path == "./" {
        return ("./".to_string(), Vec::new());
    }
    if let Some(relative) = path.strip_prefix("./") {
        return (
            "./".to_string(),
            relative
                .split('/')
                .filter(|segment| !segment.is_empty())
                .map(ToString::to_string)
                .collect(),
        );
    }
    if path == "/" {
        return ("/".to_string(), Vec::new());
    }
    if let Some(relative) = path.strip_prefix('/') {
        return (
            "/".to_string(),
            relative
                .split('/')
                .filter(|segment| !segment.is_empty())
                .map(ToString::to_string)
                .collect(),
        );
    }
    (path.to_string(), Vec::new())
}

fn render_children(node: &TreeNode, prefix: &str, lines: &mut Vec<String>) {
    let count = node.children.len();
    for (index, (name, child)) in node.children.iter().enumerate() {
        let last = index + 1 == count;
        let connector = if last { "└── " } else { "├── " };
        let suffix = if child.entry_type.as_deref() == Some("directory")
            || (!child.children.is_empty() && child.entry_type.is_none())
        {
            "/"
        } else if child.entry_type.as_deref() == Some("symlink") {
            "@"
        } else {
            ""
        };
        lines.push(format!("{prefix}{connector}{name}{suffix}"));
        let child_prefix = format!("{prefix}{}", if last { "    " } else { "│   " });
        render_children(child, &child_prefix, lines);
    }
}
