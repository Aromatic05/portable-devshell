mod cli;
mod daemon;
mod instance;
mod platform;
mod reverse;
mod rpc;
mod security;
mod socket;
mod storage;
mod tools;

use instance::InstanceName;

fn main() {
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
    if let Some(raw_instance) = std::env::var_os(daemon::process::INTERNAL_INSTANCE_ENV) {
        let raw_instance = raw_instance
            .into_string()
            .map_err(|_| "internal daemon instance name is not valid utf-8".to_string())?;
        let instance = InstanceName::parse(&raw_instance)?;
        if let Err(error) = daemon::server::serve(instance.clone()) {
            if let Ok(paths) = storage::InstancePaths::resolve(&instance) {
                let _ = daemon::log_writer::append_log(&paths, &format!("daemon failed: {error}"));
            }
            return Err(error);
        }
        return Ok(String::new());
    }

    cli::run()
}
