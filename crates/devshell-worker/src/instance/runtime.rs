use super::InstanceName;
use super::sandbox::SecurityMode;

pub const INTERNAL_INSTANCE_ENV: &str = "DEVSHELL_WORKER_INTERNAL_INSTANCE";
pub const INTERNAL_SECURITY_MODE_ENV: &str = "DEVSHELL_WORKER_INTERNAL_SECURITY_MODE";
/// Worker runtime facts shared with execution tools and the daemon.
#[derive(Clone, Debug)]
pub struct PlatformInfo {
    pub os: &'static str,
    pub arch: &'static str,
}

#[derive(Clone, Debug)]
pub struct WorkerRuntimeContext {
    pub instance: InstanceName,
    pub platform: PlatformInfo,
    pub security_mode: SecurityMode,
    pub worker_sha256: Option<String>,
}
