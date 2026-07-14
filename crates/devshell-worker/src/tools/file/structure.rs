use std::collections::BTreeSet;
use std::path::Path;

use tree_sitter::{Language, Node, Parser};

use crate::tools::ToolError;
use crate::tools::file::types::FileParseStatus;

const MAX_OUTLINE_ENTRIES: usize = 200;
const MAX_SIGNATURE_BYTES: usize = 240;

pub struct StructureOutline {
    pub content: String,
    pub seen_lines: Vec<usize>,
    pub language: String,
    pub parse_status: FileParseStatus,
    pub truncated: bool,
}

#[derive(Clone, Copy)]
enum OutlineLanguage {
    Rust,
    TypeScript,
    Tsx,
    JavaScript,
    Python,
    Markdown,
}

struct OutlineEntry {
    depth: usize,
    end_line: usize,
    exact_signature: bool,
    label: String,
    signature: String,
    start_line: usize,
}

pub fn supports(path: &Path) -> bool {
    language_for(path).is_some()
}

pub fn outline(path: &Path, source: &str) -> Result<Option<StructureOutline>, ToolError> {
    let Some((language_name, language, outline_language)) = language_for(path) else {
        return Ok(None);
    };
    let mut parser = Parser::new();
    parser
        .set_language(&language)
        .map_err(|error| ToolError::new("file.parseFailed", error.to_string()))?;
    let Some(tree) = parser.parse(source, None) else {
        return Ok(None);
    };

    let mut entries = Vec::new();
    collect_outline(tree.root_node(), source, outline_language, 0, &mut entries);
    if entries.is_empty() {
        return Ok(None);
    }

    let truncated = entries.len() > MAX_OUTLINE_ENTRIES;
    entries.truncate(MAX_OUTLINE_ENTRIES);
    let mut seen_lines = BTreeSet::new();
    let content = entries
        .into_iter()
        .map(|entry| {
            if entry.exact_signature {
                seen_lines.insert(entry.start_line);
            }
            format!(
                "{}{}-{} {} :: {}",
                "  ".repeat(entry.depth),
                entry.start_line,
                entry.end_line,
                entry.label,
                entry.signature
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    Ok(Some(StructureOutline {
        content,
        seen_lines: seen_lines.into_iter().collect(),
        language: language_name.to_string(),
        parse_status: if tree.root_node().has_error() {
            FileParseStatus::Partial
        } else {
            FileParseStatus::Complete
        },
        truncated,
    }))
}

pub fn block_range(
    path: &Path,
    source: &str,
    start_line: usize,
) -> Result<Option<(usize, usize)>, ToolError> {
    let Some((_, language, _)) = language_for(path) else {
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

fn language_for(path: &Path) -> Option<(&'static str, Language, OutlineLanguage)> {
    let ext = path.extension()?.to_string_lossy().to_ascii_lowercase();
    Some(match ext.as_str() {
        "rs" => (
            "rust",
            tree_sitter_rust::LANGUAGE.into(),
            OutlineLanguage::Rust,
        ),
        "ts" | "mts" | "cts" => (
            "typescript",
            tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            OutlineLanguage::TypeScript,
        ),
        "tsx" => (
            "tsx",
            tree_sitter_typescript::LANGUAGE_TSX.into(),
            OutlineLanguage::Tsx,
        ),
        "js" | "mjs" | "cjs" | "jsx" => (
            "javascript",
            tree_sitter_javascript::LANGUAGE.into(),
            OutlineLanguage::JavaScript,
        ),
        "py" => (
            "python",
            tree_sitter_python::LANGUAGE.into(),
            OutlineLanguage::Python,
        ),
        "md" | "markdown" => (
            "markdown",
            tree_sitter_md::LANGUAGE.into(),
            OutlineLanguage::Markdown,
        ),
        _ => return None,
    })
}

fn collect_outline(
    node: Node<'_>,
    source: &str,
    language: OutlineLanguage,
    depth: usize,
    entries: &mut Vec<OutlineEntry>,
) {
    if entries.len() > MAX_OUTLINE_ENTRIES {
        return;
    }

    let classification = classify(node, source, language);
    let child_depth = depth + usize::from(is_container(node.kind()));
    if let Some(label) = classification {
        let (signature, exact_signature) = signature(node, source);
        entries.push(OutlineEntry {
            depth,
            end_line: node.end_position().row + 1,
            exact_signature,
            label,
            signature,
            start_line: node.start_position().row + 1,
        });
    }

    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        collect_outline(child, source, language, child_depth, entries);
        if entries.len() > MAX_OUTLINE_ENTRIES {
            break;
        }
    }
}

fn classify(node: Node<'_>, source: &str, language: OutlineLanguage) -> Option<String> {
    match language {
        OutlineLanguage::Rust => classify_rust(node, source),
        OutlineLanguage::TypeScript | OutlineLanguage::Tsx => classify_typescript(node, source),
        OutlineLanguage::JavaScript => classify_javascript(node, source),
        OutlineLanguage::Python => classify_python(node, source),
        OutlineLanguage::Markdown => classify_markdown(node, source),
    }
}

fn classify_rust(node: Node<'_>, source: &str) -> Option<String> {
    let kind = match node.kind() {
        "use_declaration" => "use",
        "mod_item" => "mod",
        "function_item" => "fn",
        "struct_item" => "struct",
        "enum_item" => "enum",
        "trait_item" => "trait",
        "impl_item" => "impl",
        "type_item" => "type",
        "const_item" => "const",
        "static_item" => "static",
        "macro_definition" => "macro",
        _ => return None,
    };
    Some(label_with_name(kind, node, source))
}

fn classify_typescript(node: Node<'_>, source: &str) -> Option<String> {
    let kind = match node.kind() {
        "import_statement" | "import_declaration" => "import",
        "function_declaration" => "fn",
        "method_definition" | "method_signature" => "method",
        "class_declaration" => "class",
        "interface_declaration" => "interface",
        "type_alias_declaration" => "type",
        "enum_declaration" => "enum",
        "module" | "internal_module" => "module",
        "lexical_declaration" if contains_arrow_function(node) => "fn",
        _ => return None,
    };
    Some(label_with_name(kind, node, source))
}

fn classify_javascript(node: Node<'_>, source: &str) -> Option<String> {
    let kind = match node.kind() {
        "import_statement" | "import_declaration" => "import",
        "function_declaration" | "generator_function_declaration" => "fn",
        "method_definition" => "method",
        "class_declaration" => "class",
        "lexical_declaration" if contains_arrow_function(node) => "fn",
        _ => return None,
    };
    Some(label_with_name(kind, node, source))
}

fn classify_python(node: Node<'_>, source: &str) -> Option<String> {
    let kind = match node.kind() {
        "import_statement" | "import_from_statement" => "import",
        "function_definition" => "fn",
        "class_definition" => "class",
        "decorated_definition" => return None,
        _ => return None,
    };
    Some(label_with_name(kind, node, source))
}

fn classify_markdown(node: Node<'_>, source: &str) -> Option<String> {
    match node.kind() {
        "atx_heading" | "setext_heading" => Some(format!("heading {}", heading_text(node, source))),
        _ => None,
    }
}

fn label_with_name(kind: &str, node: Node<'_>, source: &str) -> String {
    if node.kind() == "impl_item" {
        let text = node_text(node, source);
        let head = text.split('{').next().unwrap_or(text).trim();
        return compact(head);
    }
    if kind == "use" || kind == "import" {
        return kind.to_string();
    }
    let name = node
        .child_by_field_name("name")
        .or_else(|| first_identifier(node))
        .map(|child| node_text(child, source).trim())
        .filter(|value| !value.is_empty());
    match name {
        Some(name) => format!("{kind} {name}"),
        None => kind.to_string(),
    }
}

fn first_identifier(node: Node<'_>) -> Option<Node<'_>> {
    let mut cursor = node.walk();
    node.named_children(&mut cursor).find(|child| {
        matches!(
            child.kind(),
            "identifier" | "type_identifier" | "property_identifier"
        )
    })
}

fn contains_arrow_function(node: Node<'_>) -> bool {
    let mut cursor = node.walk();
    node.named_descendant_for_byte_range(node.start_byte(), node.end_byte())
        .is_some_and(|_| {
            node.children(&mut cursor)
                .any(|child| child.kind() == "arrow_function" || contains_arrow_function(child))
        })
}

fn heading_text<'a>(node: Node<'a>, source: &'a str) -> &'a str {
    node_text(node, source)
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .trim_start_matches('#')
        .trim()
}

fn signature(node: Node<'_>, source: &str) -> (String, bool) {
    let text = node_text(node, source);
    let first = text.lines().next().unwrap_or("");
    if first.len() <= MAX_SIGNATURE_BYTES {
        return (first.to_string(), true);
    }
    let mut end = MAX_SIGNATURE_BYTES;
    while !first.is_char_boundary(end) {
        end -= 1;
    }
    (format!("{}…", &first[..end]), false)
}

fn compact(value: &str) -> String {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.len() <= MAX_SIGNATURE_BYTES {
        return compact;
    }
    let mut end = MAX_SIGNATURE_BYTES;
    while !compact.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &compact[..end])
}

fn node_text<'a>(node: Node<'_>, source: &'a str) -> &'a str {
    source.get(node.byte_range()).unwrap_or("")
}

fn is_container(kind: &str) -> bool {
    matches!(
        kind,
        "impl_item"
            | "trait_item"
            | "class_declaration"
            | "interface_declaration"
            | "class_definition"
            | "module"
            | "internal_module"
            | "section"
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
    if node.start_position().row == start_row
        && is_block_kind(node.kind())
        && best.is_none_or(|current| {
            node.end_byte() - node.start_byte() < current.end_byte() - current.start_byte()
        })
    {
        *best = Some(node);
    }
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        find_block(child, start_row, best);
    }
}
