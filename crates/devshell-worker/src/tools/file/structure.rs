use std::collections::BTreeSet;
use std::path::Path;

use tree_sitter::{Language, Node, Parser};

use crate::tools::ToolError;

pub struct StructureSummary {
    pub lines: Vec<usize>,
    pub next_selector: Option<String>,
}

pub fn summarize(
    path: &Path,
    source: &str,
    total_lines: usize,
) -> Result<Option<StructureSummary>, ToolError> {
    let Some(language) = language_for(path) else {
        return Ok(None);
    };
    let mut parser = Parser::new();
    parser
        .set_language(&language)
        .map_err(|error| ToolError::new("file.parseFailed", error.to_string()))?;
    let Some(tree) = parser.parse(source, None) else {
        return Ok(None);
    };
    let mut lines = BTreeSet::new();
    collect_summary_lines(tree.root_node(), &mut lines);
    if lines.is_empty() {
        return Ok(None);
    }
    let lines = lines
        .into_iter()
        .filter(|line| *line > 0 && *line <= total_lines)
        .take(200)
        .collect::<Vec<_>>();
    let next_selector = first_missing_range(&lines, total_lines);
    Ok(Some(StructureSummary {
        lines,
        next_selector,
    }))
}

pub fn block_range(
    path: &Path,
    source: &str,
    start_line: usize,
) -> Result<Option<(usize, usize)>, ToolError> {
    let Some(language) = language_for(path) else {
        return Ok(None);
    };
    let mut parser = Parser::new();
    parser
        .set_language(&language)
        .map_err(|error| ToolError::new("file.parseFailed", error.to_string()))?;
    let Some(tree) = parser.parse(source, None) else {
        return Ok(None);
    };
    let mut best = None;
    find_block(tree.root_node(), start_line.saturating_sub(1), &mut best);
    Ok(best.map(|node| (node.start_position().row + 1, node.end_position().row + 1)))
}

fn language_for(path: &Path) -> Option<Language> {
    let ext = path.extension()?.to_string_lossy().to_ascii_lowercase();
    Some(match ext.as_str() {
        "rs" => tree_sitter_rust::LANGUAGE.into(),
        "ts" | "mts" | "cts" => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        "tsx" => tree_sitter_typescript::LANGUAGE_TSX.into(),
        "js" | "mjs" | "cjs" | "jsx" => tree_sitter_javascript::LANGUAGE.into(),
        "py" => tree_sitter_python::LANGUAGE.into(),
        "md" | "markdown" => tree_sitter_md::LANGUAGE.into(),
        _ => return None,
    })
}

fn collect_summary_lines(node: Node<'_>, lines: &mut BTreeSet<usize>) {
    let kind = node.kind();
    if is_summary_kind(kind) {
        lines.insert(node.start_position().row + 1);
        if kind.contains("import") || kind.contains("use_") || kind == "mod_item" {
            for row in node.start_position().row
                ..=node.end_position().row.min(node.start_position().row + 2)
            {
                lines.insert(row + 1);
            }
        }
    }
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        collect_summary_lines(child, lines);
    }
}

fn is_summary_kind(kind: &str) -> bool {
    matches!(
        kind,
        "use_declaration"
            | "mod_item"
            | "import_statement"
            | "import_declaration"
            | "function_item"
            | "function_declaration"
            | "method_definition"
            | "method_declaration"
            | "class_declaration"
            | "interface_declaration"
            | "type_alias_declaration"
            | "struct_item"
            | "enum_item"
            | "trait_item"
            | "impl_item"
            | "const_item"
            | "static_item"
            | "decorated_definition"
            | "class_definition"
            | "function_definition"
            | "atx_heading"
            | "setext_heading"
    )
}

fn is_block_kind(kind: &str) -> bool {
    matches!(
        kind,
        "function_item"
            | "function_declaration"
            | "method_definition"
            | "method_declaration"
            | "class_declaration"
            | "interface_declaration"
            | "type_alias_declaration"
            | "struct_item"
            | "enum_item"
            | "trait_item"
            | "impl_item"
            | "decorated_definition"
            | "class_definition"
            | "function_definition"
            | "atx_heading"
            | "setext_heading"
            | "section"
    )
}

fn find_block<'a>(node: Node<'a>, start_row: usize, best: &mut Option<Node<'a>>) {
    if node.start_position().row == start_row && is_block_kind(node.kind()) {
        if best.is_none_or(|current| {
            node.end_byte() - node.start_byte() < current.end_byte() - current.start_byte()
        }) {
            *best = Some(node);
        }
    }
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        find_block(child, start_row, best);
    }
}

fn first_missing_range(lines: &[usize], total: usize) -> Option<String> {
    if total == 0 {
        return None;
    }
    let shown = lines.iter().copied().collect::<BTreeSet<_>>();
    let start = (1..=total).find(|line| !shown.contains(line))?;
    Some(format!("{}-{}", start, (start + 199).min(total)))
}
