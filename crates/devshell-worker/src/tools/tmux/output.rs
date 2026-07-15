use super::warning;

use crate::tools::tmux::backend::BackendPane;
use crate::tools::tmux::types::TmuxWarning;

const MAX_UNREAD_LINES: usize = 400;

#[derive(Debug, Default, Clone)]
pub struct OutputWindow {
    pub anchor: Vec<String>,
    pub unread: Vec<String>,
}

pub fn refresh_window(
    window: &mut OutputWindow,
    pane: &BackendPane,
    warnings: &mut Vec<TmuxWarning>,
) {
    if pane.lines == window.anchor {
        return;
    }
    if let Some(lines) = changed_output(&window.anchor, &pane.lines) {
        append_unread(window, &lines, &pane.id, warnings);
        window.anchor = pane.lines.clone();
        return;
    }
    warnings.push(warning(
        Some(&pane.id),
        "tmux.windowResync",
        "terminal history changed outside the task output window; unread output was resynchronized",
    ));
    window.anchor = pane.lines.clone();
    window.unread.clear();
}

pub fn take_output(
    window: &mut OutputWindow,
    pane_id: &str,
    warnings: &mut Vec<TmuxWarning>,
    line: i64,
) -> Vec<String> {
    match line.cmp(&0) {
        std::cmp::Ordering::Equal => {
            window.unread.clear();
            Vec::new()
        }
        std::cmp::Ordering::Greater => {
            let count = line as usize;
            let output = window
                .unread
                .iter()
                .take(count)
                .cloned()
                .collect::<Vec<_>>();
            window.unread.drain(..output.len());
            output
        }
        std::cmp::Ordering::Less => {
            let keep = line.unsigned_abs() as usize;
            let split = window.unread.len().saturating_sub(keep);
            if split > 0 {
                warnings.push(warning(
                    Some(pane_id),
                    "tmux.outputSkipped",
                    "earlier unread task output was discarded; only the requested tail was returned",
                ));
            }
            let output = window
                .unread
                .iter()
                .skip(split)
                .cloned()
                .collect::<Vec<_>>();
            window.unread.clear();
            output
        }
    }
}

fn changed_output(anchor: &[String], current: &[String]) -> Option<Vec<String>> {
    if anchor.is_empty() {
        return Some(current.to_vec());
    }
    if current.is_empty() {
        return Some(Vec::new());
    }
    let overlap = suffix_prefix_overlap(anchor, current);
    if overlap > 0 && overlap < current.len() {
        return Some(current[overlap..].to_vec());
    }
    let prefix = anchor
        .iter()
        .zip(current)
        .take_while(|(left, right)| left == right)
        .count();
    let max_suffix = anchor.len().min(current.len()).saturating_sub(prefix);
    let suffix = (1..=max_suffix)
        .rev()
        .find(|length| anchor[anchor.len() - length..] == current[current.len() - length..])
        .unwrap_or(0);
    if prefix == 0 && suffix == 0 {
        if current[0].starts_with(&anchor[0]) {
            let mut output = Vec::new();
            let suffix = &current[0][anchor[0].len()..];
            if !suffix.is_empty() {
                output.push(suffix.to_string());
            }
            output.extend(current.iter().skip(1).cloned());
            return Some(output);
        }
        return None;
    }
    let changed_end = current.len().saturating_sub(suffix);
    let mut output = current[prefix..changed_end].to_vec();
    if prefix < anchor.len() && !output.is_empty() && output[0].starts_with(&anchor[prefix]) {
        let remainder = output[0][anchor[prefix].len()..].to_string();
        if remainder.is_empty() {
            output.remove(0);
        } else {
            output[0] = remainder;
        }
    }
    Some(output)
}

fn suffix_prefix_overlap(anchor: &[String], current: &[String]) -> usize {
    let max = anchor.len().min(current.len());
    (1..=max)
        .rev()
        .find(|length| anchor[anchor.len() - length..] == current[..*length])
        .unwrap_or(0)
}

fn append_unread(
    window: &mut OutputWindow,
    lines: &[String],
    pane_id: &str,
    warnings: &mut Vec<TmuxWarning>,
) {
    window.unread.extend(lines.iter().cloned());
    let excess = window.unread.len().saturating_sub(MAX_UNREAD_LINES);
    if excess > 0 {
        window.unread.drain(..excess);
        warnings.push(warning(
            Some(pane_id),
            "tmux.outputDropped",
            "oldest unread task output was dropped to keep the output window bounded",
        ));
    }
}
#[cfg(test)]
mod tests {
    use super::changed_output;

    fn lines(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn changed_output_extracts_command_output_between_multiline_prompts() {
        let anchor = lines(&["startup", "prompt-top", "prompt-bottom"]);
        let current = lines(&[
            "startup",
            "command",
            "REAL-OK",
            "prompt-top",
            "prompt-bottom",
        ]);
        assert_eq!(
            changed_output(&anchor, &current),
            Some(lines(&["command", "REAL-OK"]))
        );
    }

    #[test]
    fn changed_output_follows_a_scrolling_history_window() {
        let anchor = lines(&["old", "shared-one", "shared-two"]);
        let current = lines(&["shared-one", "shared-two", "new"]);
        assert_eq!(changed_output(&anchor, &current), Some(lines(&["new"])));
    }
}
