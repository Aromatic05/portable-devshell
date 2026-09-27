//! The single place that decides how many columns a codepoint occupies.
//!
//! Every width decision in psmux -- the emulator's wide/continuation cell
//! logic, `capture-pane`, the renderer, the status line and the layout
//! measurements -- routes through [`char_width`] / [`str_width`] here, so a
//! `codepoint-widths` override cannot be honoured in one place and ignored in
//! another. A disagreement between two width call sites is exactly how cells
//! get stranded on screen (issue #639), so there is deliberately no second
//! opinion available.
//!
//! # `codepoint-widths`
//!
//! tmux exposes the same escape hatch as a server option (`options-table.c`,
//! `OPTIONS_TABLE_IS_ARRAY` with a `,` separator) parsed by
//! `utf8_add_to_width_cache` in `utf8.c` and applied by `utf8_width`. This
//! module mirrors that parser entry for entry; see
//! [`parse_entry`] for the accepted syntax.
//!
//! The override table is process global, matching tmux's own global
//! `utf8_width_cache`, and is rebuilt wholesale whenever the option changes
//! (tmux's `utf8_update_width_cache`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::RwLock;

/// Number of entries currently in the override table.
///
/// This is the hot path gate. `codepoint-widths` is empty for essentially
/// every user, so the common case must not pay for a lock: a single relaxed
/// atomic load of zero short circuits straight to `unicode-width`.
static OVERRIDE_COUNT: AtomicUsize = AtomicUsize::new(0);

/// Codepoint -> column count. Only consulted when `OVERRIDE_COUNT` is nonzero.
static OVERRIDES: RwLock<Option<HashMap<u32, u8>>> = RwLock::new(None);

/// The largest width tmux will accept for an override (`strtonum(cp, 0, 2)`).
pub const MAX_OVERRIDE_WIDTH: u8 = 2;

/// A parsed `codepoint-widths` entry: an inclusive codepoint range and the
/// width every codepoint in it should report.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WidthOverride {
    /// First codepoint of the range (inclusive).
    pub start: u32,
    /// Last codepoint of the range (inclusive); equal to `start` for a single
    /// codepoint entry.
    pub end: u32,
    /// Columns the range should occupy: 0, 1 or 2.
    pub width: u8,
}

/// Parse one `codepoint-widths` array entry, matching tmux's
/// `utf8_add_to_width_cache` (`utf8.c`) exactly.
///
/// Accepted forms, all requiring a literal `=` before the width:
///
/// - `U+XXXX=N` -- a single codepoint written in hex. The `U+` prefix is
///   mandatory for the hex form and the hex digits must be the whole of the
///   rest of the token.
/// - `U+XXXX-U+YYYY=N` -- an inclusive range. tmux requires the `U+` prefix on
///   BOTH ends (`strncmp(endptr, "U+", 2) != 0` rejects `U+3000-3002`) and
///   rejects a range whose end is below its start.
/// - `<char>=N` -- a single literal character, e.g. `字=2`. tmux takes this
///   branch whenever the token does not start with `U+`, and rejects it unless
///   it decodes to exactly one codepoint.
///
/// `N` is validated with `strtonum(cp, 0, 2)`, so the only legal widths are
/// **0, 1 and 2**; anything else (including a negative number or trailing
/// junk) makes tmux drop the entry silently.
///
/// A codepoint of zero is rejected (tmux tests `n == 0`), as is one above the
/// Unicode maximum. Returns `None` for every malformed entry rather than
/// erroring, because tmux discards bad entries without complaint.
#[must_use]
pub fn parse_entry(entry: &str) -> Option<WidthOverride> {
    // tmux splits on the FIRST '=' (strchr), so a literal '=' character can be
    // given a width via "==1".
    let split = entry.find('=')?;
    let (spec, width_str) = (&entry[..split], &entry[split + 1..]);

    // strtonum(cp, 0, 2, &errstr): the whole token must be an integer in
    // 0..=2. tmux's strtonum is `strtoll` plus a `*ep != '\0'` check
    // (compat/strtonum.c:52), so it accepts what strtoll accepts at the FRONT
    // -- leading whitespace and a leading '+' -- but rejects any trailing
    // text. A negative value parses and is then refused by the `< minval`
    // bound. Rust's `u8::from_str` already accepts a leading '+' and rejects
    // trailing text and negatives, so only the leading whitespace needs
    // matching explicitly.
    let width: u8 = width_str.trim_start().parse().ok()?;
    if width > MAX_OVERRIDE_WIDTH {
        return None;
    }

    if let Some(hex) = spec.strip_prefix("U+") {
        // Range form: split on the '-' that separates the two U+ tokens.
        let (start_hex, end_hex) = match hex.find('-') {
            Some(dash) => {
                // tmux requires the second half to carry its own "U+".
                let rest = hex[dash + 1..].strip_prefix("U+")?;
                (&hex[..dash], Some(rest))
            }
            None => (hex, None),
        };
        let start = parse_codepoint(start_hex)?;
        let end = match end_hex {
            Some(e) => parse_codepoint(e)?,
            None => start,
        };
        // tmux: `(wchar_t)n < wc_start` rejects a descending range.
        if end < start {
            return None;
        }
        Some(WidthOverride { start, end, width })
    } else {
        // Literal character form: must be exactly one codepoint.
        let mut chars = spec.chars();
        let c = chars.next()?;
        if chars.next().is_some() {
            return None;
        }
        let cp = c as u32;
        // tmux rejects a zero codepoint on the hex path; a literal NUL can
        // never appear in an option string, so this only guards the parser.
        if cp == 0 {
            return None;
        }
        Some(WidthOverride {
            start: cp,
            end: cp,
            width,
        })
    }
}

/// Parse the hex digits of a `U+XXXX` token.
fn parse_codepoint(hex: &str) -> Option<u32> {
    if hex.is_empty() {
        return None;
    }
    // tmux uses strtoull, which accepts a leading '+'/'-' and whitespace; the
    // surrounding checks then reject the result. Rust's from_str_radix accepts
    // a leading '+' too, so exclude sign characters explicitly to keep
    // "U+-1=2" from parsing.
    if !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let n = u32::from_str_radix(hex, 16).ok()?;
    // tmux: `n == 0 || n > WCHAR_MAX`. Rust chars top out at U+10FFFF, and a
    // surrogate is not a valid char, but the table is keyed by u32 so a
    // surrogate simply never matches anything.
    if n == 0 || n > 0x0010_FFFF {
        return None;
    }
    Some(n)
}

/// Rebuild the process global override table from the option's array entries.
///
/// This is tmux's `utf8_update_width_cache`, which `options.c` calls from the
/// option-changed hook so a live `set -s codepoint-widths ...` takes effect on
/// the next character drawn rather than at the next server start. Malformed
/// entries are dropped individually; a later entry wins over an earlier one
/// for the same codepoint, matching tmux's `utf8_insert_width_cache` replacing
/// the existing tree node.
pub fn set_codepoint_widths<S: AsRef<str>>(entries: &[S]) {
    let mut table: HashMap<u32, u8> = HashMap::new();
    for entry in entries {
        let entry = entry.as_ref().trim();
        if entry.is_empty() {
            continue;
        }
        let Some(WidthOverride { start, end, width }) = parse_entry(entry) else {
            continue;
        };
        for cp in start..=end {
            table.insert(cp, width);
        }
    }

    let count = table.len();
    if let Ok(mut guard) = OVERRIDES.write() {
        *guard = if count == 0 { None } else { Some(table) };
        // Publish the count only once the table is in place, and while still
        // holding the write lock, so a reader that sees a nonzero count is
        // guaranteed to find the table behind it.
        OVERRIDE_COUNT.store(count, Ordering::Release);
    }
}

/// Drop every override, restoring pure `unicode-width` behaviour.
pub fn clear_codepoint_widths() {
    set_codepoint_widths::<&str>(&[]);
}

/// True when at least one override is active. Cheap enough for a debug path.
#[must_use]
pub fn has_overrides() -> bool {
    OVERRIDE_COUNT.load(Ordering::Acquire) != 0
}

/// Look up an active override for `c`, if any.
#[must_use]
fn override_for(c: char) -> Option<u8> {
    // Fast path: no overrides configured, so never touch the lock.
    if OVERRIDE_COUNT.load(Ordering::Acquire) == 0 {
        return None;
    }
    let guard = OVERRIDES.read().ok()?;
    guard.as_ref()?.get(&(c as u32)).copied()
}

/// Columns `c` occupies, honouring `codepoint-widths`.
///
/// This is the shared replacement for `UnicodeWidthChar::width`. `None` keeps
/// unicode-width's meaning: `c` is a control character with no width at all,
/// which callers handle differently from a zero width combining mark. An
/// override always produces `Some`, since an explicit `=0` is a deliberate
/// zero width rather than "not printable".
///
/// tmux's default ambiguous-width resolution is 1 and psmux matches it; this
/// function does NOT change that. The override is opt in and empty by default.
#[must_use]
pub fn char_width(c: char) -> Option<usize> {
    if let Some(w) = override_for(c) {
        return Some(usize::from(w));
    }
    unicode_width::UnicodeWidthChar::width(c)
}

/// Columns `s` occupies, honouring `codepoint-widths`.
///
/// The shared replacement for `UnicodeWidthStr::width`. With no overrides
/// active this delegates to `unicode-width` so grapheme handling is
/// byte-for-byte what it was before; only once an override exists does it fall
/// back to summing per character, which is the granularity the option works at.
#[must_use]
pub fn str_width(s: &str) -> usize {
    if OVERRIDE_COUNT.load(Ordering::Acquire) == 0 {
        return unicode_width::UnicodeWidthStr::width(s);
    }
    s.chars().map(|c| char_width(c).unwrap_or(0)).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_single_hex_codepoint() {
        assert_eq!(
            parse_entry("U+3000=2"),
            Some(WidthOverride {
                start: 0x3000,
                end: 0x3000,
                width: 2
            })
        );
    }

    #[test]
    fn parses_inclusive_range() {
        assert_eq!(
            parse_entry("U+2500-U+2502=2"),
            Some(WidthOverride {
                start: 0x2500,
                end: 0x2502,
                width: 2
            })
        );
    }

    #[test]
    fn parses_literal_character() {
        assert_eq!(
            parse_entry("\u{2502}=2"),
            Some(WidthOverride {
                start: 0x2502,
                end: 0x2502,
                width: 2
            })
        );
    }

    #[test]
    fn rejects_malformed_entries() {
        // tmux drops each of these silently.
        assert_eq!(parse_entry("U+3000"), None, "no '=' separator");
        assert_eq!(parse_entry("U+3000=3"), None, "width above 2");
        assert_eq!(parse_entry("U+3000=-1"), None, "negative width");
        assert_eq!(parse_entry("U+0=1"), None, "zero codepoint");
        assert_eq!(parse_entry("U+ZZZZ=1"), None, "non hex digits");
        assert_eq!(parse_entry("U+=1"), None, "empty hex");
        assert_eq!(parse_entry("U+2502-2504=2"), None, "range end lacks U+");
        assert_eq!(parse_entry("U+2504-U+2500=2"), None, "descending range");
        assert_eq!(parse_entry("ab=2"), None, "more than one literal char");
        assert_eq!(parse_entry("U+110000=1"), None, "above Unicode max");
    }

    #[test]
    fn accepts_every_legal_width() {
        for w in 0..=MAX_OVERRIDE_WIDTH {
            assert_eq!(
                parse_entry(&format!("U+3000={w}")).map(|o| o.width),
                Some(w)
            );
        }
    }
}
