//! Attach does not own the child. Closing this client only closes its stream.
use std::io::{self, IsTerminal, Read, Write};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};

use crate::capability::process::client::ProcessHostClient;
use crate::capability::rpc::codec;
use crate::transport::endpoint::channel::LocalIpcStream;

const IO_TIMEOUT: Duration = Duration::from_secs(5);
const DETACH: u8 = 0x1d;
const CHORD_TIMEOUT: Duration = Duration::from_millis(300);
const POLL_SLICE: Duration = Duration::from_millis(50);
const OBSERVE_HINT_COOLDOWN: Duration = Duration::from_secs(2);
const MAX_GAP_RECONNECTS: u32 = 5;
const GAP_WINDOW: Duration = Duration::from_secs(2);

struct TerminalMode;

impl TerminalMode {
    fn enter() -> Result<Self, String> {
        crossterm::terminal::enable_raw_mode().map_err(|error| error.to_string())?;
        let guard = Self;
        #[cfg(windows)]
        platform::enable_vt_input()?;
        Ok(guard)
    }
}

impl Drop for TerminalMode {
    fn drop(&mut self) {
        let mut stdout = io::stdout();
        let _ = stdout.write_all(
            b"\x1b]0;\x07\x1b[0m\x1b[?25h\x1b[?1l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?1049l",
        );
        let _ = stdout.flush();
        let _ = crossterm::terminal::disable_raw_mode();
    }
}

enum InputEvent {
    Bytes(Vec<u8>),
    Eof,
    Error(String),
}

enum StreamEvent {
    Output(Value),
    Error { code: String, message: String },
    Eof,
}

enum LoopAction {
    Continue,
    Detach,
    ToggleTakeover,
}

struct ActiveSubscription {
    controller: Option<String>,
    pty_size: (u16, u16),
    events: Receiver<StreamEvent>,
    closer: LocalIpcStream,
}

impl ActiveSubscription {
    fn open(
        client: &ProcessHostClient,
        id: &str,
        label: &str,
        takeover: bool,
        local_size: (u16, u16),
    ) -> Result<Self, String> {
        let mut stream = client.subscribe(id, takeover)?;
        let closer = stream
            .try_clone()
            .map_err(|error| format!("failed to clone terminal stream: {error}"))?;
        let first = codec::read_response(&mut stream)?
            .ok_or("terminal subscription closed before handshake")?;
        if !first.ok {
            return Err(first.error.map_or_else(
                || "terminal subscription failed".into(),
                |error| format!("{}: {}", error.code, error.message),
            ));
        }
        let first = first
            .result
            .ok_or("missing terminal subscription handshake")?;
        let controller = first["controller"].as_str().map(str::to_owned);
        let screen = &first["screen"];
        let mut pty_size = (
            screen["cols"].as_u64().unwrap_or(120) as u16,
            screen["rows"].as_u64().unwrap_or(36) as u16,
        );
        let restore = screen["restore"]
            .as_str()
            .ok_or("missing terminal restore state")?;
        let mut stdout = io::stdout();
        stdout.write_all(restore.as_bytes()).map_err(io_error)?;
        if let Some(ctrl) = controller.as_deref() {
            resize(client, id, local_size, ctrl)?;
            pty_size = local_size;
        }
        write_status_title(&mut stdout, label, controller.is_some(), pty_size, None)?;
        stdout.flush().map_err(io_error)?;

        let (tx, events) = mpsc::sync_channel(32);
        std::thread::spawn(move || {
            loop {
                match codec::read_response(&mut stream) {
                    Ok(Some(response)) => {
                        let event = if response.ok {
                            match response.result {
                                Some(value) => StreamEvent::Output(value),
                                None => StreamEvent::Error {
                                    code: "process.internal".into(),
                                    message: "empty Process Host response".into(),
                                },
                            }
                        } else {
                            match response.error {
                                Some(error) => StreamEvent::Error {
                                    code: error.code,
                                    message: error.message,
                                },
                                None => StreamEvent::Error {
                                    code: "process.internal".into(),
                                    message: "Process Host stream rejected".into(),
                                },
                            }
                        };
                        if tx.send(event).is_err() {
                            break;
                        }
                    }
                    Ok(None) => {
                        let _ = tx.send(StreamEvent::Eof);
                        break;
                    }
                    Err(error) => {
                        let _ = tx.send(StreamEvent::Error {
                            code: "process.ioFailed".into(),
                            message: error,
                        });
                        break;
                    }
                }
            }
        });

        Ok(Self {
            controller,
            pty_size,
            events,
            closer,
        })
    }

    fn close(self, client: &ProcessHostClient, id: &str) {
        if let Some(controller) = self.controller.as_deref() {
            let _ = client.call(
                "process.v1.releaseControl",
                json!({"id": id, "controller": controller}),
                IO_TIMEOUT,
            );
        }
        let _ = self.closer.shutdown_both();
    }
}

pub(super) fn run(
    client: ProcessHostClient,
    id: &str,
    label: &str,
    tty: bool,
    takeover: bool,
) -> Result<(), String> {
    if !tty {
        return watch_pipe(client, id);
    }
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        return Err("PTY attach requires an interactive terminal".into());
    }
    let _mode = TerminalMode::enter()?;
    let mut size = crossterm::terminal::size().map_err(io_error)?;
    let mut sub = ActiveSubscription::open(&client, id, label, takeover, size)?;

    // The input thread belongs to this CLI invocation, not the Process Host.
    // It may be blocked in the local console when the child exits. Returning
    // from main closes the CLI process without terminating the shared PTY.
    let (input_tx, input_rx) = mpsc::sync_channel(32);
    std::thread::spawn(move || {
        let mut input = io::stdin().lock();
        let mut buffer = [0u8; 4096];
        loop {
            match input.read(&mut buffer) {
                Ok(0) => {
                    let _ = input_tx.send(InputEvent::Eof);
                    break;
                }
                Ok(n) => {
                    if input_tx.send(InputEvent::Bytes(buffer[..n].to_vec())).is_err() {
                        break;
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => {
                    let _ = input_tx.send(InputEvent::Error(error.to_string()));
                    break;
                }
            }
        }
    });

    let mut pending_escape: Option<Instant> = None;
    let mut last_observe_hint: Option<Instant> = None;
    let mut gap_count: u32 = 0;
    let mut gap_window_start = Instant::now();
    let mut stdout = io::stdout();

    let result = loop {
        // 1. Drain any pending stdin events first for snappy interactive feel.
        let mut action = LoopAction::Continue;
        while let Ok(input_event) = input_rx.try_recv() {
            match input_event {
                InputEvent::Bytes(bytes) => {
                    action = handle_input_bytes(
                        &client,
                        id,
                        label,
                        &bytes,
                        &sub,
                        &mut pending_escape,
                        &mut last_observe_hint,
                        &mut stdout,
                    )?;
                    if !matches!(action, LoopAction::Continue) {
                        break;
                    }
                }
                InputEvent::Eof => {
                    action = LoopAction::Detach;
                    break;
                }
                InputEvent::Error(message) => {
                    sub.close(&client, id);
                    return Err(message);
                }
            }
        }

        match action {
            LoopAction::Detach => break Ok(()),
            LoopAction::ToggleTakeover => {
                let want_takeover = sub.controller.is_none();
                sub.close(&client, id);
                match ActiveSubscription::open(&client, id, label, want_takeover, size) {
                    Ok(next) => {
                        sub = next;
                        continue;
                    }
                    Err(error) if want_takeover => {
                        // Another participant holds control; fall back cleanly to observe mode.
                        sub = ActiveSubscription::open(&client, id, label, false, size)?;
                        let _ = stdout.write_all(b"\x07");
                        let _ = write_status_title(
                            &mut stdout,
                            label,
                            false,
                            sub.pty_size,
                            Some("takeover busy"),
                        );
                        let _ = stdout.flush();
                        let _ = error;
                        continue;
                    }
                    Err(error) => return Err(error),
                }
            }
            LoopAction::Continue => {}
        }

        if let Some(since) = pending_escape
            && since.elapsed() >= CHORD_TIMEOUT
        {
            break Ok(());
        }

        // 2. Poll stream output with a short timeout so resize & chord timeout stay responsive.
        match sub.events.recv_timeout(POLL_SLICE) {
            Ok(StreamEvent::Output(value)) => {
                for frame in value["frames"]
                    .as_array()
                    .ok_or("missing raw terminal frames")?
                {
                    let data = STANDARD
                        .decode(
                            frame["dataBase64"]
                                .as_str()
                                .ok_or("missing terminal bytes")?,
                        )
                        .map_err(|error| error.to_string())?;
                    stdout.write_all(&data).map_err(io_error)?;
                }
                stdout.flush().map_err(io_error)?;
            }
            Ok(StreamEvent::Error { code, message }) if code == "stream.gap" => {
                if gap_window_start.elapsed() > GAP_WINDOW {
                    gap_window_start = Instant::now();
                    gap_count = 0;
                }
                gap_count += 1;
                if gap_count > MAX_GAP_RECONNECTS {
                    sub.close(&client, id);
                    return Err(format!("{code}: {message}"));
                }
                let was_takeover = sub.controller.is_some();
                sub.close(&client, id);
                sub = ActiveSubscription::open(&client, id, label, was_takeover, size)?;
            }
            Ok(StreamEvent::Error { code, message }) => {
                sub.close(&client, id);
                return Err(format!("{code}: {message}"));
            }
            Ok(StreamEvent::Eof) => break Ok(()),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                sub.close(&client, id);
                return Err("Process Host stream disconnected".into());
            }
        }

        let current = crossterm::terminal::size().map_err(io_error)?;
        if size != current {
            if let Some(controller) = sub.controller.as_deref() {
                resize(&client, id, current, controller)?;
                sub.pty_size = current;
            }
            size = current;
        }
    };

    sub.close(&client, id);
    result
}

#[allow(clippy::too_many_arguments)]
fn handle_input_bytes(
    client: &ProcessHostClient,
    id: &str,
    label: &str,
    bytes: &[u8],
    sub: &ActiveSubscription,
    pending_escape: &mut Option<Instant>,
    last_observe_hint: &mut Option<Instant>,
    stdout: &mut io::Stdout,
) -> Result<LoopAction, String> {
    let mut forward = Vec::new();
    let flush_forward = |buf: &mut Vec<u8>| -> Result<(), String> {
        if buf.is_empty() {
            return Ok(());
        }
        if let Some(controller) = sub.controller.as_deref() {
            client.call(
                "process.v1.input",
                json!({
                    "id": id,
                    "dataBase64": STANDARD.encode(&*buf),
                    "controller": controller
                }),
                IO_TIMEOUT,
            )?;
        }
        buf.clear();
        Ok(())
    };

    for &byte in bytes {
        if pending_escape.is_some() {
            *pending_escape = None;
            match byte {
                b'd' | b'D' | DETACH => {
                    flush_forward(&mut forward)?;
                    return Ok(LoopAction::Detach);
                }
                b't' | b'T' => {
                    flush_forward(&mut forward)?;
                    return Ok(LoopAction::ToggleTakeover);
                }
                b']' => {
                    if sub.controller.is_some() {
                        forward.push(DETACH);
                    }
                }
                _ => {
                    let _ = write_status_title(
                        stdout,
                        label,
                        sub.controller.is_some(),
                        sub.pty_size,
                        Some("Ctrl+] d: detach · t: toggle control · ]: send ^]"),
                    );
                    let _ = stdout.flush();
                }
            }
            continue;
        }

        if byte == DETACH {
            flush_forward(&mut forward)?;
            *pending_escape = Some(Instant::now());
            continue;
        }

        if sub.controller.is_some() {
            forward.push(byte);
        } else if last_observe_hint.is_none_or(|t| t.elapsed() >= OBSERVE_HINT_COOLDOWN) {
            *last_observe_hint = Some(Instant::now());
            let _ = stdout.write_all(b"\x07");
            let _ = write_status_title(
                stdout,
                label,
                false,
                sub.pty_size,
                Some("read-only · press Ctrl+] t to take control"),
            );
            let _ = stdout.flush();
        }
    }

    flush_forward(&mut forward)?;
    Ok(LoopAction::Continue)
}

fn write_status_title(
    stdout: &mut io::Stdout,
    label: &str,
    controlling: bool,
    (cols, rows): (u16, u16),
    note: Option<&str>,
) -> Result<(), String> {
    let title = match (controlling, note) {
        (true, Some(note)) => format!("[CONTROL] {label} · {note}"),
        (true, None) => format!("[CONTROL] {label} · Ctrl+] t: release · Ctrl+] d: detach"),
        (false, Some(note)) => format!("[OBSERVE] {label} ({cols}x{rows}) · {note}"),
        (false, None) => {
            format!("[OBSERVE] {label} ({cols}x{rows}) · Ctrl+] t: takeover · Ctrl+] d: detach")
        }
    };
    write!(stdout, "\x1b]0;{title}\x07").map_err(io_error)
}

fn resize(
    client: &ProcessHostClient,
    id: &str,
    (cols, rows): (u16, u16),
    controller: &str,
) -> Result<(), String> {
    client.call(
        "process.v1.resize",
        json!({"id": id, "cols": cols, "rows": rows, "controller": controller}),
        IO_TIMEOUT,
    )?;
    Ok(())
}

fn watch_pipe(client: ProcessHostClient, id: &str) -> Result<(), String> {
    let mut seq = 0;
    loop {
        let page = client.call(
            "process.v1.read",
            json!({"id": id, "fromSeq": seq, "waitMs": 1000}),
            IO_TIMEOUT,
        )?;
        if page["gap"] == true {
            eprintln!("Earlier output is no longer retained.");
        }
        for frame in page["frames"].as_array().ok_or("invalid output page")? {
            let bytes = STANDARD
                .decode(frame["dataBase64"].as_str().ok_or("missing output bytes")?)
                .map_err(|error| error.to_string())?;
            if frame["channel"] == "stderr" {
                io::stderr().write_all(&bytes).map_err(io_error)?;
                io::stderr().flush().map_err(io_error)?;
            } else {
                io::stdout().write_all(&bytes).map_err(io_error)?;
                io::stdout().flush().map_err(io_error)?;
            }
            seq = frame["seq"].as_u64().ok_or("missing output sequence")?;
        }
        if page["process"]["state"] != "running" && seq >= page["latestSeq"].as_u64().unwrap_or(seq)
        {
            return Ok(());
        }
    }
}

fn io_error(error: io::Error) -> String {
    error.to_string()
}

#[cfg(windows)]
mod platform {
    use windows_sys::Win32::System::Console::{
        ENABLE_VIRTUAL_TERMINAL_INPUT, GetConsoleMode, GetStdHandle, STD_INPUT_HANDLE,
        SetConsoleMode,
    };
    pub fn enable_vt_input() -> Result<(), String> {
        unsafe {
            let handle = GetStdHandle(STD_INPUT_HANDLE);
            let mut mode = 0;
            if GetConsoleMode(handle, &mut mode) == 0
                || SetConsoleMode(handle, mode | ENABLE_VIRTUAL_TERMINAL_INPUT) == 0
            {
                return Err(std::io::Error::last_os_error().to_string());
            }
        }
        Ok(())
    }
}
