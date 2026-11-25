use clap::{Args, Subcommand};
use serde_json::Value;

use crate::capability::process::client::ProcessHostClient;

mod attach;

#[derive(Args, Debug)]
pub struct TerminalArgs {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// List all process resources on this machine.
    List,
    /// Attach to a process by its globally unique ID. Ctrl-] detaches.
    Attach { id: String },
}

pub fn run(args: TerminalArgs) -> Result<String, String> {
    let clients = ProcessHostClient::discover()?;
    match args.command {
        Command::List => {
            let mut resources = Vec::new();
            for client in clients {
                for mut resource in list(&client)? {
                    resource["instance"] = Value::String(client.instance().into());
                    resources.push(resource);
                }
            }
            serde_json::to_string_pretty(&resources).map_err(|error| error.to_string())
        }
        Command::Attach { id } => {
            for client in clients {
                if let Some(resource) = list(&client)?
                    .into_iter()
                    .find(|resource| resource["id"] == id)
                {
                    attach::run(client, &id, resource["tty"] == true)?;
                    return Ok(String::new());
                }
            }
            Err(format!("unknown process {id}"))
        }
    }
}

fn list(client: &ProcessHostClient) -> Result<Vec<Value>, String> {
    serde_json::from_value(client.list()?).map_err(|error| error.to_string())
}
