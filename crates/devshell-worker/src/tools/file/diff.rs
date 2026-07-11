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
                FileOperation::Create(path) => Ok(ParsedFilePatch::Create {
                    path: workspace_path(path.as_ref())?,
                    patch,
                }),
                FileOperation::Delete(path) => Ok(ParsedFilePatch::Delete {
                    path: workspace_path(path.as_ref())?,
                    patch,
                }),
                FileOperation::Modify { original, modified } => {
                    let path = workspace_path(original.as_ref())?;
                    let target = workspace_path(modified.as_ref())?;
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
