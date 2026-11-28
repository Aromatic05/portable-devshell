use std::collections::BTreeSet;

use diffy::{DiffOptions, create_patch, merge};

use super::remap_seen_lines;

use crate::tool::ToolError;

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

/// After merging an external revision, generated lines are still known only
/// where they survive the merge unchanged. New external content is not coverage.
pub(in crate::tool::file::edit) fn rebase_generated_coverage(
    expected: &str,
    merged: &str,
    known: &BTreeSet<usize>,
) -> BTreeSet<usize> {
    let patch = DiffOptions::new()
        .set_context_len(0)
        .create_patch(expected, merged);
    let edits = patch
        .hunks()
        .iter()
        .map(|hunk| {
            let old = hunk.old_range();
            let position = if old.is_empty() {
                old.start()
            } else {
                old.start() - 1
            };
            (position, old.len(), hunk.new_range().len())
        })
        .collect::<Vec<_>>();
    remap_seen_lines(&BTreeSet::new(), &edits, known)
}

#[cfg(test)]
mod tests {
    use super::merge_changes;

    #[test]
    fn generated_coverage_follows_merged_content_not_original_offsets() {
        use super::rebase_generated_coverage;
        use std::collections::BTreeSet;

        let expected = "a\nnew\nb\n";
        let merged = "external\na\nnew\nb\n";
        assert_eq!(
            rebase_generated_coverage(expected, merged, &BTreeSet::from([2])),
            BTreeSet::from([3])
        );
        assert_eq!(
            rebase_generated_coverage(expected, "a\nexternal\nb\n", &BTreeSet::from([2])),
            BTreeSet::new()
        );
    }

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
