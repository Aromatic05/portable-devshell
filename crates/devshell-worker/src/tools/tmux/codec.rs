use crate::tools::ToolError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TmuxInputChunk {
    Literal(String),
    Key(&'static str),
}

pub fn decode_caret_input(input: &str) -> String {
    let chars = input.chars().collect::<Vec<_>>();
    let mut out = String::new();
    let mut index = 0_usize;
    while index < chars.len() {
        if chars[index] != '^' || index + 1 >= chars.len() {
            out.push(chars[index]);
            index += 1;
            continue;
        }

        let next = chars[index + 1];
        let decoded = match next {
            '@' => Some('\u{0000}'),
            'M' | 'm' => Some('\n'),
            '[' => Some('\u{001b}'),
            '\\' => Some('\u{001c}'),
            ']' => Some('\u{001d}'),
            '?' => Some('\u{007f}'),
            '^' => Some('^'),
            'A'..='Z' => Some(((next as u8) - b'A' + 1) as char),
            'a'..='z' => Some(((next as u8) - b'a' + 1) as char),
            _ => None,
        };

        if let Some(ch) = decoded {
            out.push(ch);
            index += 2;
        } else {
            out.push('^');
            out.push(next);
            index += 2;
        }
    }
    out
}

pub fn contains_tmux_prefix_input(input: &str) -> bool {
    decode_caret_input(input).contains('\u{0002}')
}

pub fn parse_tmux_input(input: &str) -> Result<Vec<TmuxInputChunk>, ToolError> {
    let decoded = decode_caret_input(input);
    let mut out = Vec::new();
    let mut literal = String::new();

    for ch in decoded.chars() {
        let special = match ch {
            '\u{0000}' => {
                return Err(ToolError::new(
                    "tmux.invalidInput",
                    "NUL input (^@) is not supported by the tmux backend",
                ));
            }
            '\n' => Some("Enter"),
            '\u{0001}' => Some("C-a"),
            '\u{0002}' => Some("C-b"),
            '\u{0003}' => Some("C-c"),
            '\u{0004}' => Some("C-d"),
            '\u{0005}' => Some("C-e"),
            '\u{0006}' => Some("C-f"),
            '\u{0007}' => Some("C-g"),
            '\u{0008}' => Some("C-h"),
            '\u{0009}' => Some("Tab"),
            '\u{000b}' => Some("C-k"),
            '\u{000c}' => Some("C-l"),
            '\u{000d}' => Some("Enter"),
            '\u{000e}' => Some("C-n"),
            '\u{000f}' => Some("C-o"),
            '\u{0010}' => Some("C-p"),
            '\u{0011}' => Some("C-q"),
            '\u{0012}' => Some("C-r"),
            '\u{0013}' => Some("C-s"),
            '\u{0014}' => Some("C-t"),
            '\u{0015}' => Some("C-u"),
            '\u{0016}' => Some("C-v"),
            '\u{0017}' => Some("C-w"),
            '\u{0018}' => Some("C-x"),
            '\u{0019}' => Some("C-y"),
            '\u{001a}' => Some("C-z"),
            '\u{001b}' => Some("Escape"),
            '\u{001c}' => Some("C-\\"),
            '\u{001d}' => Some("C-]"),
            '\u{007f}' => Some("BSpace"),
            _ => None,
        };

        if let Some(key) = special {
            if !literal.is_empty() {
                out.push(TmuxInputChunk::Literal(std::mem::take(&mut literal)));
            }
            out.push(TmuxInputChunk::Key(key));
        } else {
            literal.push(ch);
        }
    }

    if !literal.is_empty() {
        out.push(TmuxInputChunk::Literal(literal));
    }
    Ok(out)
}

pub fn sanitize_terminal_output(raw: &str) -> String {
    let normalized = raw.replace("\r\n", "\n");
    let chars = normalized.chars().collect::<Vec<_>>();
    let mut out = String::new();
    let mut line = String::new();
    let mut cursor = 0_usize;
    let mut index = 0_usize;

    while index < chars.len() {
        match chars[index] {
            '\x1b' => index = skip_escape_sequence(&chars, index + 1),
            '\r' => {
                cursor = 0;
                index += 1;
            }
            '\n' => {
                out.push_str(&line);
                out.push('\n');
                line.clear();
                cursor = 0;
                index += 1;
            }
            '\t' => {
                write_visible_char(&mut line, &mut cursor, '\t');
                index += 1;
            }
            ch if !ch.is_control() => {
                write_visible_char(&mut line, &mut cursor, ch);
                index += 1;
            }
            _ => index += 1,
        }
    }
    out.push_str(&line);
    out
}

fn write_visible_char(line: &mut String, cursor: &mut usize, ch: char) {
    if *cursor >= line.chars().count() {
        line.push(ch);
    } else {
        let mut chars = line.chars().collect::<Vec<_>>();
        chars[*cursor] = ch;
        *line = chars.into_iter().collect();
    }
    *cursor += 1;
}

fn skip_escape_sequence(chars: &[char], mut index: usize) -> usize {
    if index >= chars.len() {
        return index;
    }
    match chars[index] {
        '[' => {
            index += 1;
            while index < chars.len() {
                let ch = chars[index];
                if ('@'..='~').contains(&ch) {
                    return index + 1;
                }
                index += 1;
            }
            index
        }
        ']' | 'P' | '^' | '_' => skip_string_escape(chars, index + 1),
        _ => index + 1,
    }
}

fn skip_string_escape(chars: &[char], mut index: usize) -> usize {
    while index < chars.len() {
        match chars[index] {
            '\u{0007}' => return index + 1,
            '\x1b' if index + 1 < chars.len() && chars[index + 1] == '\\' => return index + 2,
            _ => index += 1,
        }
    }
    index
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caret_notation_is_generic_terminal_input() {
        assert_eq!(decode_caret_input("echo hi^M"), "echo hi\n");
        assert_eq!(decode_caret_input("^C^D^I"), "\u{0003}\u{0004}\u{0009}");
        assert_eq!(decode_caret_input("^^"), "^");
        assert!(contains_tmux_prefix_input("^B"));
        assert!(!contains_tmux_prefix_input("^C"));
    }
}
