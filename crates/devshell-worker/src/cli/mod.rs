pub mod enroll;
pub mod instance;

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
    Transport(InstanceArgs),
    Retire(InstanceArgs),
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
    #[arg(long)]
    pub proxy: Option<String>,
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
        Command::Start(args) => instance::lifecycle::start::run(args),
        Command::Stop(args) => instance::lifecycle::stop::run(args),
        Command::Status(args) => instance::observe::status::run(args),
        Command::Logs(args) => instance::observe::logs::run(args),
        Command::Transport(args) => crate::transport::run(&args.instance),
        Command::Retire(args) => instance::maintain::retire::run(args),
        Command::Gc(args) => instance::maintain::gc::run(args),
    }
}

#[cfg(test)]
mod tests {
    use clap::Parser;

    use super::{Cli, Command};

    #[test]
    fn enroll_accepts_an_explicit_reverse_proxy() {
        let cli = Cli::try_parse_from([
            "devshell-worker",
            "enroll",
            "--controller",
            "https://controller.example",
            "--device-code",
            "device-code",
            "--proxy",
            "socks5h://127.0.0.1:1080",
        ])
        .unwrap();
        let Command::Enroll(args) = cli.command else {
            panic!("expected enroll command");
        };
        assert_eq!(args.proxy.as_deref(), Some("socks5h://127.0.0.1:1080"));
    }
}
