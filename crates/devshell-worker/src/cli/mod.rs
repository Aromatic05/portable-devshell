pub mod enroll;
pub mod gc;
pub mod logs;
pub mod rpc;
pub mod start;
pub mod status;
pub mod stop;

use clap::{Args, Parser, Subcommand};

#[derive(Parser, Debug)]
#[command(name = "devshell-worker", version = env!("CARGO_PKG_VERSION"))]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    Enroll(EnrollArgs),
    Start(InstanceArgs),
    Stop(InstanceArgs),
    Status(InstanceArgs),
    Logs(InstanceArgs),
    Rpc(InstanceArgs),
    Gc(GcArgs),
}

#[derive(Args, Debug)]
pub struct InstanceArgs {
    #[arg(long)]
    pub instance: String,
}

#[derive(Args, Debug)]
pub struct EnrollArgs {
    #[arg(long)]
    pub controller: String,
    #[arg(long)]
    pub device_code: String,
}

#[derive(Args, Debug)]
pub struct GcArgs {
    #[arg(long, default_value_t = false)]
    pub dry_run: bool,
}

pub fn run() -> Result<String, String> {
    let cli = Cli::parse();
    match cli.command {
        Command::Enroll(args) => enroll::run(args),
        Command::Start(args) => start::run(args),
        Command::Stop(args) => stop::run(args),
        Command::Status(args) => status::run(args),
        Command::Logs(args) => logs::run(args),
        Command::Rpc(args) => rpc::run(args),
        Command::Gc(args) => gc::run(args),
    }
}
