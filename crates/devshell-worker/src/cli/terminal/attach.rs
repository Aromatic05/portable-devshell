//! Attach does not own the child. Closing this client only closes its stream.
use std::io::{self, IsTerminal, Read, Write};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::Duration;

use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};

use crate::capability::process::client::ProcessHostClient;
use crate::capability::rpc::codec;

const IO_TIMEOUT: Duration = Duration::from_secs(5);
const DETACH: u8 = 0x1d;

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
        let _ = stdout.write_all(b"\x1b[0m\x1b[?25h\x1b[?1l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?1049l");
        let _ = stdout.flush();
        let _ = crossterm::terminal::disable_raw_mode();
    }
}

enum Event {
    Input(Vec<u8>),
    Output(Result<Value, String>),
    Eof,
}

pub(super) fn run(
    client: ProcessHostClient,
    id: &str,
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
    let mut stream = client.subscribe(id, takeover)?;
    let first = codec::read_response(&mut stream)?
        .ok_or("terminal subscription closed before handshake")?;
    if !first.ok {
        return Err(first.error.map_or_else(
            || "terminal subscription failed".into(),
            |error| error.message,
        ));
    }
    let first = first
        .result
        .ok_or("missing terminal subscription handshake")?;
    let controller = first["controller"].as_str().map(str::to_owned);
    let _lease = ClientLease {
        client: &client,
        id,
        controller: controller.as_deref(),
    };
    let restore = first["screen"]["restore"]
        .as_str()
        .ok_or("missing terminal restore state")?;
    io::stdout()
        .write_all(restore.as_bytes())
        .map_err(io_error)?;
    io::stdout().flush().map_err(io_error)?;
    if let Some(controller) = controller.as_deref() {
        resize(&client, id, size, controller)?;
    }
    let (sender, events) = mpsc::sync_channel(32);
    let output_sender = sender.clone();
    std::thread::spawn(move || {
        loop {
            match codec::read_response(&mut stream) {
                Ok(Some(response)) => {
                    let result = if response.ok {
                        response
                            .result
                            .ok_or_else(|| "empty Process Host response".into())
                    } else {
                        Err(response.error.map_or_else(
                            || "Process Host stream rejected".into(),
                            |error| format!("{}: {}", error.code, error.message),
                        ))
                    };
                    if output_sender.send(Event::Output(result)).is_err() {
                        break;
                    }
                }
                Ok(None) => {
                    let _ = output_sender.send(Event::Eof);
                    break;
                }
                Err(error) => {
                    let _ = output_sender.send(Event::Output(Err(error)));
                    break;
                }
            }
        }
    });
    // The input thread belongs to this CLI invocation, not the Process Host.
    // It may be blocked in the local console when the child exits. Returning
    // from main closes the CLI process without terminating the shared PTY.
    std::thread::spawn(move || {
        let mut input = io::stdin().lock();
        let mut buffer = [0u8; 4096];
        loop {
            match input.read(&mut buffer) {
                Ok(0) => {
                    let _ = sender.send(Event::Eof);
                    break;
                }
                Ok(n) => {
                    if sender.send(Event::Input(buffer[..n].to_vec())).is_err() {
                        break;
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => {
                    let _ = sender.send(Event::Output(Err(error.to_string())));
                    break;
                }
            }
        }
    });
    attach_loop(&client, id, &events, &mut size, controller.as_deref())
}

fn attach_loop(
    client: &ProcessHostClient,
    id: &str,
    events: &Receiver<Event>,
    size: &mut (u16, u16),
    controller: Option<&str>,
) -> Result<(), String> {
    let mut stdout = io::stdout();
    loop {
        match events.recv_timeout(Duration::from_millis(100)) {
            Ok(Event::Input(bytes)) => {
                let detach = bytes.iter().position(|byte| *byte == DETACH);
                let bytes = &bytes[..detach.unwrap_or(bytes.len())];
                if !bytes.is_empty() && controller.is_some() {
                    client.call(
                        "process.v1.input",
                        json!({"id": id, "dataBase64": STANDARD.encode(bytes), "controller": controller}),
                        IO_TIMEOUT,
                    )?;
                }
                if detach.is_some() {
                    return Ok(());
                }
            }
            Ok(Event::Output(value)) => {
                let value = value?;
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
            Ok(Event::Eof) => return Ok(()),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                return Err("Process Host stream disconnected".into());
            }
        }
        let current = crossterm::terminal::size().map_err(io_error)?;
        if *size != current {
            if let Some(controller) = controller {
                resize(client, id, current, controller)?;
            }
            *size = current;
        }
    }
}

struct ClientLease<'a> {
    client: &'a ProcessHostClient,
    id: &'a str,
    controller: Option<&'a str>,
}

impl Drop for ClientLease<'_> {
    fn drop(&mut self) {
        if let Some(controller) = self.controller {
            let _ = self.client.call(
                "process.v1.releaseControl",
                json!({"id": self.id, "controller": controller}),
                IO_TIMEOUT,
            );
        }
    }
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
