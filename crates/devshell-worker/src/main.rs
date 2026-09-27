mod capability;
mod cli;
mod daemon;
mod host;
mod instance;
#[cfg(test)]
mod testing;
mod tool;
mod transport;

use instance::InstanceName;

#[cfg(windows)]
const INTERNAL_PSMUX_ENV: &str = "DEVSHELL_WORKER_INTERNAL_PSMUX";

fn main() {
    #[cfg(windows)]
    if std::env::var_os(INTERNAL_PSMUX_ENV).is_some() {
        if let Err(error) = psmux::run() {
            eprintln!("psmux: {error}");
            std::process::exit(1);
        }
        return;
    }

    if let Some(result) = capability::rpc::command::client::try_run_shim() {
        match result {
            Ok(code) => std::process::exit(code),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
    }
    match run() {
        Ok(output) => {
            if !output.is_empty() {
                println!("{output}");
            }
        }
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}

fn run() -> Result<String, String> {
    #[cfg(any(unix, windows))]
    if let Some(result) = tool::tmux::transcript::try_run_transcript_logger() {
        result?;
        return Ok(String::new());
    }

    if let Some(raw_instance) = std::env::var_os(daemon::process::INTERNAL_INSTANCE_ENV) {
        let raw_instance = raw_instance
            .into_string()
            .map_err(|_| "internal daemon instance name is not valid utf-8".to_string())?;
        let instance = InstanceName::parse(&raw_instance)?;
        if let Err(error) = daemon::server::serve(instance.clone()) {
            if let Ok(paths) = instance::storage::InstancePaths::resolve(&instance) {
                let _ = daemon::log::append_log(&paths, &format!("daemon failed: {error}"));
            }
            return Err(error);
        }
        return Ok(String::new());
    }

    cli::run()
}
