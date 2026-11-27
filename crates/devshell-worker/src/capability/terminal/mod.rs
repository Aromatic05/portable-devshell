//! Worker-side remote terminal adapter. All PTYs belong to Process Host.
mod adapter;
mod bridge;
mod model;
mod path;

pub use adapter::TerminalManager;
pub use model::*;
