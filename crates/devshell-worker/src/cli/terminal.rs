use clap::{Args, Subcommand};
use serde_json::json;

use crate::capability::process::client::ProcessHostClient;
use crate::instance::InstanceName;
use crate::instance::storage::InstancePaths;
use crate::transport::endpoint::channel::EndpointPaths;

#[derive(Args, Debug)]
pub struct TerminalArgs {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// List resources held by the instance's Process Host.
    List {
        #[arg(long)]
        instance: String,
    },
}

pub fn run(args: TerminalArgs) -> Result<String, String> {
    match args.command {
        Command::List { instance } => {
            let instance = InstanceName::parse(&instance)?;
            let paths = InstancePaths::resolve(&instance)?;
            let endpoints = EndpointPaths::resolve(&instance)?;
            let resources = match ProcessHostClient::connect(&instance, &paths, &endpoints)? {
                Some(client) => client.list()?,
                None => json!([]),
            };
            serde_json::to_string_pretty(&resources).map_err(|error| error.to_string())
        }
    }
}
