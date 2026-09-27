//! Env gated timing trace for the warm pane pool.
//!
//! Creating a window, a split or a session is supposed to be instant because a
//! spare shell is already running. When it is not instant the question is
//! always the same: was the pool empty, or did the claim get a spare that had
//! itself only just been spawned and had not finished booting yet? Guessing at
//! that from the outside is impossible because both look identical to the user.
//!
//! Enable with `PSMUX_WARM_TRACE=1`. Lines are appended to
//! `%TEMP%\psmux_warm_trace.log` (override with `PSMUX_WARM_TRACE_FILE`) and
//! carry a monotonic millisecond stamp measured from the first trace call in
//! the process, so a burst reads as a timeline rather than as wall clock noise.
//!
//! Everything here is inert unless the variable is set: `enabled()` caches the
//! lookup in an atomic so the hot server loop pays one relaxed load per tick.

use std::sync::atomic::{AtomicU8, Ordering};
use std::time::Instant;

static ENABLED: AtomicU8 = AtomicU8::new(0); // 0 = unknown, 1 = off, 2 = on

/// Is tracing on? Cached after the first call.
pub fn enabled() -> bool {
    match ENABLED.load(Ordering::Relaxed) {
        1 => false,
        2 => true,
        _ => {
            let on = std::env::var("PSMUX_WARM_TRACE")
                .map(|v| v == "1" || v == "true")
                .unwrap_or(false);
            ENABLED.store(if on { 2 } else { 1 }, Ordering::Relaxed);
            on
        }
    }
}

fn origin() -> Instant {
    use std::sync::OnceLock;
    static ORIGIN: OnceLock<Instant> = OnceLock::new();
    *ORIGIN.get_or_init(Instant::now)
}

/// Append one trace line. Callers should guard with [`enabled`] when building
/// the message costs anything.
pub fn log(msg: &str) {
    if !enabled() {
        return;
    }
    let t = origin().elapsed().as_micros() as f64 / 1000.0;
    let path = std::env::var("PSMUX_WARM_TRACE_FILE").unwrap_or_else(|_| {
        let tmp = std::env::var("TEMP")
            .or_else(|_| std::env::var("TMP"))
            .unwrap_or_else(|_| ".".to_string());
        format!("{}\\psmux_warm_trace.log", tmp)
    });
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = std::io::Write::write_all(
            &mut f,
            format!("[{:>10.3} pid={}] {}\n", t, std::process::id(), msg).as_bytes(),
        );
    }
}

/// `log` for messages that need formatting: the `format!` is skipped entirely
/// when tracing is off.
#[macro_export]
macro_rules! warm_trace {
    ($($arg:tt)*) => {
        if $crate::warm_trace::enabled() {
            $crate::warm_trace::log(&format!($($arg)*));
        }
    };
}
