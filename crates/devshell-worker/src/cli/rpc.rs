use crate::cli::InstanceArgs;
use crate::daemon::process;
use crate::instance::InstanceName;
use crate::rpc::bridge::run_bridge;
use crate::socket::SocketPaths;

pub fn run(args: InstanceArgs) -> Result<String, String> {
    let instance = InstanceName::parse(&args.instance)?;
    let socket_paths = SocketPaths::resolve(&instance)?;

    if !process::daemon_is_responsive(&socket_paths) {
        return Err(format!("worker instance `{instance}` is not running"));
    }

    run_bridge(&socket_paths.socket_file)
}
