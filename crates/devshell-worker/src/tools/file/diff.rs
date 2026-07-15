use diffy::{create_patch, merge};

use crate::tools::ToolError;

pub fn render(before: &str, after: &str) -> String {
    create_patch(before, after).to_string()
}

pub fn merge_changes(original: &str, current: &str, expected: &str) -> Result<String, ToolError> {
    merge(original, current, expected).map_err(|_| {
        ToolError::retryable(
            "file.revisionMismatch",
            "snapshot changes conflict with the current file",
        )
    })
}

#[cfg(test)]
mod tests {
    use super::merge_changes;

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
}
