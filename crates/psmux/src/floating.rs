//! Floating-pane geometry: position keywords, movement, and clamping.
//!
//! Pure helpers for the tmux `new-pane` floating-pane feature. The PTY-backed
//! pane itself is created via `popup::create_popup_pane` (floats reuse the full
//! pane infrastructure); this module owns only the placement math so it can be
//! unit tested in isolation, mirroring `border_lines` / `copy_line_numbers`.
//!
//! Coordinates are content-area cells: `(x, y)` is the float's top-left, `(w, h)`
//! its outer size including the 1-cell border. `win_w`/`win_h` are the window
//! content dimensions the float must stay inside.

/// A directional move step for `-U`/`-D`/`-L`/`-R`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MoveDir { Up, Down, Left, Right }

impl MoveDir {
    pub fn parse(flag: &str) -> Option<MoveDir> {
        match flag {
            "-U" => Some(MoveDir::Up),
            "-D" => Some(MoveDir::Down),
            "-L" => Some(MoveDir::Left),
            "-R" => Some(MoveDir::Right),
            _ => None,
        }
    }
}

/// Recognised `-P` position keywords (tmux-style corner/edge/centre anchors).
pub const POSITIONS: &[&str] = &[
    "top-left", "top-right", "bottom-left", "bottom-right",
    "top", "bottom", "left", "right", "centre", "center",
];

/// Resolve a `-P` position keyword to a top-left `(x, y)` for a `w`x`h` float
/// inside a `win_w`x`win_h` content area. Unknown keywords centre the float.
pub fn resolve_position(pos: &str, win_w: u16, win_h: u16, w: u16, h: u16) -> (u16, u16) {
    let max_x = win_w.saturating_sub(w);
    let max_y = win_h.saturating_sub(h);
    let cx = max_x / 2;
    let cy = max_y / 2;
    match pos.trim().to_ascii_lowercase().as_str() {
        "top-left"     => (0, 0),
        "top-right"    => (max_x, 0),
        "bottom-left"  => (0, max_y),
        "bottom-right" => (max_x, max_y),
        "top"          => (cx, 0),
        "bottom"       => (cx, max_y),
        "left"         => (0, cy),
        "right"        => (max_x, cy),
        // "centre", "center", and anything unrecognised.
        _              => (cx, cy),
    }
}

/// Clamp a float so it stays fully within the `win_w`x`win_h` content area.
/// If the float is larger than the area, it is pinned to the top-left.
pub fn clamp_into(x: u16, y: u16, w: u16, h: u16, win_w: u16, win_h: u16) -> (u16, u16) {
    let max_x = win_w.saturating_sub(w);
    let max_y = win_h.saturating_sub(h);
    (x.min(max_x), y.min(max_y))
}

/// Apply a directional step of `step` cells to `(x, y)`, then clamp into bounds.
pub fn move_step(dir: MoveDir, x: u16, y: u16, w: u16, h: u16, win_w: u16, win_h: u16, step: u16) -> (u16, u16) {
    let (nx, ny) = match dir {
        MoveDir::Up    => (x, y.saturating_sub(step)),
        MoveDir::Down  => (x, y.saturating_add(step)),
        MoveDir::Left  => (x.saturating_sub(step), y),
        MoveDir::Right => (x.saturating_add(step), y),
    };
    clamp_into(nx, ny, w, h, win_w, win_h)
}

/// Default floating-pane outer size when `-w`/`-h` are omitted: a proportion of
/// the window, clamped to sane minimums (tmux defaults popups to ~half-ish).
pub fn default_size(win_w: u16, win_h: u16) -> (u16, u16) {
    let w = ((win_w as u32 * 3 / 4) as u16).clamp(10, win_w.max(10));
    let h = ((win_h as u32 * 3 / 4) as u16).clamp(4, win_h.max(4));
    (w, h)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn corners_anchor_correctly() {
        // 100x30 window, 40x10 float.
        assert_eq!(resolve_position("top-left", 100, 30, 40, 10), (0, 0));
        assert_eq!(resolve_position("top-right", 100, 30, 40, 10), (60, 0));
        assert_eq!(resolve_position("bottom-left", 100, 30, 40, 10), (0, 20));
        assert_eq!(resolve_position("bottom-right", 100, 30, 40, 10), (60, 20));
    }

    #[test]
    fn centre_and_edges() {
        assert_eq!(resolve_position("centre", 100, 30, 40, 10), (30, 10));
        assert_eq!(resolve_position("center", 100, 30, 40, 10), (30, 10));
        assert_eq!(resolve_position("top", 100, 30, 40, 10), (30, 0));
        assert_eq!(resolve_position("bottom", 100, 30, 40, 10), (30, 20));
        assert_eq!(resolve_position("left", 100, 30, 40, 10), (0, 10));
        assert_eq!(resolve_position("right", 100, 30, 40, 10), (60, 10));
        // Unknown -> centre.
        assert_eq!(resolve_position("bogus", 100, 30, 40, 10), (30, 10));
    }

    #[test]
    fn oversized_float_pins_top_left() {
        assert_eq!(resolve_position("bottom-right", 20, 10, 40, 20), (0, 0));
        assert_eq!(clamp_into(50, 50, 40, 20, 20, 10), (0, 0));
    }

    #[test]
    fn move_steps_and_clamp() {
        // Move up from y=5 by 2 -> y=3.
        assert_eq!(move_step(MoveDir::Up, 10, 5, 40, 10, 100, 30, 2), (10, 3));
        // Move up past the top clamps to 0.
        assert_eq!(move_step(MoveDir::Up, 10, 1, 40, 10, 100, 30, 5), (10, 0));
        // Move right past the edge clamps to max_x = 60.
        assert_eq!(move_step(MoveDir::Right, 55, 5, 40, 10, 100, 30, 20), (60, 5));
        // Move down past the bottom clamps to max_y = 20.
        assert_eq!(move_step(MoveDir::Down, 10, 18, 40, 10, 100, 30, 10), (10, 20));
    }

    #[test]
    fn parse_move_dirs() {
        assert_eq!(MoveDir::parse("-U"), Some(MoveDir::Up));
        assert_eq!(MoveDir::parse("-D"), Some(MoveDir::Down));
        assert_eq!(MoveDir::parse("-L"), Some(MoveDir::Left));
        assert_eq!(MoveDir::parse("-R"), Some(MoveDir::Right));
        assert_eq!(MoveDir::parse("-x"), None);
    }

    #[test]
    fn default_size_is_bounded() {
        let (w, h) = default_size(100, 30);
        assert!(w >= 10 && w <= 100 && h >= 4 && h <= 30);
        // Tiny window still yields the minimums.
        let (w2, h2) = default_size(8, 3);
        assert!(w2 >= 10 && h2 >= 4);
    }
}
