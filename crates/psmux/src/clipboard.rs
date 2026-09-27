//! Windows system clipboard read/write.
//!
//! The Win32 clipboard helpers live in their own module so that any code
//! that needs to interact with the user's clipboard - the server-side copy
//! mode UI, the client-side `load-buffer -w` path, the `iterm-cc-compat`
//! paste integration - can call them without dragging in the rest of
//! `copy_mode`.
//!
//! On non-Windows targets the functions are no-ops returning empty / `None`
//! so callers don't need their own `#[cfg]` gates.

#[cfg(windows)]
use std::thread;
#[cfg(windows)]
use std::time::Duration;
#[cfg(windows)]
use windows_sys::Win32::Foundation::GlobalFree;
#[cfg(windows)]
use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, OpenClipboard, SetClipboardData,
};
#[cfg(windows)]
use windows_sys::Win32::System::Memory::{
    GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE,
};

/// Write `text` to the Windows system clipboard as CF_UNICODETEXT.
///
/// Other processes may briefly hold the clipboard open, so this retries a
/// few times before giving up. Failure semantics, matching real tmux's
/// permissive behavior for `load-buffer -w` / `set-buffer -w`:
///
/// * If `GlobalAlloc` / `GlobalLock` / `OpenClipboard` / `EmptyClipboard`
///   fails, the user's existing clipboard contents are left untouched.
/// * There is a narrow inherent race between `EmptyClipboard` and
///   `SetClipboardData`: if `SetClipboardData` fails after `EmptyClipboard`
///   has already succeeded, the clipboard is left empty. The Win32
///   clipboard API offers no atomic "replace" primitive, so this window
///   cannot be closed entirely.
#[cfg(windows)]
pub fn copy_to_system_clipboard(text: &str) {
    const CF_UNICODETEXT: u32 = 13;

    // Prepare the HGLOBAL BEFORE touching the clipboard. If allocation or
    // locking fails the user's existing clipboard is untouched, and we
    // hold the global clipboard lock for the shortest possible window.
    let mut utf16: Vec<u16> = text.encode_utf16().collect();
    utf16.push(0); // null terminator required by CF_UNICODETEXT
    let size_bytes = utf16.len() * std::mem::size_of::<u16>();

    let hmem = unsafe { GlobalAlloc(GMEM_MOVEABLE, size_bytes) };
    if hmem.is_null() {
        return;
    }

    unsafe {
        let dst = GlobalLock(hmem) as *mut u16;
        if dst.is_null() {
            let _ = GlobalFree(hmem);
            return;
        }
        std::ptr::copy_nonoverlapping(utf16.as_ptr(), dst, utf16.len());
        GlobalUnlock(hmem);
    }

    // Buffer is ready. Open the clipboard only for the minimal Win32 dance.
    // Other processes can briefly hold the clipboard open; retry a few times.
    let mut transferred = false;
    for _ in 0..5 {
        let opened = unsafe { OpenClipboard(std::ptr::null_mut()) };
        if opened == 0 {
            thread::sleep(Duration::from_millis(2));
            continue;
        }
        unsafe {
            // EmptyClipboard immediately followed by SetClipboardData is the
            // documented Win32 pattern for replacing contents. The window
            // between these calls is the unavoidable race described above.
            if EmptyClipboard() != 0
                && !SetClipboardData(CF_UNICODETEXT, hmem).is_null()
            {
                // Ownership of hmem transferred to the OS; do NOT free.
                transferred = true;
            }
            let _ = CloseClipboard();
        }
        break;
    }

    if !transferred {
        unsafe {
            let _ = GlobalFree(hmem);
        }
    }
}

#[cfg(not(windows))]
pub fn copy_to_system_clipboard(_text: &str) {}

/// Read text from the Windows system clipboard.
///
/// Returns `None` if the clipboard cannot be opened, has no
/// `CF_UNICODETEXT` data, or the data is malformed (no null terminator
/// within the allocation). The scan is bounded by the actual `HGLOBAL`
/// size via `GlobalSize` so a malformed payload cannot trigger an
/// out-of-bounds read.
#[cfg(windows)]
pub fn read_from_system_clipboard() -> Option<String> {
    const CF_UNICODETEXT: u32 = 13;
    for _ in 0..5 {
        let opened = unsafe { OpenClipboard(std::ptr::null_mut()) };
        if opened == 0 {
            thread::sleep(Duration::from_millis(2));
            continue;
        }
        let result = unsafe {
            let hmem = GetClipboardData(CF_UNICODETEXT);
            let ptr = if !hmem.is_null() {
                GlobalLock(hmem) as *const u16
            } else {
                std::ptr::null()
            };

            let text = if !ptr.is_null() {
                // Bound the scan by actual allocation size so unterminated
                // CF_UNICODETEXT from a misbehaving clipboard provider
                // cannot trigger an OOB read. Also cap at 1M u16s as a
                // latency guard against pathologically huge clipboards.
                let alloc_bytes = GlobalSize(hmem) as usize;
                let max_u16s =
                    (alloc_bytes / std::mem::size_of::<u16>()).min(1_000_000);

                // If no terminator is found within the allocation, treat
                // the payload as malformed and fail closed by returning
                // None - better than returning truncated garbage.
                let found = (0..max_u16s).position(|i| *ptr.add(i) == 0).map(|len| {
                    let slice = std::slice::from_raw_parts(ptr, len);
                    // Normalize Windows CRLF to LF - ConPTY expands LF to
                    // CRLF on output, so keeping \r\n would produce
                    // double-spaced text in the pane.
                    String::from_utf16_lossy(slice).replace("\r\n", "\n")
                });
                GlobalUnlock(hmem);
                found
            } else {
                None
            };
            let _ = CloseClipboard();
            text
        };
        return result;
    }
    None
}

#[cfg(not(windows))]
pub fn read_from_system_clipboard() -> Option<String> { None }

/// The system clipboard's change counter.
///
/// `GetClipboardSequenceNumber` is a read of one shared value: it does not open
/// the clipboard, cannot fail and cannot block behind another process that is
/// holding it.  That is what makes it usable from the client's input loop,
/// where an `OpenClipboard` per keystroke would not be: the head of the
/// clipboard can be cached and only re-read when this number moves.
#[cfg(windows)]
pub fn clipboard_sequence_number() -> u32 {
    unsafe { windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber() }
}

#[cfg(not(windows))]
pub fn clipboard_sequence_number() -> u32 { 0 }
