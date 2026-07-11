use diffy::patch_set::{FileOperation, ParseOptions, PatchSet};
use diffy::{Patch, apply, create_patch, merge};

use crate::tools::ToolError;

#[derive(Debug)]
pub enum ParsedFilePatch {
    Create {
        path: String,
        patch: String,
    },
    Delete {
        path: String,
        patch: String,
    },
    Update {
        path: String,
        move_to: Option<String>,
        patch: String,
    },
}

pub fn render(before: &str, after: &str) -> String {
    create_patch(before, after).to_string()
}

pub fn apply_patch(base: &str, patch: &str) -> Result<String, ToolError> {
    let patch = Patch::from_str(patch)
        .map_err(|error| ToolError::new("file.invalidPatch", error.to_string()))?;
    apply(base, &patch).map_err(|error| ToolError::new("file.patchNoMatch", error.to_string()))
}

pub fn merge_changes(original: &str, current: &str, expected: &str) -> Result<String, ToolError> {
    merge(original, current, expected).map_err(|_| {
        ToolError::retryable(
            "file.revisionMismatch",
            "snapshot changes conflict with the current file",
        )
    })
}

pub fn parse_file_set(input: &str) -> Result<Vec<ParsedFilePatch>, ToolError> {
    let git_format = input.lines().any(|line| line.starts_with("diff --git "));
    let options = if git_format {
        ParseOptions::gitdiff()
    } else {
        ParseOptions::unidiff()
    };
    let parsed = PatchSet::parse(input, options)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| ToolError::new("file.invalidPatch", error.to_string()))?;
    if parsed.is_empty() {
        return Err(ToolError::new(
            "file.emptyOperation",
            "patch contains no file changes",
        ));
    }

    parsed
        .into_iter()
        .map(|file| {
            if file.patch().is_binary() {
                return Err(ToolError::new(
                    "file.notText",
                    "binary patches are not supported by file_edit",
                ));
            }
            if matches!(
                file.operation(),
                FileOperation::Modify { .. } | FileOperation::Rename { .. }
            ) && file.old_mode() != file.new_mode()
                && (file.old_mode().is_some() || file.new_mode().is_some())
            {
                return Err(ToolError::new(
                    "file.invalidPatch",
                    "file mode changes are not supported by file_edit",
                ));
            }
            let text = file.patch().as_text().ok_or_else(|| {
                ToolError::new("file.notText", "patch does not contain UTF-8 text hunks")
            })?;
            let patch = text.to_string();
            let operation = if git_format {
                file.operation().strip_prefix(1)
            } else {
                file.operation().clone()
            };
            match operation {
                FileOperation::Create(path) => {
                    let path = path.as_ref();
                    let path = if git_format {
                        path
                    } else {
                        path.strip_prefix("b/").unwrap_or(path)
                    };
                    Ok(ParsedFilePatch::Create {
                        path: workspace_path(path)?,
                        patch,
                    })
                }
                FileOperation::Delete(path) => {
                    let path = path.as_ref();
                    let path = if git_format {
                        path
                    } else {
                        path.strip_prefix("a/").unwrap_or(path)
                    };
                    Ok(ParsedFilePatch::Delete {
                        path: workspace_path(path)?,
                        patch,
                    })
                }
                FileOperation::Modify { original, modified } => {
                    let original = original.as_ref();
                    let modified = modified.as_ref();
                    let (original, modified) = if !git_format {
                        match (original.strip_prefix("a/"), modified.strip_prefix("b/")) {
                            (Some(old), Some(new)) if old == new => (old, new),
                            _ => (original, modified),
                        }
                    } else {
                        (original, modified)
                    };
                    let path = workspace_path(original)?;
                    let target = workspace_path(modified)?;
                    Ok(ParsedFilePatch::Update {
                        move_to: (path != target).then_some(target),
                        path,
                        patch,
                    })
                }
                FileOperation::Rename { from, to } => Ok(ParsedFilePatch::Update {
                    path: workspace_path(from.as_ref())?,
                    move_to: Some(workspace_path(to.as_ref())?),
                    patch,
                }),
                FileOperation::Copy { .. } => Err(ToolError::new(
                    "file.invalidPatch",
                    "copy operations are not supported by file_edit",
                )),
            }
        })
        .collect()
}

fn workspace_path(path: &str) -> Result<String, ToolError> {
    let path = path.trim();
    if path.is_empty() || path == "/dev/null" || path.starts_with('/') {
        return Err(ToolError::new(
            "file.invalidPath",
            "patch paths must be workspace-relative",
        ));
    }
    Ok(if path.starts_with("./") {
        path.to_string()
    } else {
        format!("./{path}")
    })
}

#[cfg(test)]
mod tests {
    use super::{ParsedFilePatch, merge_changes, parse_file_set};

    #[test]
    fn three_way_merge_handles_repeated_text_when_changes_do_not_overlap() {
        let merged = merge_changes(
            "same\nleft\nsame\nright\n",
            "prefix\nsame\nleft\nsame\nright\n",
            "same\nupdated\nsame\nright\n",
        )
        .unwrap();

        assert_eq!(merged, "prefix\nsame\nupdated\nsame\nright\n");
    }

    #[test]
    fn three_way_merge_rejects_editing_a_block_moved_by_the_current_file() {
        let error = merge_changes(
            "head\nblock-a\nblock-b\ntail\n",
            "head\ntail\nblock-a\nblock-b\n",
            "head\nblock-a\nupdated\ntail\n",
        )
        .unwrap_err();

        assert_eq!(error.code, "file.revisionMismatch");
        assert!(error.retryable);
    }

    #[test]
    fn unidiff_only_strips_a_b_when_headers_form_a_matching_pair() {
        let conventional = parse_file_set(concat!(
            "--- a/x.txt\n",
            "+++ b/x.txt\n",
            "@@ -1 +1 @@\n",
            "-old\n",
            "+new\n"
        ))
        .unwrap();
        let ParsedFilePatch::Update { path, move_to, .. } = &conventional[0] else {
            panic!("expected update");
        };
        assert_eq!(path, "./x.txt");
        assert!(move_to.is_none());

        let real_a_directory = parse_file_set(concat!(
            "--- a/x.txt\n",
            "+++ a/x.txt\n",
            "@@ -1 +1 @@\n",
            "-old\n",
            "+new\n"
        ))
        .unwrap();
        let ParsedFilePatch::Update { path, move_to, .. } = &real_a_directory[0] else {
            panic!("expected update");
        };
        assert_eq!(path, "./a/x.txt");
        assert!(move_to.is_none());
    }

    #[test]
    fn unidiff_create_and_delete_strip_conventional_side_prefixes() {
        let created = parse_file_set(concat!(
            "--- /dev/null\n",
            "+++ b/new.txt\n",
            "@@ -0,0 +1 @@\n",
            "+new\n"
        ))
        .unwrap();
        let ParsedFilePatch::Create { path, .. } = &created[0] else {
            panic!("expected create");
        };
        assert_eq!(path, "./new.txt");

        let deleted = parse_file_set(concat!(
            "--- a/old.txt\n",
            "+++ /dev/null\n",
            "@@ -1 +0,0 @@\n",
            "-old\n"
        ))
        .unwrap();
        let ParsedFilePatch::Delete { path, .. } = &deleted[0] else {
            panic!("expected delete");
        };
        assert_eq!(path, "./old.txt");
    }
}
