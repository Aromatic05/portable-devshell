//! Instance-local process ownership and IPC server.
mod dispatch;
pub(super) mod launcher;
mod registry;
mod server;

pub(crate) use server::{endpoint, serve};

use super::output::CaptureBudget;
use super::protocol::Handshake;
use super::shell::ShellRuntime;
use crate::capability::execution::ExecutionConfig;
use crate::instance::sandbox::SecurityPolicy;
use registry::Registry;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

struct Host {
    registry: Mutex<Registry>,
    shell: ShellRuntime,
    execution: Option<ExecutionConfig>,
    policy: Arc<dyn SecurityPolicy>,
    instance_root: PathBuf,
    stopped: AtomicBool,
    handshake: Handshake,
    capture_root: PathBuf,
    capture_budget: Arc<CaptureBudget>,
}
