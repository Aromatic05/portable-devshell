//! Microsecond trace of the keystroke path across the pty boundary.
//!
//! `PSMUX_PTY_TRACE=<file>` turns it on; with the variable unset every probe is
//! one relaxed atomic load and returns immediately, so the shipped hot path is
//! unchanged. It exists to answer one question with bytes rather than
//! inference: of the time between psmux writing a keystroke into a pane's
//! ConPTY and the character reaching the attached client, how much is the shell
//! taking to produce the echo and how much is psmux's own.
//!
//! Timestamps are raw `QueryPerformanceCounter` ticks, which are system wide on
//! Windows, so a line written here can be compared directly against a
//! timestamp taken in another process (tests/keylat.cs uses `Stopwatch`, which
//! is the same counter). The header line records the frequency.
//!
//! Every process that has the variable set writes its own `<path>.<pid>`, so
//! the server's and the client's lines never interleave; merge and sort them by
//! the first column to get the whole path.
//!
//! Stages, in path order:
//!   `w`  the pane writer thread finished writing the key bytes to the ConPTY
//!   `r`  the pane reader thread returned from a read on the ConPTY
//!   `p`  the parser thread finished feeding a batch to vt100
//!   `s`  the server answered a dump-state request with a rendered frame
//!   `f`  the server pushed a rendered frame to the client slots
//!   `t`  the per client writer thread put a slot frame on the socket
//!   `c`  the client's socket reader thread read a whole frame line
//!   `d`  the client's main loop picked that frame up and will draw it
//!
//! Off the keystroke path, one stage answers "what is this process doing when it
//! should be doing nothing":
//!   `W`  a real `CreateToolhelp32Snapshot` walk of every process on the machine
//!        (9 to 11ms each). An idle server should produce none.
//!
//! What it was built to establish, and did: at an idle pwsh prompt the `w` to
//! `r` gap is ~15ms of PSReadLine that psmux cannot touch, while `p` to `d` is
//! psmux's own. See tests/conpty_echolat.cs for the same 15ms measured with no
//! psmux in the picture at all.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Mutex, OnceLock};

/// 0 = not looked up yet, 1 = on, 2 = off.
static GATE: AtomicU8 = AtomicU8::new(0);
static SINK: OnceLock<Option<Mutex<BufWriter<File>>>> = OnceLock::new();

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn QueryPerformanceCounter(out: *mut i64) -> i32;
    fn QueryPerformanceFrequency(out: *mut i64) -> i32;
}

#[cfg(windows)]
fn qpc() -> i64 {
    let mut v: i64 = 0;
    // SAFETY: writes one i64 through a valid pointer to a local.
    unsafe { QueryPerformanceCounter(&mut v) };
    v
}

#[cfg(windows)]
fn qpf() -> i64 {
    let mut v: i64 = 1;
    // SAFETY: writes one i64 through a valid pointer to a local.
    unsafe { QueryPerformanceFrequency(&mut v) };
    v
}

#[cfg(not(windows))]
fn qpc() -> i64 {
    0
}
#[cfg(not(windows))]
fn qpf() -> i64 {
    1
}

/// Whether tracing is on. One relaxed load in the steady state.
#[inline]
pub fn on() -> bool {
    match GATE.load(Ordering::Relaxed) {
        1 => true,
        2 => false,
        _ => {
            let want = std::env::var_os("PSMUX_PTY_TRACE").is_some();
            GATE.store(if want { 1 } else { 2 }, Ordering::Relaxed);
            want
        }
    }
}

fn sink() -> Option<&'static Mutex<BufWriter<File>>> {
    SINK.get_or_init(|| {
        let path = format!(
            "{}.{}",
            std::env::var("PSMUX_PTY_TRACE").ok()?,
            std::process::id()
        );
        let f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .ok()?;
        let mut w = BufWriter::new(f);
        let _ = writeln!(w, "# qpf {} pid {}", qpf(), std::process::id());
        let _ = w.flush();
        Some(Mutex::new(w))
    })
    .as_ref()
}

/// Render bytes so an escape heavy echo stays readable on one line.
fn escape(b: &[u8]) -> String {
    let mut s = String::with_capacity(b.len() * 2);
    for &c in b {
        match c {
            0x1b => s.push_str("<E>"),
            0x0d => s.push_str("<CR>"),
            0x0a => s.push_str("<LF>"),
            0x20..=0x7e => s.push(c as char),
            _ => s.push_str(&format!("<{:02X}>", c)),
        }
    }
    s
}

/// Record one stage. `bytes` is logged verbatim (escaped) up to 160 bytes,
/// which covers a keystroke echo whole and truncates a redraw.
pub fn mark(stage: &str, pane_id: usize, bytes: &[u8]) {
    if !on() {
        return;
    }
    let t = qpc();
    if let Some(m) = sink() {
        if let Ok(mut w) = m.lock() {
            let n = bytes.len();
            let shown = &bytes[..n.min(160)];
            let _ = writeln!(w, "{} {} {} {} {}", t, stage, pane_id, n, escape(shown));
            let _ = w.flush();
        }
    }
}

/// Record a stage that carries no payload.
pub fn mark_plain(stage: &str, pane_id: usize) {
    if !on() {
        return;
    }
    let t = qpc();
    if let Some(m) = sink() {
        if let Ok(mut w) = m.lock() {
            let _ = writeln!(w, "{} {} {} 0 -", t, stage, pane_id);
            let _ = w.flush();
        }
    }
}
