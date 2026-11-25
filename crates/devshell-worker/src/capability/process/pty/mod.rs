#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

#[cfg(unix)]
pub(crate) use unix::spawn as spawn_terminal;
#[cfg(unix)]
pub(super) use unix::spawn_managed;
#[cfg(windows)]
pub(crate) use windows::spawn as spawn_terminal;
#[cfg(windows)]
pub(super) use windows::spawn_managed;

pub(crate) trait TerminalChild {
    fn kill(&self) -> Result<(), String>;
    fn resize(&self, cols: u16, rows: u16) -> Result<(), String>;
    fn wait(&self) -> Result<(i32, i32), String>;
}

pub(crate) struct SpawnedTerminal {
    pub child: Box<dyn TerminalChild + Send + Sync>,
    pub reader: Box<dyn std::io::Read + Send>,
    pub writer: Box<dyn std::io::Write + Send>,
}
