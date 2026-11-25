//! The server-side screen follows exactly the same output sequence as the
//! process journal. This is a visible-screen snapshot, not a serialization
//! of the terminal parser or the hidden primary/alternate buffer.

use std::num::NonZeroU16;

use serde::Serialize;

use crate::capability::rpc::error::RpcError;

pub(super) struct TerminalScreen {
    parser: vt100::Parser,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ScreenSnapshot {
    pub seq: u64,
    pub rows: u16,
    pub cols: u16,
    pub cursor_row: u16,
    pub cursor_col: u16,
    pub alternate_screen: bool,
    pub text: String,
    pub formatted: String,
}

impl TerminalScreen {
    pub fn new(cols: u16, rows: u16) -> Result<Self, RpcError> {
        let (rows, cols) = dimensions(cols, rows)?;
        Ok(Self {
            // The journal already owns the output history; keep only the
            // terminal's visible screen and its native alternate grid here.
            parser: vt100::Parser::new(rows, cols, 0),
        })
    }

    pub fn process(&mut self, bytes: &[u8]) {
        self.parser.process(bytes);
    }

    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<(), RpcError> {
        let (rows, cols) = dimensions(cols, rows)?;
        self.parser.set_size(rows, cols);
        Ok(())
    }

    pub fn snapshot(&self, seq: u64) -> ScreenSnapshot {
        let screen = self.parser.screen();
        let (rows, cols) = screen.size();
        let (cursor_row, cursor_col) = screen.cursor_position();
        ScreenSnapshot {
            seq,
            rows: rows.get(),
            cols: cols.get(),
            cursor_row,
            cursor_col,
            alternate_screen: screen.alternate_screen(),
            text: screen.contents(),
            formatted: screen.state_formatted(),
        }
    }
}

fn dimensions(cols: u16, rows: u16) -> Result<(NonZeroU16, NonZeroU16), RpcError> {
    let rows = NonZeroU16::new(rows)
        .ok_or_else(|| RpcError::new("rpc.invalidParams", "terminal rows must be positive"))?;
    let cols = NonZeroU16::new(cols)
        .ok_or_else(|| RpcError::new("rpc.invalidParams", "terminal columns must be positive"))?;
    Ok((rows, cols))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn screen_tracks_visible_grid_cursor_and_alternate_buffer() {
        let mut screen = TerminalScreen::new(80, 24).unwrap();
        screen.process(b"primary\x1b[?1049h\x1b[2J\x1b[H\x1b[31mALT\x1b[0m\x1b[3;4H");
        let alternate = screen.snapshot(1);
        assert!(alternate.alternate_screen);
        assert_eq!(alternate.text.trim(), "ALT");
        assert_eq!((alternate.cursor_row, alternate.cursor_col), (2, 3));

        let mut viewport = TerminalScreen::new(80, 24).unwrap();
        viewport.process(alternate.formatted.as_bytes());
        let rendered = viewport.snapshot(1);
        assert_eq!(rendered.text, alternate.text);
        assert_eq!((rendered.cursor_row, rendered.cursor_col), (2, 3));
        assert_eq!(
            viewport.parser.screen().cell(0, 0).unwrap().fgcolor(),
            vt100::Color::Idx(1)
        );

        screen.process(b"\x1b[?1049l");
        let primary = screen.snapshot(2);
        assert!(!primary.alternate_screen);
        assert_eq!(primary.text.trim(), "primary");
        screen.resize(100, 40).unwrap();
        let resized = screen.snapshot(2);
        assert_eq!((resized.cols, resized.rows), (100, 40));
        assert_eq!(resized.seq, 2);
    }
}
